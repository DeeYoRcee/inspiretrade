/**
 * InspireTrade replay & backtest execution core — shared pure logic.
 *
 * ONE bar-driven broker serves BOTH the interactive replay (ReplayPage) and
 * the backtesting engine (BacktestPage) so execution assumptions are
 * guaranteed identical (spread, commission, fill rules) across the platform.
 *
 * Execution rules (consistent with the live server engine):
 *  - BUY opens at ASK, closes at BID. SELL opens at BID, closes at ASK.
 *    (half the configured spread is charged on each side via quoteFromMid)
 *  - Intra-bar price path uses ONLY the bar's real OHLC points, ordered
 *    direction-aware and CONSERVATIVELY: a bullish bar is walked O→L→H→C and
 *    a bearish bar O→H→L→C, so when both SL and TP lie inside one candle the
 *    stop loss is always hit first. No path price is ever invented.
 *  - Pending fills: at the trigger price, or at the bar-open price when the
 *    open gaps through the trigger (standard gap handling).
 *  - Commission: charged once per round trip at close (commissionPerLot × lots).
 *  - P/L math, margin, validation: reused from shared/trading-engine.ts.
 *  - No swap: replay/backtest sessions are short simulations; the live
 *    engine settles overnight swap only.
 *
 * Look-ahead safety: stepReplayBar() consumes exactly ONE bar per call; the
 * caller decides the cursor. No function in this file can see "future" bars.
 */
import { getInstrument, type Bar, type InstrumentSpec } from "./terminal.ts";
import {
  quoteFromMid,
  positionPnlUsd,
  exitPriceFor,
  checkExitTrigger,
  checkPendingTrigger,
  marginUsdFor,
  MIN_LOTS,
  MAX_LOTS,
  type Quote,
  type Side,
  type OrderKind,
  type PositionLike,
} from "./trading-engine.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayExecConfig {
  /** spread in pips charged per side (default: catalog SPREAD_PIPS) */
  spreadPips?: number;
  /** round-trip commission per 1.0 lot, USD */
  commissionPerLot: number;
  leverage: number;
}

export interface ReplayPosition extends PositionLike {
  commission?: never; // commission is charged at close, not open
}

export interface ReplayOrder {
  id: string;
  symbol: string;
  side: Side;
  kind: Exclude<OrderKind, "market">;
  lots: number;
  price: number;
  sl: number | null;
  tp: number | null;
  placedAt: number;
}

export interface ReplayTrade {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  entry: number;
  exit: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;
  closedAt: number;
  pnl: number;           // USD, net of commission
  commission: number;
  reason: "manual" | "sl" | "tp" | "stop-out";
}

export interface ReplayWallet {
  balance: number;
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  closed: ReplayTrade[];
  seq: number;
}

export interface BarStepResult {
  wallet: ReplayWallet;
  /** pending order ids filled during this bar */
  filledOrderIds: string[];
  /** positions closed during this bar (SL/TP), with the resulting trade */
  closed: { positionId: string; trade: ReplayTrade; reason: "sl" | "tp" }[];
}

// ---------------------------------------------------------------------------
// Wallet + quote helpers
// ---------------------------------------------------------------------------

