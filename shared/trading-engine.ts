/**
 * InspireTrade simulated trading engine — shared pure core.
 *
 * Used by the server trading API (api/_src/trading) for authoritative
 * execution and by the client for display math. NO broker, NO MT5 — all
 * fills happen against the server-side price service on virtual balances.
 *
 * Conventions (standard retail CFD):
 *  - BUY opens at ASK, closes at BID. SELL opens at BID, closes at ASK.
 *  - SL/TP of a BUY are evaluated on BID (its close price); SELL on ASK.
 *  - buy limit fills when ask <= price; buy stop when ask >= price;
 *    sell limit when bid >= price; sell stop when bid <= price.
 *  - Margin: notional/leverage. Notional is USD-converted; forex pairs whose
 *    BASE is USD (USDJPY, USDCAD, USDCHF) have a fixed USD notional.
 *  - P/L is realized in USD: (price diff) x lots x contractSize x quote→USD.
 *  - Stop-out: margin level (equity/usedMargin) <= STOP_OUT_LEVEL_PCT closes
 *    every open position at market.
 */
import { getInstrument, type InstrumentSpec } from "./terminal.ts";

export type Side = "buy" | "sell";
export type OrderKind = "market" | "limit" | "stop";

/** Two-sided executable price around the feed mid. */
export interface Quote {
  bid: number;
  ask: number;
  /** feed mid price */
  mid: number;
  time: number;
  source: string;
  /** true = real-time source (Binance / gold spot); false = delayed feed */
  live: boolean;
}

/** Spread per instrument in pip units (pipSize from the catalog). */
export const SPREAD_PIPS: Record<string, number> = {
  XAUUSD: 2.5, XAGUSD: 3,
  EURUSD: 0.8, GBPUSD: 1, USDJPY: 1, AUDUSD: 1.2, NZDUSD: 1.5, USDCAD: 1.5, USDCHF: 1.5,
  BTCUSD: 12, ETHUSD: 2, SOLUSD: 0.5, XRPUSD: 0.3,
  NAS100: 1.5, US30: 2.5, SPX500: 0.5, GER40: 1.5, UK100: 1.5,
};

export const DEFAULT_LEVERAGE = 100;
/** Margin level (%) at which the engine force-closes open positions. */
export const STOP_OUT_LEVEL_PCT = 20;
export const MIN_LOTS = 0.01;
export const MAX_LOTS = 100;

/** Build a two-sided quote from a feed mid price. */
export function quoteFromMid(mid: number, spec: InstrumentSpec, source: string, live: boolean, time = Date.now()): Quote {
  const spread = (SPREAD_PIPS[spec.symbol] ?? 2) * spec.pipSize;
  return { mid, bid: mid - spread / 2, ask: mid + spread / 2, time, source, live };
}

/** Multiply a QUOTE-currency amount by this to get USD (from live prices). */
export function convQuoteToUsd(quoteCcy: string, prices: Record<string, number>): number {
  if (!quoteCcy || quoteCcy === "USD") return 1;
  const px = (sym: string) => prices[sym] || 0;
  switch (quoteCcy) {
    case "JPY": return px("USDJPY") ? 1 / px("USDJPY") : 0;
    case "CHF": return px("USDCHF") ? 1 / px("USDCHF") : 0;
    case "CAD": return px("USDCAD") ? 1 / px("USDCAD") : 0;
    case "EUR": return px("EURUSD");
    case "GBP": return px("GBPUSD");
    default: return 0;
  }
}

/** Realized/unrealized P/L in USD for closing `lots` at `exit` (cents-accurate). */
export function positionPnlUsd(
  spec: InstrumentSpec, side: Side, lots: number, entry: number, exit: number,
  prices: Record<string, number>,
): number {
  const diff = side === "buy" ? exit - entry : entry - exit;
  const conv = convQuoteToUsd(spec.quote, prices);
  const v = diff * lots * spec.contractSize * conv;
  return Math.round(v * 100) / 100;
}

