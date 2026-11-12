/**
 * Replay trading engine — DETERMINISTIC historical market simulator.
 *
 * Every state transition is a pure function of (state, bar, config, action).
 * No Date.now(), no randomness, no external effects: the same history +
 * starting conditions + user actions always produce identical results.
 *
 * Execution model (documented, conservative — never pretends intrabar
 * sequence is known):
 *  - Quotes are BID; ask = bid + spread (fixed, user-configured).
 *  - Market orders fill at the CURRENT bar's close ± slippage (against the
 *    trader) + spread on the ask side.
 *  - Buy limit fills at min(limit, bar.open) when bar.low <= limit (gap →
 *    better price at open); sell limit symmetric.
 *  - Buy stop fills at max(stop, bar.open) + slippage when bar.high >= stop
 *    (gap → worse price at open); sell stop symmetric.
 *  - SL/TP are checked on each revealed bar: if BOTH are touched inside one
 *    candle the STOP fills first (conservative assumption, labeled in the
 *    trade record as "sl(conservative)").
 *  - SL fills include slippage; TP is a limit-like fill at the exact level.
 *  - Commission = pct of notional PER SIDE, charged at entry and exit.
 *  - Margin = Σ notional / leverage; orders are rejected when free margin is
 *    insufficient. P/L converts to account USD at the exit rate when the
 *    instrument is quoted in another currency (reference model, same as the
 *    backtester).
 */
import type { Bar } from "@shared/terminal";
import { getInstrument } from "@shared/terminal";

// ---- types ------------------------------------------------------------------

export interface ReplayAccountConfig {
  startingBalance: number;
  currency: string;          // account display currency (USD reference model)
  leverage: number;          // 1..500
  spreadPips: number;        // fixed simulated spread
  commissionPct: number;     // % of notional per side
  slippagePips: number;      // market + SL orders
}

export const DEFAULT_ACCOUNT: ReplayAccountConfig = {
  startingBalance: 10000, currency: "USD", leverage: 100,
  spreadPips: 2, commissionPct: 0.02, slippagePips: 0.5,
};

export interface ReplayPosition {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;              // CURRENT open lots (reduced by partial closes)
  initialLots: number;
  entry: number;             // fill price incl. spread/slippage
  entryTime: number;
  sl: number | null;
  tp: number | null;
  plannedRisk?: number;      // USD risk at entry (when SL set)
  rrAtEntry?: number | null; // planned R:R at entry (when SL+TP set)
}

export interface ReplayOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "stop";
  lots: number;
  price: number;
  sl: number | null;
  tp: number | null;
  placedAtTime: number;
}

export interface ReplayClosedTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  pnl: number;               // net USD (after commission)
  fees: number;
  pips: number;
  reason: "sl" | "tp" | "manual" | "pending-sl" | "pending-tp";
  slConservative?: boolean;  // both SL+TP touched in one candle → SL assumed
  rrAtEntry?: number | null;
  journalId?: string;
}

export interface ReplayState {
  balance: number;           // realized
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  closed: ReplayClosedTrade[];
  seq: number;               // deterministic id counter
}

export const EMPTY_STATE = (startingBalance = 10000): ReplayState =>
  ({ balance: startingBalance, positions: [], orders: [], closed: [], seq: 1 });

// ---- helpers ----------------------------------------------------------------

const inst = (symbol: string) => getInstrument(symbol);
export const pipSize = (symbol: string) => inst(symbol)?.pipSize ?? 0.0001;
export const contractOf = (symbol: string) => inst(symbol)?.contractSize ?? 1;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export const askOf = (bid: number, cfg: ReplayAccountConfig, symbol: string) => bid + cfg.spreadPips * pipSize(symbol);

/** Quote-currency → USD factor at price p (USDJPY-style pairs: JPY/price). */
export function quoteToUsd(symbol: string, p: number): number {
  const i = inst(symbol);
  if (!i || i.quote === "USD") return 1;
  return symbol.startsWith("USD") && p > 0 ? 1 / p : 1;
}

/** P/L in USD for closing `lots` of a position at `closeBid` (market bid). */
export function pnlOf(pos: ReplayPosition, lots: number, closeBid: number, cfg: ReplayAccountConfig): number {
  const exit = pos.side === "buy" ? closeBid : closeBid + cfg.spreadPips * pipSize(pos.symbol); // sell closes at ask
  const diff = pos.side === "buy" ? exit - pos.entry : pos.entry - exit;
  const usd = diff * lots * contractOf(pos.symbol) * quoteToUsd(pos.symbol, pos.entry);
  return usd;
}