export function newReplayWallet(startBalance: number): ReplayWallet {
  return { balance: round2(startBalance), positions: [], orders: [], closed: [], seq: 1 };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Two-sided executable quote around a replay/backtest mid price. */
export function replayQuote(spec: InstrumentSpec, mid: number, time: number, cfg: ReplayExecConfig): Quote {
  const q = quoteFromMid(mid, spec, "replay", false, time);
  if (cfg.spreadPips != null) {
    const spread = cfg.spreadPips * spec.pipSize;
    return { ...q, bid: mid - spread / 2, ask: mid + spread / 2 };
  }
  return q;
}

/** USD conversion prices for P/L math given the current mids. */
function priceMap(symbol: string, mid: number): Record<string, number> {
  // JPY-quoted pairs convert via their own rate (JPY amount / USDJPY = USD);
  // every other catalog instrument is USD-quoted.
  return { [symbol]: mid };
}

/** Floating P/L of the whole open book at the given mid. */
export function replayFloatingPnl(wallet: ReplayWallet, spec: InstrumentSpec, mid: number, time: number, cfg: ReplayExecConfig): number {
  let sum = 0;
  const q = replayQuote(spec, mid, time, cfg);
  const prices = priceMap(spec.symbol, mid);
  for (const p of wallet.positions) {
    sum += positionPnlUsd(spec, p.side, p.lots, p.entry, exitPriceFor(p.side, q), prices);
  }
  return round2(sum);
}

/** Equity = balance + floating P/L. */
export function replayEquity(wallet: ReplayWallet, spec: InstrumentSpec, mid: number, time: number, cfg: ReplayExecConfig): number {
  return round2(wallet.balance + replayFloatingPnl(wallet, spec, mid, time, cfg));
}

/** Margin currently locked by open positions (USD). */
export function replayUsedMargin(wallet: ReplayWallet, spec: InstrumentSpec, mid: number, cfg: ReplayExecConfig): number {
  let used = 0;
  for (const p of wallet.positions) {
    used += marginUsdFor(spec, p.lots, mid, priceMap(spec.symbol, mid), cfg.leverage);
  }
  return round2(used);
}

// ---------------------------------------------------------------------------
// Order actions
// ---------------------------------------------------------------------------

function nextId(wallet: ReplayWallet, prefix: string): string {
  const id = `${prefix}-${wallet.seq}`;
  wallet.seq += 1;
  return id;
}

export interface ReplayOpenArgs {
  symbol: string;
  side: Side;
  lots: number;
  /** pending trigger price (limit/stop) */
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
  /** simulated time (ms) the action happens at */
  now: number;
}

export type ReplayActionOutcome =
  | { ok: true; wallet: ReplayWallet; position: ReplayPosition }
  | { ok: true; wallet: ReplayWallet; order: ReplayOrder }
  | { ok: false; wallet: ReplayWallet; error: string };

/** Validate size + margin, then open a market position at the current quote. */
export function replayOpen(
  walletIn: ReplayWallet, spec: InstrumentSpec, cfg: ReplayExecConfig,
  args: ReplayOpenArgs & { kind: "market"; mid: number },
): ReplayActionOutcome {
  const wallet = cloneWallet(walletIn);
  const err = basicLotsCheck(args.lots);
  if (err) return { ok: false, wallet: walletIn, error: err };
  const q = replayQuote(spec, args.mid, args.now, cfg);
  const prices = priceMap(spec.symbol, args.mid);
  const margin = marginUsdFor(spec, args.lots, q.mid, prices, cfg.leverage);
  const floating = replayFloatingPnl(wallet, spec, args.mid, args.now, cfg);
  const used = replayUsedMargin(wallet, spec, args.mid, cfg);
  if (margin > wallet.balance + floating - used) {
    return { ok: false, wallet: walletIn, error: "Insufficient free margin for this size" };
  }
  const entry = args.side === "buy" ? q.ask : q.bid;
  if (!sideLevelsValid(args.side, entry, args.sl ?? null, args.tp ?? null)) {
    return { ok: false, wallet: walletIn, error: "SL/TP are on the wrong side of the entry price" };
  }
  const pos: ReplayPosition = {
    id: nextId(wallet, "p"),
    symbol: spec.symbol, side: args.side, lots: args.lots,
    entry, sl: args.sl ?? null, tp: args.tp ?? null, openedAt: args.now,
  };
  wallet.positions.push(pos);
  return { ok: true, wallet, position: pos };
}

/** Place a pending limit/stop order (validated against the current quote). */
export function replayPlace(
  walletIn: ReplayWallet, spec: InstrumentSpec, cfg: ReplayExecConfig,
  args: ReplayOpenArgs & { kind: "limit" | "stop"; mid: number },
): ReplayActionOutcome {
  const wallet = cloneWallet(walletIn);
  const err = basicLotsCheck(args.lots);
  if (err) return { ok: false, wallet: walletIn, error: err };
  const price = args.price != null ? args.price : 0;
  if (!(price > 0)) return { ok: false, wallet: walletIn, error: "Pending order needs a trigger price" };
  const q = replayQuote(spec, args.mid, args.now, cfg);
  // trigger-side sanity, mirroring the live engine's validateNewOrder rules
  const triggerOk = args.side === "buy"
    ? (args.kind === "limit" ? price < q.ask : price > q.ask)
    : (args.kind === "limit" ? price > q.bid : price < q.bid);
  if (!triggerOk) {
    return {
      ok: false, wallet: walletIn,
      error: args.kind === "limit"
        ? `Buy limit must be below the ask / sell limit above the bid`
        : `Buy stop must be above the ask / sell stop below the bid`,
    };
  }
  const margin = marginUsdFor(spec, args.lots, price, priceMap(spec.symbol, price), cfg.leverage);
  if (margin > wallet.balance) {
    return { ok: false, wallet: walletIn, error: "Insufficient balance to reserve this pending order" };
  }
  if (!sideLevelsValid(args.side, price, args.sl ?? null, args.tp ?? null)) {
    return { ok: false, wallet: walletIn, error: "SL/TP are on the wrong side of the trigger price" };
  }
  const order: ReplayOrder = {
    id: nextId(wallet, "o"),
    symbol: spec.symbol, side: args.side, kind: args.kind,
    lots: args.lots, price, sl: args.sl ?? null, tp: args.tp ?? null, placedAt: args.now,
  };
  wallet.orders.push(order);
  return { ok: true, wallet, order };
}

export function replayCancel(walletIn: ReplayWallet, orderId: string): ReplayWallet {
  const wallet = cloneWallet(walletIn);
  wallet.orders = wallet.orders.filter((o) => o.id !== orderId);
  return wallet;
}

export function replayModifyPosition(
  walletIn: ReplayWallet, positionId: string,
  patch: { sl?: number | null; tp?: number | null },
): { ok: boolean; wallet: ReplayWallet; error?: string } {
  const wallet = cloneWallet(walletIn);
  const pos = wallet.positions.find((p) => p.id === positionId);
  if (!pos) return { ok: false, wallet: walletIn, error: "Position not found" };
  const sl = patch.sl !== undefined ? patch.sl : pos.sl;
  const tp = patch.tp !== undefined ? patch.tp : pos.tp;
  if (!sideLevelsValid(pos.side, pos.entry, sl ?? null, tp ?? null)) {
    return { ok: false, wallet: walletIn, error: "SL/TP are on the wrong side of the entry price" };
  }
  pos.sl = sl; pos.tp = tp;
  return { ok: true, wallet };
}

export function replayModifyOrder(
  walletIn: ReplayWallet, orderId: string,
  patch: { price?: number; sl?: number | null; tp?: number | null; lots?: number },
): { ok: boolean; wallet: ReplayWallet; error?: string } {
  const wallet = cloneWallet(walletIn);
  const order = wallet.orders.find((o) => o.id === orderId);
  if (!order) return { ok: false, wallet: walletIn, error: "Order not found" };
  if (patch.lots != null) {
    const err = basicLotsCheck(patch.lots);
    if (err) return { ok: false, wallet: walletIn, error: err };
    order.lots = patch.lots;
  }
  if (patch.price != null && patch.price > 0) order.price = patch.price;
  if (patch.sl !== undefined) order.sl = patch.sl;
  if (patch.tp !== undefined) order.tp = patch.tp;
  if (!sideLevelsValid(order.side, order.price, order.sl, order.tp)) {
    return { ok: false, wallet: walletIn, error: "SL/TP are on the wrong side of the trigger price" };
  }
  return { ok: true, wallet };
}

/** Manually close a position at the current mid (spread applied). */
export function replayClose(
  walletIn: ReplayWallet, spec: InstrumentSpec, cfg: ReplayExecConfig,
  positionId: string, mid: number, now: number,
): { ok: boolean; wallet: ReplayWallet; trade?: ReplayTrade; error?: string } {
  const wallet = cloneWallet(walletIn);
  const idx = wallet.positions.findIndex((p) => p.id === positionId);
  if (idx < 0) return { ok: false, wallet: walletIn, error: "Position not found" };
  const pos = wallet.positions[idx];
  const q = replayQuote(spec, mid, now, cfg);
  const exit = exitPriceFor(pos.side, q);
  const gross = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, priceMap(spec.symbol, mid));
  const commission = round2(cfg.commissionPerLot * pos.lots);
  const pnl = round2(gross - commission);
  wallet.balance = round2(wallet.balance + pnl);
  wallet.positions.splice(idx, 1);
  const trade: ReplayTrade = {
    id: pos.id, symbol: pos.symbol, side: pos.side, lots: pos.lots,
    entry: pos.entry, exit, sl: pos.sl, tp: pos.tp,
    openedAt: pos.openedAt, closedAt: now, pnl, commission, reason: "manual",
  };
  wallet.closed.push(trade);
  return { ok: true, wallet, trade };
}