/** Required margin in USD for a position at `price` (mid or entry), cents-accurate. */
export function marginUsdFor(
  spec: InstrumentSpec, lots: number, price: number, prices: Record<string, number>,
  leverage: number = DEFAULT_LEVERAGE,
): number {
  const size = lots * spec.contractSize;
  // USD-base forex pairs: notional is already USD (e.g. 1 lot USDJPY = 100k USD)
  const notionalUsd = spec.assetClass === "forex" && spec.symbol.startsWith("USD")
    ? size
    : size * price * convQuoteToUsd(spec.quote, prices);
  const v = notionalUsd / Math.max(1, leverage);
  return Math.round(v * 100) / 100;
}

export interface PositionLike {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;
}

export interface OrderLike {
  id: string;
  symbol: string;
  side: Side;
  kind: "limit" | "stop";
  lots: number;
  price: number;
  sl: number | null;
  tp: number | null;
}

export interface AccountMetrics {
  balance: number;
  floatingPnl: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  /** equity / usedMargin * 100, null when no open positions */
  marginLevel: number | null;
  openCount: number;
}

/** Close price of a position given the live two-sided quote. */
export function exitPriceFor(side: Side, q: Quote): number {
  return side === "buy" ? q.bid : q.ask;
}

/** Unrealized P/L of one position (USD). */
export function floatingPnlUsd(pos: PositionLike, q: Quote, prices: Record<string, number>): number {
  const spec = getInstrument(pos.symbol);
  if (!spec) return 0;
  return positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exitPriceFor(pos.side, q), prices);
}

/** Server-computed account metrics. Money values are rounded to cents. */
export function computeMetrics(
  balance: number,
  positions: PositionLike[],
  quotes: Record<string, Quote>,
  prices: Record<string, number>,
  leverage: number = DEFAULT_LEVERAGE,
): AccountMetrics {
  let floating = 0;
  let used = 0;
  let openCount = 0;
  for (const p of positions) {
    const q = quotes[p.symbol];
    const spec = getInstrument(p.symbol);
    if (!spec || !q) continue;
    openCount++;
    floating += floatingPnlUsd(p, q, prices);
    used += marginUsdFor(spec, p.lots, q.mid, prices, leverage);
  }
  const equity = balance + floating;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    balance: r2(balance),
    floatingPnl: r2(floating),
    equity: r2(equity),
    usedMargin: r2(used),
    freeMargin: r2(equity - used),
    marginLevel: used > 0 ? r2((equity / used) * 100) : null,
    openCount,
  };
}

/** SL/TP check for one position against a fresh quote. Returns the reason. */
export function checkExitTrigger(pos: PositionLike, q: Quote): "sl" | "tp" | null {
  const closePx = exitPriceFor(pos.side, q);
  if (pos.side === "buy") {
    if (pos.sl != null && closePx <= pos.sl) return "sl";
    if (pos.tp != null && closePx >= pos.tp) return "tp";
  } else {
    if (pos.sl != null && closePx >= pos.sl) return "sl";
    if (pos.tp != null && closePx <= pos.tp) return "tp";
  }
  return null;
}

/** Pending-order trigger check against a fresh quote. */
export function checkPendingTrigger(order: OrderLike, q: Quote): boolean {
  return order.side === "buy"
    ? (order.kind === "limit" ? q.ask <= order.price : q.ask >= order.price)
    : (order.kind === "limit" ? q.bid >= order.price : q.bid <= order.price);
}

export interface OrderValidation {
  ok: boolean;
  error?: string;
  entry?: number;
  margin?: number;
}

/**
 * Validate a new order against the live quote and the account state.
 * Market orders validate margin only; pending orders additionally validate
 * the trigger-side price relationship.
 */