/** Floating P/L (USD) across open positions given per-symbol bid prices. */
export function floatingOf(state: ReplayState, cfg: ReplayAccountConfig, priceOf: (symbol: string) => number | undefined): number {
  let f = 0;
  for (const p of state.positions) {
    const bid = priceOf(p.symbol);
    if (bid != null) f += pnlOf(p, p.lots, bid, cfg);
  }
  return f;
}

/** Equity at market bid prices for the position symbols. */
export function equityOf(state: ReplayState, priceOf: (symbol: string) => number | undefined, cfg: ReplayAccountConfig): number {
  return state.balance + floatingOf(state, cfg, priceOf);
}

/** Used margin (USD) at reference prices. */
export function usedMarginOf(state: ReplayState, priceOf: (symbol: string) => number | undefined, cfg: ReplayAccountConfig): number {
  let used = 0;
  for (const p of state.positions) {
    const bid = priceOf(p.symbol);
    if (bid != null) used += (p.entry * p.lots * contractOf(p.symbol) * quoteToUsd(p.symbol, p.entry)) / Math.max(1, cfg.leverage);
  }
  return used;
}

export const idOf = (state: ReplayState) => `t${state.seq++}`;

// ---- orders -----------------------------------------------------------------

export interface OpenRequest {
  symbol: string; side: "buy" | "sell"; lots: number;
  sl?: number | null; tp?: number | null;
}

export interface EngineResult { state: ReplayState; error?: string; event?: string }

/**
 * Market order at the current bar close (the replay cursor bar — a CLOSED
 * candle; there is no future data beyond it in scope).
 */
export function openMarket(state: ReplayState, cfg: ReplayAccountConfig, bar: Bar, req: OpenRequest): EngineResult {
  const i = inst(req.symbol);
  if (!i) return { state, error: "Unknown instrument" };
  if (!(req.lots >= 0.01)) return { state, error: "Minimum 0.01 lots" };
  const slip = cfg.slippagePips * pipSize(req.symbol);
  const raw = bar.close;
  let entry: number;
  if (req.side === "buy") entry = askOf(raw, cfg, req.symbol) + slip;
  else entry = raw - slip;                                  // sell fills at bid − slippage
  const notional = entry * req.lots * contractOf(req.symbol) * quoteToUsd(req.symbol, entry);
  const marginNeeded = notional / Math.max(1, cfg.leverage);
  const priceOf = (s: string) => (s === req.symbol ? raw : undefined);
  const free = state.balance + floatingOf(state, cfg, priceOf) - usedMarginOf(state, priceOf, cfg);
  if (marginNeeded > free) return { state, error: `Insufficient margin (need ${marginNeeded.toFixed(2)}, free ${free.toFixed(2)})` };
  if (req.sl != null && ((req.side === "buy" && req.sl >= entry) || (req.side === "sell" && req.sl <= entry)))
    return { state, error: "SL must be on the losing side of entry" };
  if (req.tp != null && ((req.side === "buy" && req.tp <= entry) || (req.side === "sell" && req.tp >= entry)))
    return { state, error: "TP must be on the winning side of entry" };
  const fee = (notional * cfg.commissionPct) / 100;
  const plannedRisk = req.sl != null ? Math.abs(entry - req.sl) * req.lots * contractOf(req.symbol) * quoteToUsd(req.symbol, entry) : undefined;
  const rr = req.sl != null && req.tp != null ? Math.round((Math.abs(req.tp - entry) / Math.abs(entry - req.sl)) * 100) / 100 : null;
  const pos: ReplayPosition = {
    id: idOf(state), symbol: req.symbol, side: req.side, lots: r2(req.lots), initialLots: r2(req.lots),
    entry: r5(entry), entryTime: bar.time,
    sl: req.sl ?? null, tp: req.tp ?? null,
    plannedRisk: plannedRisk != null ? r2(plannedRisk) : undefined, rrAtEntry: rr,
  };
  return {
    state: { ...state, balance: r2(state.balance - fee), positions: [...state.positions, pos] },
    event: `OPEN ${req.side} ${req.lots} ${req.symbol} @ ${r5(entry)}`,
  };
}