// ---------------------------------------------------------------------------
// Bar stepping — the heart of replay + backtest
// ---------------------------------------------------------------------------

/**
 * The bar's intra-bar price path built ONLY from its real OHLC, ordered
 * direction-aware and conservatively (SL before TP when both are inside):
 * bullish candle O→L→H→C, bearish candle O→H→L→C.
 */
export function barPathPoints(bar: Bar): number[] {
  const path = [bar.open];
  if (bar.close >= bar.open) {
    if (bar.low !== bar.open) path.push(bar.low);
    if (bar.high !== bar.open) path.push(bar.high);
  } else {
    if (bar.high !== bar.open) path.push(bar.high);
    if (bar.low !== bar.open) path.push(bar.low);
  }
  if (bar.close !== path[path.length - 1]) path.push(bar.close);
  return path;
}

function sideLevelsValid(side: Side, entry: number, sl: number | null, tp: number | null): boolean {
  if (sl != null) {
    if (side === "buy" ? sl >= entry : sl <= entry) return false;
  }
  if (tp != null) {
    if (side === "buy" ? tp <= entry : tp >= entry) return false;
  }
  return true;
}

function basicLotsCheck(lots: number): string | null {
  if (!Number.isFinite(lots) || lots < MIN_LOTS) return `Minimum size is ${MIN_LOTS} lots`;
  if (lots > MAX_LOTS) return `Maximum size is ${MAX_LOTS} lots`;
  return null;
}