export function validateNewOrder(args: {
  spec: InstrumentSpec;
  side: Side;
  kind: OrderKind;
  lots: number;
  price?: number | null;      // pending trigger price
  sl?: number | null;
  tp?: number | null;
  quote: Quote;
  balance: number;
  floatingPnl: number;
  usedMargin: number;
  prices: Record<string, number>;
  leverage?: number;
}): OrderValidation {
  const { spec, side, kind, lots, price, sl, tp, quote, balance, floatingPnl, usedMargin, prices } = args;
  const leverage = args.leverage ?? DEFAULT_LEVERAGE;
  if (!Number.isFinite(lots) || lots < MIN_LOTS) return { ok: false, error: `Minimum size is ${MIN_LOTS} lots` };
  if (lots > MAX_LOTS) return { ok: false, error: `Maximum size is ${MAX_LOTS} lots` };
  if (kind !== "market" && (!price || !Number.isFinite(price) || price <= 0)) {
    return { ok: false, error: "Pending order needs a valid trigger price" };
  }
  const entry = kind === "market" ? (side === "buy" ? quote.ask : quote.bid) : (price as number);
  if (sl != null) {
    if (side === "buy" && sl >= entry) return { ok: false, error: "For a BUY, Stop Loss must be below the entry price" };
    if (side === "sell" && sl <= entry) return { ok: false, error: "For a SELL, Stop Loss must be above the entry price" };
  }
  if (tp != null) {
    if (side === "buy" && tp <= entry) return { ok: false, error: "For a BUY, Take Profit must be above the entry price" };
    if (side === "sell" && tp >= entry) return { ok: false, error: "For a SELL, Take Profit must be below the entry price" };
  }
  if (kind === "limit") {
    if (side === "buy" && entry >= quote.ask) return { ok: false, error: "Buy limit must be below the current price (use Buy stop above)" };
    if (side === "sell" && entry <= quote.bid) return { ok: false, error: "Sell limit must be above the current price (use Sell stop below)" };
  }
  if (kind === "stop") {
    if (side === "buy" && entry <= quote.ask) return { ok: false, error: "Buy stop must be above the current price (use Buy limit below)" };
    if (side === "sell" && entry >= quote.bid) return { ok: false, error: "Sell stop must be below the current price (use Sell limit below)" };
  }
  const margin = marginUsdFor(spec, lots, entry, prices, leverage);
  const equity = balance + floatingPnl;
  if (usedMargin + margin > equity) {
    return { ok: false, error: `Not enough free margin: need $${margin.toFixed(2)}, available $${(equity - usedMargin).toFixed(2)}` };
  }
  return { ok: true, entry, margin };
}

export interface EvaluateResult {
  /** pending orders that must fill now (at the trigger quote) */
  fills: { orderId: string; entry: number; quoteTime: number }[];
  /** positions that hit SL/TP (exit at the close price of the quote) */
  exits: { positionId: string; exit: number; reason: "sl" | "tp"; quoteTime: number }[];
  /** margin level breached — force-close every open position */
  stopOut: boolean;
  stopOutIds: string[];
}

/**
 * Pure account evaluator — the single authority for SL/TP, pending triggers
 * and stop-out. The server applies the returned mutations inside a Firestore
 * transaction; tests run it against synthetic quote streams.
 *
 * Stop-out runs FIRST: when the margin level breaches STOP_OUT_LEVEL_PCT every
 * open position is force-closed at market and SL/TP results are suppressed
 * (the server closes everything the stop-out lists).
 */
export function evaluateAccount(args: {
  balance: number;
  positions: PositionLike[];
  orders: OrderLike[];
  quotes: Record<string, Quote>;
  prices?: Record<string, number>;
  leverage?: number;
}): EvaluateResult {
  const { balance, positions, orders, quotes } = args;
  const prices = args.prices ?? {};
  const leverage = args.leverage ?? DEFAULT_LEVERAGE;
  const out: EvaluateResult = { fills: [], exits: [], stopOut: false, stopOutIds: [] };

  // ---- stop-out check (needs full metrics) --------------------------------
  const metrics = computeMetrics(balance, positions, quotes, prices, leverage);
  if (metrics.usedMargin > 0 && metrics.marginLevel != null && metrics.marginLevel <= STOP_OUT_LEVEL_PCT) {
    out.stopOut = true;
    out.stopOutIds = positions.map((p) => p.id);
    return out;
  }

  for (const o of orders) {
    const q = quotes[o.symbol];
    if (q && checkPendingTrigger(o, q)) out.fills.push({ orderId: o.id, entry: o.side === "buy" ? q.ask : q.bid, quoteTime: q.time });
  }
  for (const p of positions) {
    const q = quotes[p.symbol];
    if (!q) continue;
    const reason = checkExitTrigger(p, q);
    if (reason) out.exits.push({ positionId: p.id, exit: exitPriceFor(p.side, q), reason, quoteTime: q.time });
  }
  return out;
}