/** Place a pending limit/stop order (no margin lock; checked at fill). */
export function placePending(state: ReplayState, bar: Bar, req: OpenRequest & { type: "limit" | "stop"; price: number }): EngineResult {
  if (!(req.lots >= 0.01)) return { state, error: "Minimum 0.01 lots" };
  const ok =
    req.type === "limit"
      ? req.side === "buy" ? req.price < bar.close : req.price > bar.close
      : req.side === "buy" ? req.price > bar.close : req.price < bar.close;
  if (!ok) return { state, error: `${req.type.toUpperCase()} price on the wrong side of market` };
  const order: ReplayOrder = {
    id: idOf(state), symbol: req.symbol, side: req.side, type: req.type,
    lots: r2(req.lots), price: r5(req.price), sl: req.sl ?? null, tp: req.tp ?? null,
    placedAtTime: bar.time,
  };
  return { state: { ...state, orders: [...state.orders, order] }, event: `PENDING ${req.side} ${req.type} ${req.lots} @ ${r5(req.price)}` };
}

export const cancelPending = (state: ReplayState, id: string): ReplayState => ({ ...state, orders: state.orders.filter((o) => o.id !== id) });

export const modifyPending = (state: ReplayState, id: string, patch: Partial<Pick<ReplayOrder, "price" | "sl" | "tp" | "lots">>): ReplayState => ({
  ...state,
  orders: state.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)),
});

export const modifyPosition = (state: ReplayState, id: string, patch: Partial<Pick<ReplayPosition, "sl" | "tp">>): ReplayState => ({
  ...state,
  positions: state.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)),
});

/** Manual close (full or partial) at the current bar close. */
export function closePosition(state: ReplayState, cfg: ReplayAccountConfig, bar: Bar, id: string, lotsToClose?: number): EngineResult {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return { state, error: "Position not found" };
  const lots = Math.min(pos.lots, r2(lotsToClose ?? pos.lots));
  if (!(lots >= 0.01)) return { state, error: "Minimum 0.01 lots to close" };
  const raw = bar.close;
  const exit = pos.side === "buy" ? raw : askOf(raw, cfg, pos.symbol) + cfg.slippagePips * pipSize(pos.symbol);
  return settle(state, cfg, pos, lots, exit, bar.time, "manual");
}

/** Core settlement: realize pnl + exit fee, handle partial vs full. */
function settle(state: ReplayState, cfg: ReplayAccountConfig, pos: ReplayPosition, lots: number, exit: number, exitTime: number, reason: ReplayClosedTrade["reason"], slConservative = false): EngineResult {
  const diff = pos.side === "buy" ? exit - pos.entry : pos.entry - exit;
  const pnlGross = diff * lots * contractOf(pos.symbol) * quoteToUsd(pos.symbol, pos.entry);
  const notionalExit = exit * lots * contractOf(pos.symbol) * quoteToUsd(pos.symbol, pos.entry);
  const fee = (notionalExit * cfg.commissionPct) / 100;
  const pnl = r2(pnlGross - fee);
  const pips = Math.round((diff / pipSize(pos.symbol)) * 10) / 10;
  const partial = lots < pos.lots;
  // deterministic id: partial closes get a sequence-derived suffix (no Date.now() — §15)
  const trade: ReplayClosedTrade = {
    id: partial ? `${pos.id}-p${state.seq}` : pos.id,
    symbol: pos.symbol, side: pos.side, lots, entry: pos.entry, exit: r5(exit),
    entryTime: pos.entryTime, exitTime, pnl,
    fees: r2(fee), pips, reason, slConservative: slConservative || undefined,
    rrAtEntry: pos.rrAtEntry ?? null,
  };
  const remaining = r2(pos.lots - lots);
  const positions = remaining >= 0.01
    ? state.positions.map((p) => (p.id === pos.id ? { ...p, lots: remaining } : p))
    : state.positions.filter((p) => p.id !== pos.id);
  return {
    state: { ...state, seq: state.seq + (partial ? 1 : 0), balance: r2(state.balance + pnl), positions, closed: [...state.closed, trade] },
    event: `CLOSE ${pos.side} ${lots} ${pos.symbol} @ ${r5(exit)} → ${pnl >= 0 ? "+" : ""}${pnl}`,
  };
}