function cloneWallet(w: ReplayWallet): ReplayWallet {
  return {
    balance: w.balance, seq: w.seq,
    positions: w.positions.map((p) => ({ ...p })),
    orders: w.orders.map((o) => ({ ...o })),
    closed: [...w.closed],
  };
}

/**
 * Advance the wallet by ONE historical bar:
 *  1. walk the bar's conservative OHLC path,
 *  2. at each path point: fill pending orders (gap rule at open),
 *  3. then check SL/TP of positions that existed BEFORE this point,
 *  4. a position opened/filled at a point cannot be stopped out on that same
 *     point (it just came into existence there).
 * P/L is realized on the wallet balance when a position closes.
 */
export function stepReplayBar(
  walletIn: ReplayWallet, spec: InstrumentSpec, cfg: ReplayExecConfig, bar: Bar,
): BarStepResult {
  const wallet = cloneWallet(walletIn);
  const filledOrderIds: string[] = [];
  const closed: BarStepResult["closed"] = [];
  const prices = priceMap(spec.symbol, bar.close);
  const justFilledThisBar = new Set<string>();

  const fillPendingAt = (point: number, isBarOpen: boolean) => {
    for (const order of [...wallet.orders]) {
      if (order.symbol !== spec.symbol) continue;
      const q = replayQuote(spec, point, bar.time * 1000, cfg);
      const gapped = isBarOpen && (
        (order.side === "buy" && order.kind === "limit" && q.ask < order.price) ||
        (order.side === "buy" && order.kind === "stop" && q.ask > order.price) ||
        (order.side === "sell" && order.kind === "limit" && q.bid > order.price) ||
        (order.side === "sell" && order.kind === "stop" && q.bid < order.price)
      );
      const triggered = gapped || checkPendingTrigger(order, q);
      if (!triggered) continue;
      const fill = gapped ? (order.side === "buy" ? q.ask : q.bid) : order.price;
      wallet.orders = wallet.orders.filter((o) => o.id !== order.id);
      wallet.positions.push({
        id: order.id.replace(/^o-/, "p-"),
        symbol: order.symbol, side: order.side, lots: order.lots,
        entry: fill, sl: order.sl, tp: order.tp, openedAt: bar.time * 1000,
      });
      filledOrderIds.push(order.id);
      justFilledThisBar.add(order.id.replace(/^o-/, "p-"));
    }
  };

  const closeAtPoint = (point: number, isBarOpen: boolean) => {
    for (const pos of [...wallet.positions]) {
      if (pos.symbol !== spec.symbol) continue;
      if (justFilledThisBar.has(pos.id)) continue; // born at this instant — SL/TP checked from the NEXT point on
      const q = replayQuote(spec, point, bar.time * 1000, cfg);
      const reason = checkExitTrigger(pos, q);
      if (!reason) continue;
      // Fill semantics (MT5-style): a BUY's SL/TP is a BID price, a SELL's is
      // an ASK price → the level itself is the fill. Exception: a gap THROUGH
      // the level at the bar open fills at the open's quote (real gap cost).
      const level = reason === "sl" ? pos.sl : pos.tp;
      const gapExit = exitPriceFor(pos.side, q);
      const exit = isBarOpen && (
        (pos.side === "buy" && gapExit < (level ?? 0)) ||
        (pos.side === "sell" && gapExit > (level ?? 0))
      ) ? gapExit : (level ?? point);
      const gross = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
      const commission = round2(cfg.commissionPerLot * pos.lots);
      const pnl = round2(gross - commission);
      wallet.balance = round2(wallet.balance + pnl);
      wallet.positions = wallet.positions.filter((p) => p.id !== pos.id);
      const trade: ReplayTrade = {
        id: pos.id, symbol: pos.symbol, side: pos.side, lots: pos.lots,
        entry: pos.entry, exit, sl: pos.sl, tp: pos.tp,
        openedAt: pos.openedAt, closedAt: bar.time * 1000, pnl, commission, reason,
      };
      wallet.closed.push(trade);
      closed.push({ positionId: pos.id, trade, reason });
    }
  };

  // 1) the bar OPEN (gap handling for pendings + SL/TP at open)
  fillPendingAt(bar.open, true);
  closeAtPoint(bar.open, true);
  // 2) the conservative intra-bar path
  const path = barPathPoints(bar);
  for (let i = 1; i < path.length; i++) {
    fillPendingAt(path[i], false);
    closeAtPoint(path[i], false);
    justFilledThisBar.clear(); // from the next point on, fresh fills can stop out
  }
  // pending trigger checks never allow a fill price outside the bar range:
  // fill at the trigger level is always within [low, high] by construction
  // of checkPendingTrigger against quotes built from path points.
  return { wallet, filledOrderIds, closed };
}

