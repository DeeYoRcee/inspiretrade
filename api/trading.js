import { createRequire as __cR } from 'module';
const require = __cR(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// api/_src/lib/firebase.ts
var firebase_exports = {};
__export(firebase_exports, {
  HttpError: () => HttpError,
  assertPost: () => assertPost,
  decrementCounter: () => decrementCounter,
  firestore: () => firestore,
  handle: () => handle,
  json: () => json,
  localDate: () => localDate,
  logLedger: () => logLedger,
  previousDate: () => previousDate,
  requireAdmin: () => requireAdmin,
  requireUser: () => requireUser,
  rtdb: () => rtdb
});
import * as adminNamespace from "firebase-admin";
function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: String(parsed.private_key).replace(/\\n/g, "\n")
        };
      }
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON");
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    };
  }
  return null;
}
function ensureApp() {
  if (app) return app;
  const account = getServiceAccount();
  if (!account) {
    throw new HttpError(
      500,
      "SERVER_NOT_CONFIGURED",
      "Missing FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) environment variables on the server."
    );
  }
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKey: account.privateKey
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${account.projectId}-default-rtdb.firebaseio.com`
  });
  return app;
}
async function requireUser(req) {
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, "MISSING_TOKEN", "Missing Authorization bearer token");
  ensureApp();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired token");
  }
  if (!decoded?.uid) throw new HttpError(401, "INVALID_TOKEN", "Invalid token payload");
  return { uid: decoded.uid, email: decoded.email, name: decoded.name };
}
async function requireAdmin(req) {
  const user = await requireUser(req);
  const emails = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  let flagged = false;
  try {
    flagged = (await rtdb().ref(`admins/${user.uid}`).once("value")).val() === true;
  } catch {
  }
  if (!emails.includes(String(user.email || "").toLowerCase()) && !flagged) {
    throw new HttpError(403, "FORBIDDEN", "Owner access required");
  }
  return user;
}
function rtdb() {
  ensureApp();
  return admin.database();
}
function json(res, status, data) {
  res.status(status).json(data);
}
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        console.error("[api] unexpected error:", err);
        res.status(500).json({ error: "INTERNAL", message: "Unexpected server error" });
      }
    }
  };
}
function assertPost(req) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST only");
}
async function decrementCounter(ref, insufficientError) {
  const before = (await ref.get()).val() || 0;
  const tx = await ref.transaction((c) => {
    const v = c || 0;
    return v >= 1 ? v - 1 : v;
  });
  const after = tx?.snapshot?.val?.() ?? 0;
  if (!tx?.committed || after >= before) {
    throw insufficientError;
  }
  return after;
}
function localDate(offsetHours = 5, d = /* @__PURE__ */ new Date()) {
  return new Date(d.getTime() + offsetHours * 3600 * 1e3).toISOString().slice(0, 10);
}
function previousDate(dateStr) {
  const d = /* @__PURE__ */ new Date(dateStr + "T00:00:00Z");
  return new Date(d.getTime() - 864e5).toISOString().slice(0, 10);
}
async function logLedger(entry) {
  try {
    await rtdb().ref("ledger").push({ ...entry, at: Date.now() });
  } catch (e) {
    console.error("[api] ledger write failed", e);
  }
}
function firestore() {
  ensureApp();
  return admin.firestore();
}
var admin, HttpError, app;
var init_firebase = __esm({
  "api/_src/lib/firebase.ts"() {
    "use strict";
    admin = adminNamespace.default ?? adminNamespace;
    HttpError = class extends Error {
      constructor(status, code, message) {
        super(message || code);
        this.status = status;
        this.code = code;
      }
    };
    app = null;
  }
});

// api/_src/trading/index.ts
init_firebase();

// api/_src/trading/store.ts
init_firebase();

// shared/terminal.ts
var INSTRUMENTS = [
  // ---- Metals -------------------------------------------------------------
  { symbol: "XAUUSD", name: "Gold / USD", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes", yahoo: "GC=F" },
  { symbol: "XAGUSD", name: "Silver / USD", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5e3, quote: "USD", feed: "quotes", yahoo: "SI=F" },
  // ---- Forex majors -------------------------------------------------------
  { symbol: "EURUSD", name: "Euro / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "EURUSD=X" },
  { symbol: "GBPUSD", name: "British Pound / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X" },
  { symbol: "USDJPY", name: "US Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 1e5, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X" },
  { symbol: "AUDUSD", name: "Australian Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X" },
  { symbol: "USDCAD", name: "US Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X" },
  { symbol: "USDCHF", name: "US Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X" },
  // ---- Crypto (live via Binance public API, no key) -----------------------
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT" },
  { symbol: "ETHUSD", name: "Ethereum / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT" },
  { symbol: "XRPUSD", name: "XRP / USD", assetClass: "crypto", digits: 4, pipSize: 1e-4, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT" },
  // ---- Indices (CFD reference levels, quotes proxy) -----------------------
  { symbol: "NAS100", name: "US Tech 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX" },
  { symbol: "US30", name: "Wall Street 30", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI" },
  { symbol: "SPX500", name: "US 500", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC" },
  { symbol: "GER40", name: "Germany 40", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI" },
  { symbol: "UK100", name: "UK 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE" }
];
function getInstrument(symbol) {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}

// shared/trading-engine.ts
var SPREAD_PIPS = {
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
var DEFAULT_LEVERAGE = 100;
var STOP_OUT_LEVEL_PCT = 20;
var MIN_LOTS = 0.01;
var MAX_LOTS = 100;
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
var SWAP_USD_PER_LOT_NIGHT = {
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
  if (args.periodExpired && !out.hardBreach) {
    out.failedReason = `Trading period expired (${rules.maxTradingDays} days) without reaching the profit target`;
    out.status = "failed";
    out.hardBreach = true;
    out.canPass = false;
    return out;
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
function periodExpired(rules, startedAt, now = Date.now()) {
  if (!rules || rules.maxTradingDays == null || rules.maxTradingDays <= 0) return false;
  const start = Number(startedAt) || 0;
  if (!start) return false;
  return now >= start + rules.maxTradingDays * 864e5;
}
function bumpTradeStats(stats, pnl) {
  const s = stats && typeof stats === "object" ? { ...stats } : { totalTrades: 0, wins: 0, losses: 0 };
  s.totalTrades = (s.totalTrades || 0) + 1;
  if (pnl > 0) s.wins = (s.wins || 0) + 1;
  else if (pnl < 0) s.losses = (s.losses || 0) + 1;
  return s;
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

// api/_src/trading/prices.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var BINANCE_HOSTS = ["api.binance.com", "data-api.binance.vision"];
var CRYPTO_TTL = 3e3;
var SPOT_TTL = 5e3;
var YAHOO_TTL = 45e3;
var cache = /* @__PURE__ */ new Map();
async function fetchJson(url, timeoutMs = 6e3, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function fetchCryptoMids(binanceSyms) {
  let lastErr;
  for (let i = 0; i < BINANCE_HOSTS.length; i++) {
    try {
      const host = BINANCE_HOSTS[i];
      const q = encodeURIComponent(JSON.stringify(binanceSyms));
      const arr = await fetchJson(`https://${host}/api/v3/ticker/price?symbols=${q}`);
      const out = {};
      for (const row of arr) if (Number.isFinite(+row.price)) out[row.symbol] = +row.price;
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("binance unreachable");
}
var GOLD_CODES = { XAUUSD: "XAU", XAGUSD: "XAG" };
async function fetchSpot(code) {
  const res = await fetchJson(`https://api.gold-api.com/price/${code}`);
  const price = Number(res?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
  return price;
}
async function fetchYahooMid(yahooSym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`;
  const json2 = await fetchJson(url, 8e3, { "User-Agent": UA });
  const meta = json2?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_YAHOO");
  return price;
}
async function getMids(symbols) {
  const out = {};
  const now = Date.now();
  const want = [];
  for (const s of symbols) {
    const cached = cache.get(s);
    if (cached && now - cached.time < (cached.live ? Math.min(CRYPTO_TTL, SPOT_TTL) : YAHOO_TTL)) out[s] = cached;
    else want.push(s);
  }
  if (want.length) {
    const crypto = want.filter((s) => getInstrument(s)?.feed === "binance");
    const spot = want.filter((s) => GOLD_CODES[s]);
    const yahoo = want.filter((s) => {
      const inst = getInstrument(s);
      return inst && inst.feed !== "binance" && !GOLD_CODES[s];
    });
    await Promise.all([
      (async () => {
        if (!crypto.length) return;
        const binanceSyms = crypto.map((s) => getInstrument(s).binance);
        const byBinance = await fetchCryptoMids(binanceSyms);
        for (const s of crypto) {
          const p = byBinance[getInstrument(s).binance];
          if (Number.isFinite(p)) {
            out[s] = { mid: p, source: "binance", live: true, time: Date.now() };
            cache.set(s, out[s]);
          }
        }
      })(),
      (async () => {
        for (const s of spot) {
          try {
            const p = await fetchSpot(GOLD_CODES[s]);
            out[s] = { mid: p, source: "gold-api", live: true, time: Date.now() };
            cache.set(s, out[s]);
          } catch {
          }
        }
      })(),
      (async () => {
        for (const s of yahoo) {
          const inst = getInstrument(s);
          if (!inst?.yahoo) continue;
          try {
            const p = await fetchYahooMid(inst.yahoo);
            out[s] = { mid: p, source: "yahoo", live: false, time: Date.now() };
            cache.set(s, out[s]);
          } catch {
          }
        }
      })()
    ]);
  }
  return out;
}
function withConversionSymbols(symbols) {
  const set = new Set(symbols);
  for (const s of symbols) {
    const inst = getInstrument(s);
    if (!inst || inst.quote === "USD") continue;
    if (inst.quote === "EUR") set.add("EURUSD");
    else if (inst.quote === "GBP") set.add("GBPUSD");
    else if (inst.quote === "JPY") set.add("USDJPY");
    else if (inst.quote === "CHF") set.add("USDCHF");
    else if (inst.quote === "CAD") set.add("USDCAD");
  }
  return [...set];
}
async function getQuotes(symbols) {
  const mids = await getMids(withConversionSymbols(symbols));
  const out = {};
  for (const [sym, info] of Object.entries(mids)) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    out[sym] = quoteFromMid(info.mid, inst, info.source, info.live, info.time);
  }
  return out;
}
var ALL_SYMBOLS = INSTRUMENTS.map((i) => i.symbol);

// api/_src/trading/store.ts
var MAX_ACCOUNTS = 10;
var MAX_OPEN_POSITIONS = 30;
var MAX_PENDING_ORDERS = 30;
var TRADE_HISTORY_KEEP = 500;
var ALLOWED_LEVERAGES = [10, 20, 30, 50, 100, 200, 500];
var db = () => firestore();
var accountsCol = (uid) => db().collection("users").doc(uid).collection("accounts");
var posCol = (uid, aid) => accountsCol(uid).doc(aid).collection("positions");
var ordCol = (uid, aid) => accountsCol(uid).doc(aid).collection("orders");
var tradeCol = (uid, aid) => accountsCol(uid).doc(aid).collection("trades");
async function quotesForState(state, extra = []) {
  const symbols = withConversionSymbols([
    ...state.positions.map((p) => p.symbol),
    ...state.orders.map((o) => o.symbol),
    ...extra
  ]);
  const quotes = await getQuotes(symbols);
  const prices = {};
  for (const [sym, q] of Object.entries(quotes)) prices[sym] = q.mid;
  return { quotes, prices };
}
function requireQuote(quotes, symbol) {
  const q = quotes[symbol];
  if (!q) throw new HttpError(503, "NO_QUOTE", `No executable price for ${symbol} right now \u2014 try again`);
  return q;
}
function writeTradeDoc(tx, uid, aid, o) {
  tx.set(tradeCol(uid, aid).doc(), { ...o });
}
function recordClose(state, tx, uid, aid, o) {
  writeTradeDoc(tx, uid, aid, o);
  bumpTradingDay(state.account, o.closedAt);
  state.account.stats = bumpTradeStats(state.account.stats, o.pnl);
}
function settleSwap(state, pos, now) {
  const spec = getInstrument(pos.symbol);
  if (!spec) return pos.swapAccrued ?? 0;
  const nights = Math.max(nightsHeld(pos.openedAt, now), 0);
  const charged = pos.swapNights ?? 0;
  if (nights <= charged) return pos.swapAccrued ?? 0;
  const owed = swapForPosition(spec, pos.side, pos.lots, pos.openedAt + charged * 864e5, now);
  state.account.balance = Math.round((state.account.balance + owed) * 100) / 100;
  pos.swapAccrued = Math.round(((pos.swapAccrued ?? 0) + owed) * 100) / 100;
  pos.swapNights = nights;
  return pos.swapAccrued;
}
function applyEvaluationTx(tx, uid, aid, state, quotes, prices) {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const now = Date.now();
  const result = evaluateAccount({
    balance: state.account.balance,
    positions: state.positions,
    orders: state.orders,
    quotes,
    prices,
    leverage
  });
  const closed = [];
  const toClose = [];
  if (result.stopOut) {
    for (const p of state.positions) {
      const q = requireQuote(quotes, p.symbol);
      toClose.push({ pos: p, exit: exitPriceFor(p.side, q), reason: "stopout" });
    }
  } else {
    for (const e of result.exits) {
      const pos = state.positions.find((p) => p.id === e.positionId);
      if (pos) toClose.push({ pos, exit: e.exit, reason: e.reason });
    }
  }
  for (const { pos, exit, reason } of toClose) {
    const spec = getInstrument(pos.symbol);
    const swap = settleSwap(state, pos, now);
    const pnl = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    closed.push({
      symbol: pos.symbol,
      side: pos.side,
      lots: pos.lots,
      entry: pos.entry,
      exit,
      pnl,
      swap,
      reason,
      openedAt: pos.openedAt,
      closedAt: now,
      positionId: pos.id
    });
    tx.delete(posCol(uid, aid).doc(pos.id));
    state.positions = state.positions.filter((p) => p.id !== pos.id);
  }
  for (const o of closed) {
    recordClose(state, tx, uid, aid, o);
  }
  for (const f of result.fills) {
    const order = state.orders.find((o) => o.id === f.orderId);
    if (!order) continue;
    const posRef = posCol(uid, aid).doc();
    const pos = {
      id: posRef.id,
      symbol: order.symbol,
      side: order.side,
      lots: order.lots,
      entry: f.entry,
      sl: order.sl,
      tp: order.tp,
      openedAt: now,
      swapAccrued: 0,
      swapNights: 0
    };
    tx.set(posRef, { symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, sl: pos.sl, tp: pos.tp, openedAt: pos.openedAt, swapAccrued: 0, swapNights: 0 });
    tx.delete(ordCol(uid, aid).doc(order.id));
    state.orders = state.orders.filter((o) => o.id !== order.id);
    state.positions.push(pos);
  }
  for (const p of state.positions) {
    const spec = getInstrument(p.symbol);
    if (!spec) continue;
    const nights = Math.max(nightsHeld(p.openedAt, now), 0);
    if (nights > (p.swapNights ?? 0)) {
      settleSwap(state, p, now);
      tx.update(posCol(uid, aid).doc(p.id), { swapAccrued: p.swapAccrued, swapNights: p.swapNights });
    }
  }
  const today = dayKey();
  const dayStart = { ...state.account.dayStart || {} };
  if (dayStart[today] == null) dayStart[today] = state.account.balance;
  state.account.dayStart = dayStart;
  const rules = state.account.rules ?? null;
  if (rules && state.account.status !== "failed") {
    const leverage2 = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage2);
    const ruleState = evaluatePropRules({
      rules,
      status: state.account.status || "active",
      balance: state.account.balance,
      equity: metrics.equity,
      startingBalance: state.account.startingBalance,
      dayStartBalance: dayStart[today] ?? state.account.balance,
      peakEquity: state.account.peakEquity ?? state.account.balance,
      tradingDays: Object.keys(state.account.tradingDays || {}).length,
      openPositions: state.positions.length,
      openLots: state.positions.reduce((s, p) => s + p.lots, 0),
      periodExpired: periodExpired(rules, state.account.startedAt || state.account.createdAt, now)
    });
    state.account.peakEquity = ruleState.peakEquity;
    state.account.status = ruleState.status;
    state.account.failedReason = ruleState.status === "failed" ? ruleState.failedReason : null;
    if (ruleState.hardBreach) {
      for (const p of [...state.positions]) {
        const q = requireQuote(quotes, p.symbol);
        const spec = getInstrument(p.symbol);
        const swap = settleSwap(state, p, now);
        const exit = exitPriceFor(p.side, q);
        const pnl = positionPnlUsd(spec, p.side, p.lots, p.entry, exit, prices);
        state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
        const outcome = {
          symbol: p.symbol,
          side: p.side,
          lots: p.lots,
          entry: p.entry,
          exit,
          pnl,
          swap,
          reason: "rule-breach",
          openedAt: p.openedAt,
          closedAt: now,
          positionId: p.id
        };
        closed.push(outcome);
        recordClose(state, tx, uid, aid, outcome);
        tx.delete(posCol(uid, aid).doc(p.id));
      }
      state.positions = [];
      for (const o of state.orders) tx.delete(ordCol(uid, aid).doc(o.id));
      state.orders = [];
    }
    return { closed, filled: result.fills.length, ruleState };
  }
  return { closed, filled: result.fills.length, ruleState: null };
}
function bumpTradingDay(account, closedAt) {
  const key = dayKey(closedAt);
  const days = { ...account.tradingDays || {} };
  days[key] = (days[key] || 0) + 1;
  account.tradingDays = days;
}
function persistAccountTx(tx, uid, aid, state, quotes, prices) {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
  tx.update(accountsCol(uid).doc(aid), {
    balance: state.account.balance,
    dayStart: state.account.dayStart,
    status: state.account.status || "active",
    rules: state.account.rules ?? null,
    failedReason: state.account.failedReason ?? null,
    peakEquity: state.account.peakEquity ?? state.account.balance,
    tradingDays: state.account.tradingDays || {},
    stats: state.account.stats || { totalTrades: 0, wins: 0, losses: 0 },
    adminSuspended: !!state.account.adminSuspended,
    startedAt: state.account.startedAt || state.account.createdAt || Date.now(),
    challengeTypeId: state.account.challengeTypeId ?? null,
    challengeName: state.account.challengeName ?? null,
    balanceUpdatedAt: Date.now(),
    metrics: { ...metrics, updatedAt: Date.now() }
  });
  return metrics;
}
async function readState(uid, aid) {
  const accSnap = await accountsCol(uid).doc(aid).get();
  if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const [posSnap, ordSnap] = await Promise.all([
    posCol(uid, aid).get(),
    ordCol(uid, aid).get()
  ]);
  const positions = posSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const orders = ordSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { id: aid, account: accSnap.data(), positions, orders };
}
async function listAccounts(uid) {
  const snap = await accountsCol(uid).orderBy("createdAt", "asc").get();
  const today = dayKey();
  const out = [];
  for (const doc of snap.docs) {
    const state = await readState(uid, doc.id);
    const { quotes, prices } = await quotesForState(state);
    const leverage = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
    const acc = state.account;
    const ruleState = acc.rules ? evaluatePropRules({
      rules: acc.rules,
      status: acc.status || "active",
      balance: acc.balance,
      equity: metrics.equity,
      startingBalance: acc.startingBalance,
      dayStartBalance: acc.dayStart?.[today] ?? acc.balance,
      peakEquity: acc.peakEquity ?? acc.balance,
      tradingDays: Object.keys(acc.tradingDays || {}).length,
      openPositions: state.positions.length,
      openLots: state.positions.reduce((s, p) => s + p.lots, 0),
      periodExpired: periodExpired(acc.rules, acc.startedAt || acc.createdAt, Date.now())
    }) : null;
    out.push({
      id: doc.id,
      label: acc.label,
      type: acc.type,
      challengeTypeId: acc.challengeTypeId ?? null,
      challengeName: acc.challengeName ?? null,
      balance: acc.balance,
      startingBalance: acc.startingBalance,
      leverage: acc.leverage,
      createdAt: acc.createdAt,
      status: acc.status || "active",
      rules: acc.rules ?? null,
      failedReason: acc.failedReason ?? null,
      adminSuspended: !!acc.adminSuspended,
      startedAt: acc.startedAt ?? acc.createdAt ?? null,
      peakEquity: acc.peakEquity ?? acc.balance,
      tradingDays: Object.keys(acc.tradingDays || {}).length,
      stats: acc.stats || { totalTrades: 0, wins: 0, losses: 0 },
      dayStart: acc.dayStart ?? {},
      ruleState,
      positions: state.positions,
      orders: state.orders,
      metrics,
      quotes: Object.fromEntries(Object.entries(quotes).filter(([s]) => state.positions.some((p) => p.symbol === s) || state.orders.some((o) => o.symbol === s)))
    });
  }
  return out;
}
async function history(uid, aid, limit = 100) {
  const snap = await tradeCol(uid, aid).orderBy("closedAt", "desc").limit(Math.min(200, Math.max(1, limit))).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
function sanitizeRules(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pct = (v, lo, hi) => {
    const n = Number(v);
    if (v == null || v === "" || !Number.isFinite(n)) return null;
    return Math.min(hi, Math.max(lo, n));
  };
  const rules = {
    dailyLossLimitPct: pct(raw.dailyLossLimitPct, 1, 50),
    maxDrawdownPct: pct(raw.maxDrawdownPct, 1, 50),
    profitTargetPct: pct(raw.profitTargetPct, 1, 100),
    minTradingDays: Math.min(60, Math.max(0, Math.floor(Number(raw.minTradingDays) || 0))),
    maxLotsTotal: pct(raw.maxLotsTotal, 0.01, 100),
    maxLotsPerOrder: pct(raw.maxLotsPerOrder, 0.01, 100),
    maxOpenPositions: raw.maxOpenPositions == null ? null : Math.min(30, Math.max(1, Math.floor(Number(raw.maxOpenPositions) || 1))),
    maxTradingDays: pct(raw.maxTradingDays, 0, 365)
  };
  const hasAny = rules.dailyLossLimitPct != null || rules.maxDrawdownPct != null || rules.profitTargetPct != null || rules.minTradingDays > 0 || rules.maxLotsTotal != null || rules.maxLotsPerOrder != null || rules.maxOpenPositions != null || rules.maxTradingDays != null;
  return hasAny ? rules : null;
}
async function createAccount(uid, label, startingBalance, opts = {}) {
  const existing = await accountsCol(uid).get();
  if (existing.size >= MAX_ACCOUNTS) throw new HttpError(409, "TOO_MANY_ACCOUNTS", `Maximum ${MAX_ACCOUNTS} accounts`);
  const balance = Math.round(Math.min(5e6, Math.max(1e3, Number(startingBalance) || 1e5)) * 100) / 100;
  const rules = sanitizeRules(opts.rules);
  const levRaw = Number(opts.leverage);
  const leverage = ALLOWED_LEVERAGES.includes(levRaw) ? levRaw : DEFAULT_LEVERAGE;
  const today = dayKey();
  const doc = {
    label: String(label || (rules ? "CHALLENGE" : "DEMO")).slice(0, 32) || "DEMO",
    type: rules ? "CHALLENGE" : "DEMO",
    challengeTypeId: opts.challengeTypeId ?? null,
    challengeName: String(opts.challengeName || "").slice(0, 60) || null,
    balance,
    startingBalance: balance,
    leverage,
    status: "active",
    rules,
    failedReason: null,
    adminSuspended: false,
    startedAt: Date.now(),
    peakEquity: balance,
    tradingDays: {},
    stats: { totalTrades: 0, wins: 0, losses: 0 },
    createdAt: Date.now(),
    dayStart: { [today]: balance }
  };
  const ref = await accountsCol(uid).add(doc);
  return { id: ref.id, ...doc, metrics: computeMetrics(balance, [], {}, {}, leverage), positions: [], orders: [] };
}
async function resetAccount(uid, aid) {
  const dbRef = db();
  const accRef = accountsCol(uid).doc(aid);
  return dbRef.runTransaction(async (tx) => {
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
    const [posSnap, ordSnap, tradeSnap] = await Promise.all([
      tx.get(posCol(uid, aid)),
      tx.get(ordCol(uid, aid)),
      tx.get(tradeCol(uid, aid).limit(TRADE_HISTORY_KEEP + 1))
    ]);
    if (posSnap.size || ordSnap.size) {
      throw new HttpError(409, "ACCOUNT_BUSY", "Close all positions and pending orders before resetting");
    }
    if (tradeSnap.size > TRADE_HISTORY_KEEP) throw new HttpError(409, "TOO_MANY_TRADES", "Reset keeps the last 500 trades \u2014 this account has more");
    for (const d of tradeSnap.docs) tx.delete(d.ref);
    const account = accSnap.data();
    const balance = account.startingBalance;
    tx.update(accRef, {
      balance,
      // a reset starts a fresh attempt: challenge status back to active
      status: "active",
      failedReason: null,
      adminSuspended: false,
      startedAt: Date.now(),
      peakEquity: balance,
      tradingDays: {},
      stats: { totalTrades: 0, wins: 0, losses: 0 },
      dayStart: { [dayKey()]: balance },
      metrics: { ...computeMetrics(balance, [], {}, {}, account.leverage || DEFAULT_LEVERAGE), updatedAt: Date.now() },
      balanceUpdatedAt: Date.now()
    });
    return { balance };
  });
}
async function evaluate(uid, aid) {
  const dbRef = db();
  const accRef = accountsCol(uid).doc(aid);
  const preState = await readState(uid, aid);
  const { quotes, prices } = await quotesForState(preState);
  return dbRef.runTransaction(async (tx) => {
    const state = await txGetState(tx, uid, aid);
    const before = state.account.balance;
    const { closed } = applyEvaluationTx(tx, uid, aid, state, quotes, prices);
    const metrics = persistAccountTx(tx, uid, aid, state, quotes, prices);
    return { metrics, realized: Math.round((state.account.balance - before) * 100) / 100, closed };
  });
}
async function txGetState(tx, uid, aid) {
  const accRef = accountsCol(uid).doc(aid);
  const [accSnap, posSnap, ordSnap] = await Promise.all([
    tx.get(accRef),
    tx.get(posCol(uid, aid)),
    tx.get(ordCol(uid, aid))
  ]);
  if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  return {
    id: aid,
    account: accSnap.data(),
    positions: posSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    orders: ordSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  };
}
async function placeOrder(uid, req) {
  const spec = getInstrument(req.symbol || "");
  if (!spec) throw new HttpError(400, "BAD_SYMBOL", `Unknown instrument: ${req.symbol}`);
  if (req.side !== "buy" && req.side !== "sell") throw new HttpError(400, "BAD_SIDE", "side must be buy or sell");
  const kind = req.kind === "limit" || req.kind === "stop" ? req.kind : "market";
  const dbRef = db();
  const accRef = accountsCol(uid).doc(req.accountId);
  const preState = await readState(uid, req.accountId);
  const { quotes, prices } = await quotesForState(preState, [spec.symbol]);
  return dbRef.runTransaction(async (tx) => {
    const state = await txGetState(tx, uid, req.accountId);
    applyEvaluationTx(tx, uid, req.accountId, state, quotes, prices);
    const leverage = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
    if (state.account.rules && state.account.status !== "active") {
      throw new HttpError(
        403,
        "ACCOUNT_NOT_ACTIVE",
        state.account.status === "failed" ? `Challenge failed: ${state.account.failedReason || "rule breached"} \u2014 trading is disabled` : "Challenge passed \u2014 trading is disabled"
      );
    }
    if (state.account.rules && state.account.adminSuspended) {
      throw new HttpError(403, "ACCOUNT_SUSPENDED", "Account suspended by an administrator \u2014 trading is disabled");
    }
    const lots = Number(req.lots);
    const quote = requireQuote(quotes, spec.symbol);
    const rules = state.account.rules ?? null;
    const rulesCheck = validateAgainstRules({
      rules,
      lots,
      openPositions: state.positions.length,
      openOrders: state.orders.length,
      openLots: state.positions.reduce((s, p) => s + p.lots, 0) + state.orders.reduce((s, o) => s + o.lots, 0)
    });
    if (!rulesCheck.ok) throw new HttpError(403, "RULE_REJECTED", rulesCheck.error || "Prop rule breached");
    const v = validateNewOrder({
      spec,
      side: req.side,
      kind,
      lots,
      price: req.price ?? null,
      sl: req.sl ?? null,
      tp: req.tp ?? null,
      quote,
      balance: state.account.balance,
      floatingPnl: metrics.floatingPnl,
      usedMargin: metrics.usedMargin,
      prices,
      leverage
    });
    if (!v.ok) throw new HttpError(400, "ORDER_REJECTED", v.error || "Order rejected");
    if (kind === "market") {
      if (state.positions.length >= MAX_OPEN_POSITIONS) {
        throw new HttpError(409, "TOO_MANY_POSITIONS", `Maximum ${MAX_OPEN_POSITIONS} open positions`);
      }
      const posRef = posCol(uid, req.accountId).doc();
      const pos = {
        symbol: spec.symbol,
        side: req.side,
        lots,
        entry: v.entry,
        sl: req.sl ?? null,
        tp: req.tp ?? null,
        openedAt: Date.now(),
        comment: String(req.comment || "").slice(0, 120) || null,
        swapAccrued: 0,
        swapNights: 0
      };
      tx.set(posRef, pos);
      const m2 = computeMetrics(state.account.balance, [...state.positions, { id: posRef.id, ...pos }], quotes, prices, leverage);
      tx.update(accRef, {
        dayStart: state.account.dayStart,
        peakEquity: state.account.peakEquity ?? state.account.balance,
        tradingDays: state.account.tradingDays || {},
        status: state.account.status || "active",
        metrics: { ...m2, updatedAt: Date.now() },
        balanceUpdatedAt: Date.now()
      });
      return { position: { id: posRef.id, ...pos }, order: null, entry: v.entry, quote, closed: [] };
    }
    if (state.orders.length >= MAX_PENDING_ORDERS) {
      throw new HttpError(409, "TOO_MANY_ORDERS", `Maximum ${MAX_PENDING_ORDERS} pending orders`);
    }
    const ordRef = ordCol(uid, req.accountId).doc();
    const order = {
      symbol: spec.symbol,
      side: req.side,
      kind,
      lots,
      price: Number(req.price),
      sl: req.sl ?? null,
      tp: req.tp ?? null,
      createdAt: Date.now()
    };
    tx.set(ordRef, order);
    tx.update(accRef, { dayStart: state.account.dayStart });
    return { position: null, order: { id: ordRef.id, ...order }, entry: v.entry, quote, closed: [] };
  });
}
async function closePosition(uid, accountId, positionId, lots) {
  const spec = getInstrument((await posCol(uid, accountId).doc(positionId).get()).data()?.symbol || "");
  if (!spec) throw new HttpError(404, "NO_POSITION", "Position not found");
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx) => {
    const state = await txGetState(tx, uid, accountId);
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const pos = state.positions.find((p) => p.id === positionId);
    if (!pos) throw new HttpError(404, "NO_POSITION", "Position not found (maybe SL/TP already closed it)");
    const quote = requireQuote(quotes, pos.symbol);
    const exit = exitPriceFor(pos.side, quote);
    const closeLots = lots == null ? pos.lots : Math.round(Number(lots) * 100) / 100;
    if (!Number.isFinite(closeLots) || closeLots < MIN_LOTS) throw new HttpError(400, "BAD_LOTS", `Minimum close size ${MIN_LOTS}`);
    if (closeLots > pos.lots) throw new HttpError(400, "BAD_LOTS", `Position holds ${pos.lots} lots`);
    const lotsBefore = pos.lots;
    const swapTotal = settleSwap(state, pos, Date.now());
    const swapShare = closeLots === lotsBefore ? swapTotal : Math.round(swapTotal * (closeLots / lotsBefore) * 100) / 100;
    const pnl = positionPnlUsd(spec, pos.side, closeLots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    const outcome = {
      symbol: pos.symbol,
      side: pos.side,
      lots: closeLots,
      entry: pos.entry,
      exit,
      pnl,
      swap: swapShare,
      reason: "manual",
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      positionId: pos.id
    };
    recordClose(state, tx, uid, accountId, outcome);
    if (closeLots === pos.lots) {
      tx.delete(posCol(uid, accountId).doc(pos.id));
      state.positions = state.positions.filter((p) => p.id !== pos.id);
    } else {
      const remaining = Math.round((pos.lots - closeLots) * 100) / 100;
      tx.update(posCol(uid, accountId).doc(pos.id), {
        lots: remaining,
        swapAccrued: Math.round((swapTotal - swapShare) * 100) / 100,
        swapNights: pos.swapNights ?? 0
      });
      pos.lots = remaining;
    }
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { closed: outcome, metrics, exit, quote };
  });
}
async function modifyPosition(uid, accountId, positionId, sl, tp) {
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx) => {
    const state = await txGetState(tx, uid, accountId);
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const pos = state.positions.find((p) => p.id === positionId);
    if (!pos) throw new HttpError(404, "NO_POSITION", "Position not found (maybe SL/TP already closed it)");
    const quote = requireQuote(quotes, pos.symbol);
    const num = (x) => x == null || x === "" ? null : Number(x);
    const slNum = sl !== void 0 ? num(sl) : pos.sl;
    const tpNum = tp !== void 0 ? num(tp) : pos.tp;
    const v = validatePositionModify({ pos, quote, sl: slNum, tp: tpNum });
    if (!v.ok) throw new HttpError(400, "BAD_SLTP", v.error || "Invalid SL/TP");
    tx.update(posCol(uid, accountId).doc(positionId), { sl: slNum, tp: tpNum, slModifiedAt: Date.now() });
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { ok: true, sl: slNum, tp: tpNum, metrics };
  });
}
async function modifyOrder(uid, accountId, orderId, patch) {
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx) => {
    const state = await txGetState(tx, uid, accountId);
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new HttpError(404, "NO_ORDER", "Order not found (maybe it already filled)");
    const spec = getInstrument(order.symbol);
    if (!spec) throw new HttpError(400, "BAD_SYMBOL", `Unknown instrument: ${order.symbol}`);
    const quote = requireQuote(quotes, order.symbol);
    const num = (x, fallback) => x == null || x === "" ? fallback : Number(x);
    const newPrice = patch.price != null ? Number(patch.price) : order.price;
    const newLots = patch.lots != null ? Math.round(Number(patch.lots) * 100) / 100 : order.lots;
    const newSl = num(patch.sl, order.sl);
    const newTp = num(patch.tp, order.tp);
    if (!Number.isFinite(newLots) || newLots < MIN_LOTS || newLots > MAX_LOTS) {
      throw new HttpError(400, "BAD_LOTS", `Volume must be ${MIN_LOTS}\u2013${MAX_LOTS} lots`);
    }
    const rules = state.account.rules ?? null;
    const othersLots = state.orders.filter((o) => o.id !== orderId).reduce((s, o) => s + o.lots, 0) + state.positions.reduce((s, p) => s + p.lots, 0);
    const rulesCheck = validateAgainstRules({ rules, lots: newLots, openPositions: state.positions.length, openOrders: state.orders.length - 1, openLots: othersLots });
    if (!rulesCheck.ok) throw new HttpError(403, "RULE_REJECTED", rulesCheck.error || "Prop rule breached");
    const v = validateOrderModify({ order, quote, price: newPrice, sl: newSl, tp: newTp });
    if (!v.ok) throw new HttpError(400, "BAD_ORDER", v.error || "Invalid order modification");
    const updated = { price: newPrice, lots: newLots, sl: newSl, tp: newTp, modifiedAt: Date.now() };
    tx.update(ordCol(uid, accountId).doc(orderId), updated);
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { ok: true, order: { ...order, ...updated, modifiedAt: void 0 }, metrics };
  });
}
async function closeAll(uid, accountId) {
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx) => {
    const state = await txGetState(tx, uid, accountId);
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const closed = [];
    const now = Date.now();
    for (const pos of [...state.positions]) {
      const spec = getInstrument(pos.symbol);
      const quote = requireQuote(quotes, pos.symbol);
      const exit = exitPriceFor(pos.side, quote);
      const swap = settleSwap(state, pos, now);
      const pnl = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
      state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
      const outcome = {
        symbol: pos.symbol,
        side: pos.side,
        lots: pos.lots,
        entry: pos.entry,
        exit,
        pnl,
        swap,
        reason: "manual",
        openedAt: pos.openedAt,
        closedAt: now,
        positionId: pos.id
      };
      closed.push(outcome);
      recordClose(state, tx, uid, accountId, outcome);
      tx.delete(posCol(uid, accountId).doc(pos.id));
    }
    state.positions = [];
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { closed, metrics };
  });
}
async function cancelOrder(uid, accountId, orderId) {
  const ref = ordCol(uid, accountId).doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "NO_ORDER", "Order not found");
  await ref.delete();
  return { ok: true };
}

// api/_src/trading/admin.ts
init_firebase();
var challengeTypesCol = () => firestore().collection("challengeTypes");
var auditCol = () => firestore().collection("propAudit");
var settingsDoc = () => firestore().collection("settings").doc("leaderboard");
var ALLOWED_LEVERAGES2 = [10, 20, 30, 50, 100, 200, 500];
var clampPct = (v, lo, hi) => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};
function sanitizeChallengeType(raw) {
  const size = Math.round(Number(raw.size));
  if (!Number.isFinite(size) || ![5e3, 1e4, 25e3, 5e4, 1e5].includes(size)) {
    throw new HttpError(400, "BAD_SIZE", "Account size must be one of $5,000 / $10,000 / $25,000 / $50,000 / $100,000");
  }
  const name = String(raw.name || "").trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, "BAD_NAME", "Challenge name must be at least 2 characters");
  const leverageRaw = Number(raw.leverage);
  const type = {
    name,
    size,
    profitTargetPct: clampPct(raw.profitTargetPct, 0.5, 100),
    dailyLossLimitPct: clampPct(raw.dailyLossLimitPct, 0.5, 50),
    maxDrawdownPct: clampPct(raw.maxDrawdownPct, 0.5, 50),
    minTradingDays: Math.min(60, Math.max(0, Math.floor(Number(raw.minTradingDays) || 0))),
    maxTradingDays: clampPct(raw.maxTradingDays, 0, 365),
    maxLotsPerOrder: clampPct(raw.maxLotsPerOrder, 0.01, 100),
    maxLotsTotal: clampPct(raw.maxLotsTotal, 0.01, 100),
    maxOpenPositions: raw.maxOpenPositions == null || raw.maxOpenPositions === "" ? null : Math.min(30, Math.max(1, Math.floor(Number(raw.maxOpenPositions) || 1))),
    leverage: ALLOWED_LEVERAGES2.includes(leverageRaw) ? leverageRaw : 100,
    active: raw.active === void 0 ? true : !!raw.active,
    description: String(raw.description || "").slice(0, 400)
  };
  if (type.profitTargetPct == null && type.dailyLossLimitPct == null && type.maxDrawdownPct == null) {
    throw new HttpError(400, "BAD_RULES", "A challenge needs at least a profit target or a drawdown limit");
  }
  return type;
}
async function listChallengeTypes(activeOnly = false) {
  const snap = await challengeTypesCol().get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  return activeOnly ? rows.filter((r) => r.active !== false) : rows;
}
async function saveChallengeType(body, admin2) {
  const type = sanitizeChallengeType(body);
  const now = Date.now();
  let id = String(body.id || "").trim();
  if (id) {
    const ref = challengeTypesCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, "NO_CHALLENGE_TYPE", "Challenge type not found");
    await ref.update({ ...type, updatedAt: now });
  } else {
    const ref = await challengeTypesCol().add({ ...type, createdAt: now, updatedAt: now });
    id = ref.id;
  }
  await writeAudit(admin2, "challenge_type_save", { challengeTypeId: id, name: type.name, size: type.size });
  return { id, ...type };
}
async function deleteChallengeType(id, admin2) {
  const ref = challengeTypesCol().doc(String(id || "").trim());
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "NO_CHALLENGE_TYPE", "Challenge type not found");
  await ref.delete();
  await writeAudit(admin2, "challenge_type_delete", { challengeTypeId: id, name: snap.data()?.name });
  return { ok: true };
}
async function resolveTargetUid(body) {
  const uid = String(body.uid || "").trim();
  if (uid) return uid;
  const username = String(body.username || body.target || "").trim().toLowerCase().replace(/^@/, "");
  if (!username) throw new HttpError(400, "MISSING_TARGET", "Provide a uid or username");
  const resolved = (await rtdb().ref(`usernames/${username}`).once("value")).val();
  if (typeof resolved !== "string" || !resolved) {
    throw new HttpError(404, "USER_NOT_FOUND", `No user with username "${username}"`);
  }
  return resolved;
}
function rulesFromTemplate(t) {
  return {
    dailyLossLimitPct: t.dailyLossLimitPct ?? null,
    maxDrawdownPct: t.maxDrawdownPct ?? null,
    profitTargetPct: t.profitTargetPct ?? null,
    minTradingDays: t.minTradingDays || 0,
    maxLotsTotal: t.maxLotsTotal ?? null,
    maxLotsPerOrder: t.maxLotsPerOrder ?? null,
    maxOpenPositions: t.maxOpenPositions ?? null,
    maxTradingDays: t.maxTradingDays ?? null
  };
}
async function assignChallengeAccount(admin2, body) {
  const uid = await resolveTargetUid(body);
  const typeId = String(body.typeId || "").trim();
  const snap = await challengeTypesCol().doc(typeId).get();
  if (!snap.exists) throw new HttpError(404, "NO_CHALLENGE_TYPE", "Challenge type not found");
  const t = { id: snap.id, ...snap.data() };
  if (t.active === false) throw new HttpError(409, "CHALLENGE_INACTIVE", "This challenge type is deactivated");
  const account = await createAccount(uid, t.name.slice(0, 32), t.size, {
    leverage: t.leverage,
    rules: rulesFromTemplate(t),
    challengeTypeId: t.id,
    challengeName: t.name
  });
  await writeAudit(admin2, "account_assign", { uid, aid: account.id, challengeTypeId: t.id, name: t.name, size: t.size });
  return { uid, account };
}
async function traderNames() {
  try {
    const snap = await rtdb().ref("usernames").once("value");
    const map = snap.val() || {};
    const out = {};
    for (const [name, uid] of Object.entries(map)) if (typeof uid === "string") out[uid] = name;
    return out;
  } catch {
    return {};
  }
}
async function listAllChallengeAccounts(status) {
  const snap = await firestore().collectionGroup("accounts").where("type", "==", "CHALLENGE").limit(300).get();
  const names = await traderNames();
  const rows = [];
  for (const doc of snap.docs) {
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    const a = doc.data() || {};
    const startingBalance = Number(a.startingBalance) || 0;
    const balance = Number(a.balance) || 0;
    const row = {
      uid,
      aid: doc.id,
      label: a.label || "CHALLENGE",
      challengeName: a.challengeName ?? null,
      challengeTypeId: a.challengeTypeId ?? null,
      balance,
      startingBalance,
      profitPct: startingBalance > 0 ? Math.round((balance - startingBalance) / startingBalance * 1e4) / 100 : 0,
      status: a.status || "active",
      adminSuspended: !!a.adminSuspended,
      failedReason: a.failedReason ?? null,
      stats: a.stats || { totalTrades: 0, wins: 0, losses: 0 },
      tradingDays: Object.keys(a.tradingDays || {}).length,
      startedAt: a.startedAt ?? a.createdAt ?? null,
      createdAt: a.createdAt || 0,
      traderName: names[uid] ? `@${names[uid]}` : `trader ${uid.slice(0, 6)}`
    };
    if (status && status !== "all") {
      const wanted = status === "suspended" ? row.adminSuspended : row.status === status && !row.adminSuspended;
      if (!wanted) continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}
async function accountDetail(uid, aid) {
  const db2 = firestore();
  const accRef = db2.collection("users").doc(uid).collection("accounts").doc(aid);
  const [accSnap, posSnap, ordSnap, tradeSnap] = await Promise.all([
    accRef.get(),
    accRef.collection("positions").get(),
    accRef.collection("orders").get(),
    accRef.collection("trades").orderBy("closedAt", "desc").limit(50).get()
  ]);
  if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const account = accSnap.data() || {};
  const positions = posSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const orders = ordSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const trades = tradeSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const symbols = [.../* @__PURE__ */ new Set([...positions.map((p) => p.symbol), ...orders.map((o) => o.symbol)])];
  const quotes = symbols.length ? await getQuotes(symbols) : {};
  const prices = {};
  for (const [sym, q] of Object.entries(quotes)) prices[sym] = q.mid;
  const metrics = computeMetrics(
    Number(account.balance) || 0,
    positions,
    quotes,
    prices,
    Number(account.leverage) || 100
  );
  const names = await traderNames();
  return {
    uid,
    aid,
    traderName: names[uid] ? `@${names[uid]}` : `trader ${uid.slice(0, 6)}`,
    account: {
      label: account.label,
      type: account.type,
      challengeName: account.challengeName ?? null,
      challengeTypeId: account.challengeTypeId ?? null,
      balance: account.balance,
      startingBalance: account.startingBalance,
      leverage: account.leverage,
      status: account.status || "active",
      adminSuspended: !!account.adminSuspended,
      rules: account.rules ?? null,
      failedReason: account.failedReason ?? null,
      startedAt: account.startedAt ?? account.createdAt ?? null,
      createdAt: account.createdAt,
      peakEquity: account.peakEquity ?? account.balance,
      tradingDays: Object.keys(account.tradingDays || {}).length,
      stats: account.stats || { totalTrades: 0, wins: 0, losses: 0 },
      dayStart: account.dayStart || {}
    },
    positions,
    orders,
    trades,
    metrics
  };
}
async function setAccountState(admin2, body) {
  const uid = String(body.uid || "").trim();
  const aid = String(body.aid || "").trim();
  const action = String(body.action || "");
  if (!uid || !aid) throw new HttpError(400, "BAD_TARGET", "uid and aid are required");
  const accRef = firestore().collection("users").doc(uid).collection("accounts").doc(aid);
  const snap = await accRef.get();
  if (!snap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const acc = snap.data() || {};
  if (action === "suspend") {
    await accRef.update({ adminSuspended: true, suspendedAt: Date.now() });
    await writeAudit(admin2, "account_suspend", { uid, aid, challengeName: acc.challengeName ?? null });
    return { ok: true, adminSuspended: true };
  }
  if (action === "reactivate") {
    if (acc.status === "failed") {
      throw new HttpError(409, "ACCOUNT_FAILED", "A failed challenge can only be restored via Reset");
    }
    await accRef.update({ adminSuspended: false, suspendedAt: null });
    await writeAudit(admin2, "account_reactivate", { uid, aid });
    return { ok: true, adminSuspended: false };
  }
  if (action === "reset") {
    const closeResult = await closeAll(uid, aid).catch((e) => {
      if (String(e?.message || "").includes("No executable price")) throw e;
      return null;
    });
    await resetAccount(uid, aid);
    await writeAudit(admin2, "account_reset", { uid, aid, closed: Array.isArray(closeResult?.closed) ? closeResult.closed.length : 0 });
    return { ok: true, reset: true };
  }
  throw new HttpError(400, "BAD_ACTION", "action must be suspend | reactivate | reset");
}
async function writeAudit(admin2, action, details = {}) {
  try {
    await auditCol().add({
      at: Date.now(),
      by: admin2.email || admin2.uid,
      byUid: admin2.uid,
      action,
      ...details
    });
  } catch (e) {
    console.error("[admin] audit write failed", e);
  }
}
async function listAudit(filter = {}, limit = 100) {
  let q = auditCol();
  if (filter.uid) q = q.where("uid", "==", filter.uid);
  if (filter.aid) q = q.where("aid", "==", filter.aid);
  const snap = await q.limit(Math.min(300, Math.max(1, limit))).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return rows.slice(0, limit);
}
async function setLeaderboardEnabled(enabled, admin2) {
  await settingsDoc().set({ enabled: !!enabled, updatedAt: Date.now(), updatedBy: admin2.email || admin2.uid });
  await writeAudit(admin2, "leaderboard_toggle", { enabled: !!enabled });
  return { enabled: !!enabled };
}
async function getLeaderboardEnabled() {
  try {
    const snap = await settingsDoc().get();
    return snap.exists ? snap.data()?.enabled !== false : true;
  } catch {
    return true;
  }
}

// api/_src/trading/leaderboard.ts
init_firebase();
var PERIOD_MS = {
  daily: 864e5,
  weekly: 7 * 864e5,
  monthly: 30 * 864e5,
  all: 0
};
function periodStart(period) {
  if (period === "daily") {
    const d = /* @__PURE__ */ new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (period === "weekly") return Date.now() - PERIOD_MS.weekly;
  if (period === "monthly") return Date.now() - PERIOD_MS.monthly;
  return 0;
}
function isPeriod(v) {
  return v === "daily" || v === "weekly" || v === "monthly" || v === "all";
}
async function traderNames2() {
  try {
    const snap = await rtdb().ref("usernames").once("value");
    const map = snap.val() || {};
    const out = {};
    for (const [name, uid] of Object.entries(map)) if (typeof uid === "string") out[uid] = name;
    return out;
  } catch {
    return {};
  }
}
async function getLeaderboard(period) {
  const enabled = await getLeaderboardEnabled();
  if (!enabled) return { enabled: false, period, rows: [] };
  const start = periodStart(period);
  const snap = await firestore().collectionGroup("trades").where("closedAt", ">=", start).limit(2e3).get();
  const byAccount = /* @__PURE__ */ new Map();
  for (const doc of snap.docs) {
    const parent = doc.ref.parent.parent;
    if (!parent) continue;
    const t = doc.data() || {};
    const key = parent.path;
    const cur = byAccount.get(key) || { net: 0, trades: 0, wins: 0, ref: parent };
    const net = (Number(t.pnl) || 0) + (Number(t.swap) || 0);
    cur.net += net;
    cur.trades += 1;
    if (net > 0) cur.wins += 1;
    byAccount.set(key, cur);
  }
  const accounts = [];
  const parents = [...byAccount.values()];
  const accSnaps = await Promise.all(parents.map((p) => p.ref.get()));
  for (let i = 0; i < parents.length; i++) {
    const data = accSnaps[i].data() || {};
    if (data.type !== "CHALLENGE") continue;
    const p = parents[i];
    accounts.push({
      uid: p.ref.parent.parent?.id || "",
      startingBalance: Number(data.startingBalance) || 0,
      status: data.status || "active",
      challengeName: data.challengeName ?? null,
      net: Math.round(p.net * 100) / 100,
      trades: p.trades,
      wins: p.wins
    });
  }
  const names = await traderNames2();
  const ranked = accounts.filter((a) => a.startingBalance > 0).map((a) => ({
    name: names[a.uid] ? `@${names[a.uid]}` : "Trader",
    profitPct: Math.round(a.net / a.startingBalance * 1e4) / 100,
    profitUsd: a.net,
    winRate: a.trades > 0 ? Math.round(a.wins / a.trades * 1e3) / 10 : null,
    trades: a.trades,
    status: a.status,
    size: a.startingBalance,
    challengeName: a.challengeName
  })).sort((x, y) => y.profitPct - x.profitPct || y.profitUsd - x.profitUsd).slice(0, 50);
  const rows = ranked.map((r, i) => ({ rank: i + 1, ...r }));
  return { enabled: true, period, rows };
}

// api/_src/trading/index.ts
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function getAction(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
  }
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return String(body?.action || "");
}
function bodyOf(req) {
  return typeof req.body === "string" ? safeParse(req.body) : req.body || {};
}
function requireAccountId(body) {
  const id = String(body?.accountId || "");
  if (!id) throw Object.assign(new Error("accountId is required"), { status: 400 });
  return id;
}
async function health(res) {
  json(res, 200, { status: "ok", version: "trading-1", functions: 12, time: (/* @__PURE__ */ new Date()).toISOString() });
}
async function requireAccountAccess(_user, uid, accountId) {
  if (!accountId) throw Object.assign(new Error("accountId is required"), { status: 400 });
  void _user;
}
var routes = {
  async accounts(_req, res, user) {
    json(res, 200, { accounts: await listAccounts(user.uid) });
  },
  async history(req, res, user, body) {
    const url = new URL(req.url || "/", "http://localhost");
    const accountId = String(url.searchParams.get("accountId") || body.accountId || "");
    await requireAccountAccess(user, user.uid, accountId);
    const limit = Number(url.searchParams.get("limit") || body.limit || 100);
    json(res, 200, { trades: await history(user.uid, accountId, limit) });
  },
  async create(_req, res, user, body) {
    json(res, 200, { account: await createAccount(user.uid, body.label, body.startingBalance, {
      leverage: body.leverage != null ? Number(body.leverage) : null,
      rules: body.rules ?? null
    }) });
  },
  async order(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    const result = await placeOrder(user.uid, {
      accountId: String(body.accountId),
      symbol: String(body.symbol || ""),
      side: body.side,
      lots: Number(body.lots),
      kind: body.kind,
      price: body.price != null ? Number(body.price) : null,
      sl: body.sl != null && body.sl !== "" ? Number(body.sl) : null,
      tp: body.tp != null && body.tp !== "" ? Number(body.tp) : null,
      comment: body.comment
    });
    json(res, 200, result);
  },
  async close(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.positionId) throw Object.assign(new Error("positionId is required"), { status: 400 });
    const result = await closePosition(
      user.uid,
      String(body.accountId),
      String(body.positionId),
      body.lots != null ? Number(body.lots) : null
    );
    json(res, 200, result);
  },
  async "close-all"(req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    json(res, 200, await closeAll(user.uid, String(body.accountId)));
  },
  async modify(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.positionId) throw Object.assign(new Error("positionId is required"), { status: 400 });
    const result = await modifyPosition(
      user.uid,
      String(body.accountId),
      String(body.positionId),
      body.sl !== void 0 ? body.sl : void 0,
      body.tp !== void 0 ? body.tp : void 0
    );
    json(res, 200, result);
  },
  async "modify-order"(req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.orderId) throw Object.assign(new Error("orderId is required"), { status: 400 });
    const numOrNull = (v) => v == null || v === "" ? null : Number(v);
    const numOrUndef = (v) => v == null || v === "" ? void 0 : Number(v);
    json(res, 200, await modifyOrder(user.uid, String(body.accountId), String(body.orderId), {
      price: numOrUndef(body.price),
      lots: numOrUndef(body.lots),
      sl: body.sl !== void 0 ? numOrNull(body.sl) : void 0,
      tp: body.tp !== void 0 ? numOrNull(body.tp) : void 0
    }));
  },
  async cancel(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.orderId) throw Object.assign(new Error("orderId is required"), { status: 400 });
    json(res, 200, await cancelOrder(user.uid, String(body.accountId), String(body.orderId)));
  },
  async evaluate(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    json(res, 200, await evaluate(user.uid, String(body.accountId)));
  },
  async reset(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    json(res, 200, await resetAccount(user.uid, String(body.accountId)));
  },
  // ---- user-facing prop-firm surface ---------------------------------------
  async "challenge-types"(_req, res) {
    json(res, 200, { types: await listChallengeTypes(true) });
  },
  async leaderboard(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const periodRaw = String(url.searchParams.get("period") || "all");
    const period = isPeriod(periodRaw) ? periodRaw : "all";
    try {
      json(res, 200, await getLeaderboard(period));
    } catch (e) {
      console.error("[api] leaderboard failed:", e?.code, e?.message);
      json(res, 500, { error: "INTERNAL", code: e?.code || null, message: e?.message || "leaderboard failed" });
    }
  }
};
var ADMIN_GET_ACTIONS = /* @__PURE__ */ new Set(["admin-challenge-types", "admin-accounts", "admin-account-detail", "admin-audit", "admin-trades"]);
var adminRoutes = {
  async "admin-challenge-types"(_req, res) {
    json(res, 200, { types: await listChallengeTypes(false) });
  },
  async "admin-challenge-type-save"(_req, res, admin2, body) {
    json(res, 200, await saveChallengeType(body, admin2));
  },
  async "admin-challenge-type-delete"(_req, res, admin2, body) {
    json(res, 200, await deleteChallengeType(String(body?.id || ""), admin2));
  },
  async "admin-accounts"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    json(res, 200, { accounts: await listAllChallengeAccounts(url.searchParams.get("status") || "all") });
  },
  async "admin-account-detail"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const uid = String(url.searchParams.get("uid") || "");
    const aid = String(url.searchParams.get("aid") || "");
    if (!uid || !aid) throw Object.assign(new Error("uid and aid are required"), { status: 400 });
    json(res, 200, await accountDetail(uid, aid));
  },
  async "admin-assign"(_req, res, admin2, body) {
    json(res, 200, await assignChallengeAccount(admin2, body));
  },
  async "admin-account-action"(_req, res, admin2, body) {
    json(res, 200, await setAccountState(admin2, body));
  },
  async "admin-leaderboard-toggle"(_req, res, admin2, body) {
    json(res, 200, await setLeaderboardEnabled(!!body?.enabled, admin2));
  },
  async "admin-audit"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    json(res, 200, { entries: await listAudit({
      uid: url.searchParams.get("uid") || void 0,
      aid: url.searchParams.get("aid") || void 0
    }, Number(url.searchParams.get("limit") || 100)) });
  },
  async "admin-trades"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const uid = String(url.searchParams.get("uid") || "");
    const aid = String(url.searchParams.get("aid") || "");
    if (!uid || !aid) throw Object.assign(new Error("uid and aid are required"), { status: 400 });
    const limit = Number(url.searchParams.get("limit") || 200);
    const db2 = (await Promise.resolve().then(() => (init_firebase(), firebase_exports))).firestore();
    const snap = await db2.collection("users").doc(uid).collection("accounts").doc(aid).collection("trades").orderBy("closedAt", "desc").limit(Math.min(500, Math.max(1, limit))).get();
    json(res, 200, { trades: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  }
};
var index_default = handle(async (req, res) => {
  const action = getAction(req);
  if (!action) return health(res);
  if (action.startsWith("admin-")) {
    const route2 = adminRoutes[action];
    if (!route2) return json(res, 400, { error: "BAD_ACTION", message: "Unknown admin action" });
    if (!ADMIN_GET_ACTIONS.has(action)) assertPost(req);
    const admin2 = await requireAdmin(req);
    return route2(req, res, admin2, bodyOf(req));
  }
  const route = routes[action];
  if (!route) {
    return json(res, 400, { error: "BAD_ACTION", message: "Unknown trading action" });
  }
  if (action === "history" || action === "challenge-types" || action === "leaderboard") {
    const user2 = await requireUser(req);
    return route(req, res, user2, {});
  }
  assertPost(req);
  const user = await requireUser(req);
  return route(req, res, user, bodyOf(req));
});
export {
  index_default as default
};