// ---- per-bar engine step (fills; called when a NEW bar is revealed) ---------

export interface StepEvents { state: ReplayState; events: string[] }

/**
 * Advance the simulation by one revealed bar: pending fills → SL/TP checks.
 * The bar passed here is the newly revealed (closed) candle. Ordering inside
 * the bar is conservative: SL before TP when both are touched.
 */
export function stepBar(state: ReplayState, cfg: ReplayAccountConfig, bar: Bar & { symbol?: string }): StepEvents {
  const events: string[] = [];
  let st = state;
  const sym = bar.symbol ?? "";

  // 1) pending order triggers
  for (const o of st.orders) {
    if (o.symbol !== sym) continue;
    const slip = cfg.slippagePips * pipSize(o.symbol);
    let fill: number | null = null;
    if (o.type === "limit") {
      if (o.side === "buy" && bar.low <= o.price) fill = Math.min(o.price, bar.open); // gap → better
      if (o.side === "sell" && bar.high >= o.price) fill = Math.max(o.price, bar.open);
    } else {
      if (o.side === "buy" && bar.high >= o.price) fill = Math.max(o.price, bar.open) + slip; // gap → worse
      if (o.side === "sell" && bar.low <= o.price) fill = Math.min(o.price, bar.open) - slip;
    }
    if (fill == null) continue;
    // margin check at fill
    const notional = fill * o.lots * contractOf(o.symbol) * quoteToUsd(o.symbol, fill);
    const marginNeeded = notional / Math.max(1, cfg.leverage);
    const priceOf = (s: string) => (s === bar.symbol ? bar.close : undefined);
    const free = st.balance - usedMarginOf(st, priceOf, cfg);
    if (marginNeeded > free) { events.push(`REJECTED ${o.side} ${o.type} (insufficient margin)`); continue; }
    const entry = o.side === "buy" ? fill + cfg.spreadPips * pipSize(o.symbol) : fill;
    const fee = (entry * o.lots * contractOf(o.symbol) * quoteToUsd(o.symbol, entry) * cfg.commissionPct) / 100;
    const plannedRisk = o.sl != null ? Math.abs(entry - o.sl) * o.lots * contractOf(o.symbol) * quoteToUsd(o.symbol, entry) : undefined;
    const rr = o.sl != null && o.tp != null ? Math.round((Math.abs(o.tp - entry) / Math.abs(entry - o.sl)) * 100) / 100 : null;
    st = {
      ...st,
      balance: r2(st.balance - fee),
      orders: st.orders.filter((x) => x.id !== o.id),
      positions: [...st.positions, {
        id: o.id, symbol: o.symbol, side: o.side, lots: o.lots, initialLots: o.lots,
        entry: r5(entry), entryTime: bar.time, sl: o.sl, tp: o.tp,
        plannedRisk: plannedRisk != null ? r2(plannedRisk) : undefined, rrAtEntry: rr,
      }],
    };
    events.push(`FILLED ${o.side} ${o.type} ${o.lots} @ ${r5(entry)}`);
  }

  // 2) SL / TP checks on open positions (this bar's high/low)
  for (const p of st.positions) {
    if (p.symbol !== sym) continue;
    const hitSL = p.sl != null && (p.side === "buy" ? bar.low <= p.sl : bar.high >= p.sl);
    const hitTP = p.tp != null && (p.side === "buy" ? bar.high >= p.tp : bar.low <= p.tp);
    if (!hitSL && !hitTP) continue;
    if (hitSL) {
      const slip = cfg.slippagePips * pipSize(p.symbol);
      const exit = p.side === "buy" ? p.sl! - slip : p.sl! + slip;
      const res = settle(st, cfg, p, p.lots, exit, bar.time, "sl", hitTP);
      st = res.state; events.push(res.event ?? "SL");
    } else {
      const exit = p.tp!;
      const res = settle(st, cfg, p, p.lots, exit, bar.time, "tp");
      st = res.state; events.push(res.event ?? "TP");
    }
  }

  return { state: st, events };
}

/** Risk-based lot sizing helper used by the order ticket. */
export function lotsForRisk(symbol: string, riskUsd: number, slDistance: number): number {
  if (slDistance <= 0) return 0;
  return Math.floor((riskUsd / (slDistance * contractOf(symbol))) * 100) / 100;
}
