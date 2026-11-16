import { getInstrument } from "./terminal.ts";
const SPREAD_PIPS = {
  XAUUSD: 2.5,
  XAGUSD: 3,
  EURUSD: 0.8,
  GBPUSD: 1,
  USDJPY: 1,
  AUDUSD: 1.2,
  NZDUSD: 1.5,
  USDCAD: 1.5,
  USDCHF: 1.5,
  BTCUSD: 12,
  ETHUSD: 2,
  SOLUSD: 0.5,
  XRPUSD: 0.3,
  NAS100: 1.5,
  US30: 2.5,
  SPX500: 0.5,
  GER40: 1.5,
  UK100: 1.5
};
const DEFAULT_LEVERAGE = 100;
const STOP_OUT_LEVEL_PCT = 20;
const MIN_LOTS = 0.01;
const MAX_LOTS = 100;
function quoteFromMid(mid, spec, source, live, time = Date.now()) {
  const spread = (SPREAD_PIPS[spec.symbol] ?? 2) * spec.pipSize;
  return { mid, bid: mid - spread / 2, ask: mid + spread / 2, time, source, live };
}
function convQuoteToUsd(quoteCcy, prices) {
  if (!quoteCcy || quoteCcy === "USD") return 1;
  const px = (sym) => prices[sym] || 0;
  switch (quoteCcy) {
    case "JPY":
      return px("USDJPY") ? 1 / px("USDJPY") : 0;
    case "CHF":
      return px("USDCHF") ? 1 / px("USDCHF") : 0;
    case "CAD":
      return px("USDCAD") ? 1 / px("USDCAD") : 0;
    case "EUR":
      return px("EURUSD");
    case "GBP":
      return px("GBPUSD");
    default:
      return 0;
  }
}
function positionPnlUsd(spec, side, lots, entry, exit, prices) {
  const diff = side === "buy" ? exit - entry : entry - exit;
  const conv = convQuoteToUsd(spec.quote, prices);
  const v = diff * lots * spec.contractSize * conv;
  return Math.round(v * 100) / 100;
}
function marginUsdFor(spec, lots, price, prices, leverage = DEFAULT_LEVERAGE) {
  const size = lots * spec.contractSize;
  const notionalUsd = spec.assetClass === "forex" && spec.symbol.startsWith("USD") ? size : size * price * convQuoteToUsd(spec.quote, prices);
  const v = notionalUsd / Math.max(1, leverage);
  return Math.round(v * 100) / 100;
}
function exitPriceFor(side, q) {
  return side === "buy" ? q.bid : q.ask;
}
function floatingPnlUsd(pos, q, prices) {
  const spec = getInstrument(pos.symbol);
  if (!spec) return 0;
  return positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exitPriceFor(pos.side, q), prices);
}
function computeMetrics(balance, positions, quotes, prices, leverage = DEFAULT_LEVERAGE) {
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
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    balance: r2(balance),
    floatingPnl: r2(floating),
    equity: r2(equity),
    usedMargin: r2(used),
    freeMargin: r2(equity - used),
    marginLevel: used > 0 ? r2(equity / used * 100) : null,
    openCount
  };
}
function checkExitTrigger(pos, q) {
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
function checkPendingTrigger(order, q) {
  return order.side === "buy" ? order.kind === "limit" ? q.ask <= order.price : q.ask >= order.price : order.kind === "limit" ? q.bid >= order.price : q.bid <= order.price;
}
function validateNewOrder(args) {
  const { spec, side, kind, lots, price, sl, tp, quote, balance, floatingPnl, usedMargin, prices } = args;
  const leverage = args.leverage ?? DEFAULT_LEVERAGE;
  if (!Number.isFinite(lots) || lots < MIN_LOTS) return { ok: false, error: `Minimum size is ${MIN_LOTS} lots` };
  if (lots > MAX_LOTS) return { ok: false, error: `Maximum size is ${MAX_LOTS} lots` };
  if (kind !== "market" && (!price || !Number.isFinite(price) || price <= 0)) {
    return { ok: false, error: "Pending order needs a valid trigger price" };
  }
  const entry = kind === "market" ? side === "buy" ? quote.ask : quote.bid : price;
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
function evaluateAccount(args) {
  const { balance, positions, orders, quotes } = args;
  const prices = args.prices ?? {};
  const leverage = args.leverage ?? DEFAULT_LEVERAGE;
  const out = { fills: [], exits: [], stopOut: false, stopOutIds: [] };
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
function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
const SWAP_USD_PER_LOT_NIGHT = {
  XAUUSD: { long: -8.4, short: 1.6 },
  XAGUSD: { long: -7.5, short: -1 },
  EURUSD: { long: -5.3, short: 3.1 },
  GBPUSD: { long: -3.8, short: 1.4 },
  USDJPY: { long: 8.9, short: -13 },
  AUDUSD: { long: -6.6, short: 4 },
  NZDUSD: { long: -5.9, short: 2.9 },
  USDCAD: { long: -2.1, short: -7.9 },
  USDCHF: { long: 6.4, short: -11.2 },
  BTCUSD: { long: -32, short: -18 },
  ETHUSD: { long: -21, short: -12 },
  SOLUSD: { long: -8, short: -5 },
  XRPUSD: { long: -5, short: -3 },
  NAS100: { long: -2.9, short: 1.1 },
  US30: { long: -3.7, short: 1.3 },
  SPX500: { long: -1.9, short: 0.7 },
  GER40: { long: -1.6, short: -0.7 },
  UK100: { long: -8.3, short: -2.4 }
};
function nightsHeld(openedAt, now) {
  if (!(now > openedAt)) return 0;
  const d1 = new Date(openedAt);
  const d2 = new Date(now);
  const u1 = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
  const u2 = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate());
  return Math.floor((u2 - u1) / 864e5);
}
function swapForPosition(spec, side, lots, openedAt, now = Date.now()) {
  const rate = SWAP_USD_PER_LOT_NIGHT[spec.symbol];
  if (!rate) return 0;
  const nights = nightsHeld(openedAt, now);
  if (nights <= 0) return 0;
  const perNight = side === "buy" ? rate.long : rate.short;
  return Math.round(perNight * lots * nights * 100) / 100;
}
const DEFAULT_PROP_RULES = {
  dailyLossLimitPct: 5,
  maxDrawdownPct: 10,
  profitTargetPct: 10,
  minTradingDays: 3,
  maxLotsTotal: 10,
  maxLotsPerOrder: 5,
  maxOpenPositions: 10
};
function evaluatePropRules(args) {
  const { rules, startingBalance, equity, dayStartBalance, tradingDays, openPositions } = args;
  const r2 = (x) => Math.round(x * 100) / 100;
  const peakEquity = Math.max(args.peakEquity, equity);
  const out = {
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
    targetProgress: 0
  };
  if (!rules) return out;
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
  if (rules.profitTargetPct != null && rules.profitTargetPct > 0) {
    const target = r2(startingBalance * (rules.profitTargetPct / 100));
    out.targetUsd = target;
    out.targetReached = equity >= startingBalance + target;
    out.targetProgress = target > 0 ? Math.max(0, (equity - startingBalance) / target) : 0;
    out.canPass = out.targetReached && tradingDays >= Math.max(0, rules.minTradingDays) && openPositions === 0;
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
function tradingDayCount(trades) {
  const days = /* @__PURE__ */ new Set();
  for (const t of trades) days.add(dayKey(t.closedAt));
  return days.size;
}
function validatePositionModify(args) {
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
function validateOrderModify(args) {
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
function validateAgainstRules(args) {
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
export {
  DEFAULT_LEVERAGE,
  DEFAULT_PROP_RULES,
  MAX_LOTS,
  MIN_LOTS,
  SPREAD_PIPS,
  STOP_OUT_LEVEL_PCT,
  SWAP_USD_PER_LOT_NIGHT,
  checkExitTrigger,
  checkPendingTrigger,
  computeMetrics,
  convQuoteToUsd,
  dayKey,
  evaluateAccount,
  evaluatePropRules,
  exitPriceFor,
  floatingPnlUsd,
  marginUsdFor,
  nightsHeld,
  positionPnlUsd,
  quoteFromMid,
  swapForPosition,
  tradingDayCount,
  validateAgainstRules,
  validateNewOrder,
  validateOrderModify,
  validatePositionModify
};