// ---------------------------------------------------------------------------
// Performance statistics (shared by replay, backtest and analytics)
// ---------------------------------------------------------------------------

export interface ClosedTradeLike {
  symbol?: string;
  side?: Side;
  lots?: number;
  /** realized P/L — `pnl` accepted as an alias (replay/backtest trade rows) */
  profit?: number;
  pnl?: number;
  openedAt?: number;
  closedAt?: number;
}

export interface PerfStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;          // %
  profitFactor: number;     // grossWins / grossLosses (Infinity when no losses)
  netProfit: number;
  avgWin: number;
  avgLoss: number;
  /** average realized reward/risk realized across trades with both sides known */
  avgRiskReward: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  longs: { count: number; wins: number; pnl: number };
  shorts: { count: number; wins: number; pnl: number };
  bySymbol: Record<string, { count: number; pnl: number; wins: number }>;
  byHour: Record<number, { count: number; pnl: number }>; // UTC entry hour
  byDay: Record<string, number>;                          // UTC YYYY-MM-DD → pnl
  bestDay: { day: string; pnl: number } | null;
  worstDay: { day: string; pnl: number } | null;
}

function dayKeyOf(ms?: number): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function hourOf(ms?: number): number {
  if (!ms) return -1;
  return new Date(ms).getUTCHours();
}