/** UTC day key (YYYY-MM-DD) used for daily balance snapshots / daily DD. */
export function dayKey(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Overnight swap — simulated financing cost, USD per 1.00 lot per night.
// Negative = the holder pays; positive = the holder receives. These are
// simulation parameters (configurable constants), charged per UTC midnight
// crossed while the position stays open (no triple-Wednesday modeling).
// ---------------------------------------------------------------------------

export const SWAP_USD_PER_LOT_NIGHT: Record<string, { long: number; short: number }> = {
  XAUUSD: { long: -8.4, short: 1.6 },
  XAGUSD: { long: -7.5, short: -1.0 },
  EURUSD: { long: -5.3, short: 3.1 },
  GBPUSD: { long: -3.8, short: 1.4 },
  USDJPY: { long: 8.9, short: -13.0 },
  AUDUSD: { long: -6.6, short: 4.0 },
  NZDUSD: { long: -5.9, short: 2.9 },
  USDCAD: { long: -2.1, short: -7.9 },
  USDCHF: { long: 6.4, short: -11.2 },
  BTCUSD: { long: -32.0, short: -18.0 },
  ETHUSD: { long: -21.0, short: -12.0 },
  SOLUSD: { long: -8.0, short: -5.0 },
  XRPUSD: { long: -5.0, short: -3.0 },
  NAS100: { long: -2.9, short: 1.1 },
  US30: { long: -3.7, short: 1.3 },
  SPX500: { long: -1.9, short: 0.7 },
  GER40: { long: -1.6, short: -0.7 },
  UK100: { long: -8.3, short: -2.4 },
};

/** Whole UTC midnights crossed between two timestamps. */
export function nightsHeld(openedAt: number, now: number): number {
  if (!(now > openedAt)) return 0;
  const d1 = new Date(openedAt);
  const d2 = new Date(now);
  const u1 = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
  const u2 = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate());
  return Math.floor((u2 - u1) / 86_400_000);
}

/** Swap (USD, cents-accurate) owed for `nights` whole nights on `lots`. */
export function swapForPosition(
  spec: InstrumentSpec, side: Side, lots: number, openedAt: number, now: number = Date.now(),
): number {
  const rate = SWAP_USD_PER_LOT_NIGHT[spec.symbol];
  if (!rate) return 0;
  const nights = nightsHeld(openedAt, now);
  if (nights <= 0) return 0;
  const perNight = side === "buy" ? rate.long : rate.short;
  return Math.round(perNight * lots * nights * 100) / 100;
}

// ---------------------------------------------------------------------------
// Prop-firm rules — pure rule engine (server is the only enforcer).
//
// Hard breaches (daily loss / overall drawdown) terminate the account: the
// server force-closes every position and cancels every pending order and
// sets status "failed". Passing requires the profit target, the minimum
// trading-day count and a flat book (all positions closed) at the same time.
// ---------------------------------------------------------------------------

export type AccountStatus = "active" | "passed" | "failed";

export interface PropRules {
  /** Max equity loss in one UTC day, % of the day-start balance. null = off. */
  dailyLossLimitPct: number | null;
  /** Max loss from the starting balance, % (static drawdown). null = off. */
  maxDrawdownPct: number | null;
  /** Profit target, % of the starting balance. null = no target. */
  profitTargetPct: number | null;
  /** Distinct UTC days with at least one closed trade required to pass. */
  minTradingDays: number;
  /** Max combined open lots (positions + pending orders). null = off. */
  maxLotsTotal: number | null;
  /** Max lots per single order. null = off. */
  maxLotsPerOrder: number | null;
  /** Max open positions + pending orders combined. null = off. */
  maxOpenPositions: number | null;
}

export const DEFAULT_PROP_RULES: PropRules = {
  dailyLossLimitPct: 5,
  maxDrawdownPct: 10,
  profitTargetPct: 10,
  minTradingDays: 3,
  maxLotsTotal: 10,
  maxLotsPerOrder: 5,
  maxOpenPositions: 10,
};

