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
import { getInstrument } from "./terminal.ts";
/** Spread per instrument in pip units (pipSize from the catalog). */
export const SPREAD_PIPS = {
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
export function quoteFromMid(mid, spec, source, live, time = Date.now()) {
    const spread = (SPREAD_PIPS[spec.symbol] ?? 2) * spec.pipSize;
    return { mid, bid: mid - spread / 2, ask: mid + spread / 2, time, source, live };
}
/** Multiply a QUOTE-currency amount by this to get USD (from live prices). */
export function convQuoteToUsd(quoteCcy, prices) {
    if (!quoteCcy || quoteCcy === "USD")
        return 1;
    const px = (sym) => prices[sym] || 0;
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
export function positionPnlUsd(spec, side, lots, entry, exit, prices) {
    const diff = side === "buy" ? exit - entry : entry - exit;
    const conv = convQuoteToUsd(spec.quote, prices);
    const v = diff * lots * spec.contractSize * conv;
    return Math.round(v * 100) / 100;
}
/** Required margin in USD for a position at `price` (mid or entry), cents-accurate. */
export function marginUsdFor(spec, lots, price, prices, leverage = DEFAULT_LEVERAGE) {
    const size = lots * spec.contractSize;
    // USD-base forex pairs: notional is already USD (e.g. 1 lot USDJPY = 100k USD)
    const notionalUsd = spec.assetClass === "forex" && spec.symbol.startsWith("USD")
        ? size
        : size * price * convQuoteToUsd(spec.quote, prices);
    const v = notionalUsd / Math.max(1, leverage);
    return Math.round(v * 100) / 100;
}
/** Close price of a position given the live two-sided quote. */
export function exitPriceFor(side, q) {
    return side === "buy" ? q.bid : q.ask;
}
/** Unrealized P/L of one position (USD). */
export function floatingPnlUsd(pos, q, prices) {
    const spec = getInstrument(pos.symbol);
    if (!spec)
        return 0;
    return positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exitPriceFor(pos.side, q), prices);
}
/** Server-computed account metrics. Money values are rounded to cents. */
export function computeMetrics(balance, positions, quotes, prices, leverage = DEFAULT_LEVERAGE) {
    let floating = 0;
    let used = 0;
    let openCount = 0;
    for (const p of positions) {
        const q = quotes[p.symbol];
        const spec = getInstrument(p.symbol);
        if (!spec || !q)
            continue;
        openCount++;
        floating += floatingPnlUsd(p, q, prices);
        used += marginUsdFor(spec, p.lots, q.mid, prices, leverage);
    }
    const equity = balance + floating;
    const r2 = (x) => Math.round(x * 100) / 100;
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
export function checkExitTrigger(pos, q) {
    const closePx = exitPriceFor(pos.side, q);
    if (pos.side === "buy") {
        if (pos.sl != null && closePx <= pos.sl)
            return "sl";
        if (pos.tp != null && closePx >= pos.tp)
            return "tp";
    }
    else {
        if (pos.sl != null && closePx >= pos.sl)
            return "sl";
        if (pos.tp != null && closePx <= pos.tp)
            return "tp";
    }
    return null;
}
/** Pending-order trigger check against a fresh quote. */
export function checkPendingTrigger(order, q) {
    return order.side === "buy"
        ? (order.kind === "limit" ? q.ask <= order.price : q.ask >= order.price)
        : (order.kind === "limit" ? q.bid >= order.price : q.bid <= order.price);
}
/**
 * Validate a new order against the live quote and the account state.
 * Market orders validate margin only; pending orders additionally validate
 * the trigger-side price relationship.
 */
export function validateNewOrder(args) {
    const { spec, side, kind, lots, price, sl, tp, quote, balance, floatingPnl, usedMargin, prices } = args;
    const leverage = args.leverage ?? DEFAULT_LEVERAGE;
    if (!Number.isFinite(lots) || lots < MIN_LOTS)
        return { ok: false, error: `Minimum size is ${MIN_LOTS} lots` };
    if (lots > MAX_LOTS)
        return { ok: false, error: `Maximum size is ${MAX_LOTS} lots` };
    if (kind !== "market" && (!price || !Number.isFinite(price) || price <= 0)) {
        return { ok: false, error: "Pending order needs a valid trigger price" };
    }
    const entry = kind === "market" ? (side === "buy" ? quote.ask : quote.bid) : price;
    if (sl != null) {
        if (side === "buy" && sl >= entry)
            return { ok: false, error: "For a BUY, Stop Loss must be below the entry price" };
        if (side === "sell" && sl <= entry)
            return { ok: false, error: "For a SELL, Stop Loss must be above the entry price" };
    }
    if (tp != null) {
        if (side === "buy" && tp <= entry)
            return { ok: false, error: "For a BUY, Take Profit must be above the entry price" };
        if (side === "sell" && tp >= entry)
            return { ok: false, error: "For a SELL, Take Profit must be below the entry price" };
    }
    if (kind === "limit") {
        if (side === "buy" && entry >= quote.ask)
            return { ok: false, error: "Buy limit must be below the current price (use Buy stop above)" };
        if (side === "sell" && entry <= quote.bid)
            return { ok: false, error: "Sell limit must be above the current price (use Sell stop below)" };
    }
    if (kind === "stop") {
        if (side === "buy" && entry <= quote.ask)
            return { ok: false, error: "Buy stop must be above the current price (use Buy limit below)" };
        if (side === "sell" && entry >= quote.bid)
            return { ok: false, error: "Sell stop must be below the current price (use Sell limit below)" };
    }
    const margin = marginUsdFor(spec, lots, entry, prices, leverage);
    const equity = balance + floatingPnl;
    if (usedMargin + margin > equity) {
        return { ok: false, error: `Not enough free margin: need $${margin.toFixed(2)}, available $${(equity - usedMargin).toFixed(2)}` };
    }
    return { ok: true, entry, margin };
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
export function evaluateAccount(args) {
    const { balance, positions, orders, quotes } = args;
    const prices = args.prices ?? {};
    const leverage = args.leverage ?? DEFAULT_LEVERAGE;
    const out = { fills: [], exits: [], stopOut: false, stopOutIds: [] };
    // ---- stop-out check (needs full metrics) --------------------------------
    const metrics = computeMetrics(balance, positions, quotes, prices, leverage);
    if (metrics.usedMargin > 0 && metrics.marginLevel != null && metrics.marginLevel <= STOP_OUT_LEVEL_PCT) {
        out.stopOut = true;
        out.stopOutIds = positions.map((p) => p.id);
        return out;
    }
    for (const o of orders) {
        const q = quotes[o.symbol];
        if (q && checkPendingTrigger(o, q))
            out.fills.push({ orderId: o.id, entry: o.side === "buy" ? q.ask : q.bid, quoteTime: q.time });
    }
    for (const p of positions) {
        const q = quotes[p.symbol];
        if (!q)
            continue;
        const reason = checkExitTrigger(p, q);
        if (reason)
            out.exits.push({ positionId: p.id, exit: exitPriceFor(p.side, q), reason, quoteTime: q.time });
    }
    return out;
}
/** UTC day key (YYYY-MM-DD) used for daily balance snapshots / daily DD. */
export function dayKey(ts = Date.now()) {
    return new Date(ts).toISOString().slice(0, 10);
}