export function performanceStats(closed: ClosedTradeLike[]): PerfStats {
  const trades = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let wins = 0, grossWin = 0, grossLoss = 0, net = 0;
  let avgRRSum = 0, avgRRN = 0;
  let streakW = 0, streakL = 0, maxW = 0, maxL = 0;
  const longs = { count: 0, wins: 0, pnl: 0 };
  const shorts = { count: 0, wins: 0, pnl: 0 };
  const bySymbol: PerfStats["bySymbol"] = {};
  const byHour: PerfStats["byHour"] = {};
  const byDay: Record<string, number> = {};
  for (const t of trades) {
    const p = t.profit ?? t.pnl ?? 0;
    net += p;
    if (p > 0) { wins += 1; grossWin += p; streakW += 1; streakL = 0; }
    else if (p < 0) { grossLoss += -p; streakL += 1; streakW = 0; }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
    const bucket = t.side === "sell" ? shorts : longs;
    bucket.count += 1;
    bucket.pnl += p;
    if (p > 0) bucket.wins += 1;
    const sym = t.symbol || "unknown";
    bySymbol[sym] ??= { count: 0, pnl: 0, wins: 0 };
    bySymbol[sym].count += 1;
    bySymbol[sym].pnl += p;
    if (p > 0) bySymbol[sym].wins += 1;
    const h = hourOf(t.openedAt ?? t.closedAt);
    if (h >= 0) {
      byHour[h] ??= { count: 0, pnl: 0 };
      byHour[h].count += 1;
      byHour[h].pnl += p;
    }
    const d = dayKeyOf(t.closedAt);
    if (d) byDay[d] = round2((byDay[d] ?? 0) + p);
  }
  let best: PerfStats["bestDay"] = null;
  let worst: PerfStats["worstDay"] = null;
  for (const [day, pnl] of Object.entries(byDay)) {
    if (!best || pnl > best.pnl) best = { day, pnl };
    if (!worst || pnl < worst.pnl) worst = { day, pnl };
  }
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const avgWin = wins ? grossWin / wins : 0;
  const losses = trades.length - wins;
  const avgLoss = grossLoss ? grossLoss / losses : 0;
  // realized RR per trade computed by the caller where SL/TP are known;
  // here we derive it from avg win vs avg loss when both exist
  const avgRiskReward = avgLoss > 0 && avgWin > 0 ? avgWin / avgLoss : null;
  return {
    totalTrades: trades.length,
    wins, losses,
    winRate: Math.round(winRate * 10) / 10,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? Infinity : 0),
    netProfit: round2(net),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    avgRiskReward: avgRiskReward != null ? Math.round(avgRiskReward * 100) / 100 : null,
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    longs, shorts,
    bySymbol, byHour, byDay,
    bestDay: best, worstDay: worst,
  };
}

/** Equity/balance curve + max drawdown over a chronological trade list. */
export function equityCurve(
  closed: ClosedTradeLike[], startBalance: number,
): { curve: { t: number; equity: number; balance: number }[]; maxDrawdownUsd: number; maxDrawdownPct: number } {
  const trades = [...closed]
    .filter((t) => t.closedAt != null)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const curve: { t: number; equity: number; balance: number }[] = [];
  let balance = startBalance;
  let peak = startBalance;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  for (const t of trades) {
    balance = round2(balance + (t.profit ?? t.pnl ?? 0));
    peak = Math.max(peak, balance);
    const ddUsd = round2(peak - balance);
    const ddPct = peak > 0 ? Math.round((ddUsd / peak) * 10000) / 100 : 0;
    maxDdUsd = Math.max(maxDdUsd, ddUsd);
    maxDdPct = Math.max(maxDdPct, ddPct);
    curve.push({ t: t.closedAt ?? 0, equity: balance, balance });
  }
  return { curve, maxDrawdownUsd: maxDdUsd, maxDrawdownPct: maxDdPct };
}

export function getInstrumentSafe(symbol: string): InstrumentSpec | null {
  try { return getInstrument(symbol) ?? null; } catch { return null; }
}