export interface RuleEvaluation {
  status: AccountStatus;
  failedReason: string | null;
  /** hard breach — server must force-close everything and terminate */
  hardBreach: boolean;
  dailyBreach: boolean;
  overallBreach: boolean;
  /** equity ≥ target (pass may still need trading days / flat book) */
  targetReached: boolean;
  /** all pass conditions met right now */
  canPass: boolean;
  dailyLossUsd: number;
  dailyLossLimitUsd: number | null;
  drawdownUsd: number;
  maxDrawdownUsd: number | null;
  targetUsd: number | null;
  tradingDays: number;
  peakEquity: number;
  /** 0..1+ fill levels for progress bars */
  dailyLossUsed: number;
  drawdownUsed: number;
  targetProgress: number;
}

/**
 * Evaluate prop rules against the live account state. Pure: no mutation —
 * the caller applies status changes and force-closes when hardBreach is set.
 * Accounts without rules (DEMO) get a neutral pass-through evaluation.
 */
export function evaluatePropRules(args: {
  rules: PropRules | null;
  status: AccountStatus;
  balance: number;
  equity: number;
  startingBalance: number;
  dayStartBalance: number;
  peakEquity: number;
  tradingDays: number;
  openPositions: number;
  openLots: number;
}): RuleEvaluation {
  const { rules, startingBalance, equity, dayStartBalance, tradingDays, openPositions } = args;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const peakEquity = Math.max(args.peakEquity, equity);

  const out: RuleEvaluation = {
    status: args.status,
    failedReason: null,
    hardBreach: false,
    dailyBreach: false,
    overallBreach: false,
    targetReached: false,
    canPass: false,
    dailyLossUsd: 0,
    dailyLossLimitUsd: null,
    drawdownUsd: 0,
    maxDrawdownUsd: null,
    targetUsd: null,
    tradingDays,
    peakEquity: r2(peakEquity),
    dailyLossUsed: 0,
    drawdownUsed: 0,
    targetProgress: 0,
  };

  if (!rules) return out; // DEMO account — nothing to enforce

  // daily loss: equity below the day-start balance (includes floating P/L)
  if (rules.dailyLossLimitPct != null && rules.dailyLossLimitPct > 0) {
    const limit = r2(dayStartBalance * (rules.dailyLossLimitPct / 100));
    const loss = r2(dayStartBalance - equity);
    out.dailyLossUsd = loss;
    out.dailyLossLimitUsd = limit;
    out.dailyLossUsed = limit > 0 ? Math.max(0, loss / limit) : 0;
    if (loss >= limit && limit > 0) {
      out.dailyBreach = true;
      out.failedReason = `Daily loss limit breached: -$${loss.toFixed(2)} of -$${limit.toFixed(2)} allowed today`;
    }
  }

  // overall drawdown: equity below the starting balance (static)
  if (rules.maxDrawdownPct != null && rules.maxDrawdownPct > 0) {
    const limit = r2(startingBalance * (rules.maxDrawdownPct / 100));
    const dd = r2(startingBalance - equity);
    out.drawdownUsd = dd;
    out.maxDrawdownUsd = limit;
    out.drawdownUsed = limit > 0 ? Math.max(0, dd / limit) : 0;
    if (dd >= limit && limit > 0) {
      out.overallBreach = true;
      out.failedReason = `Maximum drawdown breached: -$${dd.toFixed(2)} of -$${limit.toFixed(2)} allowed overall`;
    }
  }

  // profit target (needs the book flat and the minimum trading days to pass)
  if (rules.profitTargetPct != null && rules.profitTargetPct > 0) {
    const target = r2(startingBalance * (rules.profitTargetPct / 100));
    out.targetUsd = target;
    out.targetReached = equity >= startingBalance + target;
    out.targetProgress = target > 0 ? Math.max(0, (equity - startingBalance) / target) : 0;
    out.canPass = out.targetReached
      && tradingDays >= Math.max(0, rules.minTradingDays)
      && openPositions === 0;
  }

  out.hardBreach = out.dailyBreach || out.overallBreach;
  if (out.hardBreach) {
    out.status = "failed";
    out.canPass = false;
  } else if (out.canPass && args.status !== "failed") {
    out.status = "passed";
  } else if (args.status !== "failed") {
    out.status = "active";
  }
  return out;
}

/** Distinct UTC days that produced at least one closed trade. */
export function tradingDayCount(trades: { closedAt: number }[]): number {
  const days = new Set<string>();
  for (const t of trades) days.add(dayKey(t.closedAt));
  return days.size;
}

// ---------------------------------------------------------------------------
// Order/position modification validation — against the LIVE quote
// (MT5 semantics: an SL beyond the entry locking profit is legal).
// ---------------------------------------------------------------------------

export interface ModifyValidation { ok: boolean; error?: string }

/** Validate new SL/TP for an OPEN position against its live close price. */
export function validatePositionModify(args: {
  pos: Pick<PositionLike, "side" | "entry">;
  quote: Quote;
  sl?: number | null;
  tp?: number | null;
}): ModifyValidation {
  const { pos, quote } = args;
  const closePx = exitPriceFor(pos.side, quote);
  const sl = args.sl ?? null;
  const tp = args.tp ?? null;
  if (sl != null && (!Number.isFinite(sl) || sl <= 0)) return { ok: false, error: "Invalid Stop Loss" };
  if (tp != null && (!Number.isFinite(tp) || tp <= 0)) return { ok: false, error: "Invalid Take Profit" };
  if (pos.side === "buy") {
    if (sl != null && sl >= closePx) return { ok: false, error: "For a BUY, Stop Loss must be below the current Bid price" };
    if (tp != null && tp <= closePx) return { ok: false, error: "For a BUY, Take Profit must be above the current Bid price" };
  } else {
    if (sl != null && sl <= closePx) return { ok: false, error: "For a SELL, Stop Loss must be above the current Ask price" };
    if (tp != null && tp >= closePx) return { ok: false, error: "For a SELL, Take Profit must be below the current Ask price" };
  }
  return { ok: true };
}

/** Validate a pending-order modification against the live quote. */
export function validateOrderModify(args: {
  order: Pick<OrderLike, "side" | "kind" | "price">;
  quote: Quote;
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
}): ModifyValidation {
  const { order, quote } = args;
  const price = args.price != null ? Number(args.price) : order.price;
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "Invalid trigger price" };
  if (order.kind === "limit") {
    if (order.side === "buy" && price >= quote.ask) return { ok: false, error: "Buy limit must stay below the current price" };
    if (order.side === "sell" && price <= quote.bid) return { ok: false, error: "Sell limit must stay above the current price" };
  } else {
    if (order.side === "buy" && price <= quote.ask) return { ok: false, error: "Buy stop must stay above the current price" };
    if (order.side === "sell" && price >= quote.bid) return { ok: false, error: "Sell stop must stay below the current price" };
  }
  const ref = { side: order.side, entry: price };
  const v = validatePositionModify({ pos: ref, quote, sl: args.sl ?? null, tp: args.tp ?? null });
  return v;
}

/** Prop-rule guard for new orders (applies on top of margin validation). */
export function validateAgainstRules(args: {
  rules: PropRules | null;
  lots: number;
  openPositions: number;
  openOrders: number;
  openLots: number;
}): ModifyValidation & { needsSlot?: boolean } {
  const { rules } = args;
  if (!rules) return { ok: true };
  if (rules.maxLotsPerOrder != null && args.lots > rules.maxLotsPerOrder) {
    return { ok: false, error: `Max lot size per order is ${rules.maxLotsPerOrder}` };
  }
  if (rules.maxLotsTotal != null && args.openLots + args.lots > rules.maxLotsTotal + 1e-9) {
    return { ok: false, error: `Max combined volume is ${rules.maxLotsTotal} lots (you have ${Math.round(args.openLots * 100) / 100})` };
  }
  if (rules.maxOpenPositions != null && args.openPositions + args.openOrders + 1 > rules.maxOpenPositions) {
    return { ok: false, error: `Max ${rules.maxOpenPositions} open positions/orders allowed` };
  }
  return { ok: true };
}
