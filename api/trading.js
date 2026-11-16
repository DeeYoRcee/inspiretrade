import { createRequire as __cR } from 'module';
const require = __cR(import.meta.url);

// api/_src/lib/firebase.ts
import * as adminNamespace from "firebase-admin";
var admin = adminNamespace.default ?? adminNamespace;
var HttpError = class extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
};
var app = null;
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
function firestore() {
  ensureApp();
  return admin.firestore();
}

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
function applyEvaluationTx(tx, uid, aid, state, quotes, prices) {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
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
    const pnl = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    closed.push({
      symbol: pos.symbol,
      side: pos.side,
      lots: pos.lots,
      entry: pos.entry,
      exit,
      pnl,
      reason,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      positionId: pos.id
    });
    tx.delete(posCol(uid, aid).doc(pos.id));
    state.positions = state.positions.filter((p) => p.id !== pos.id);
  }
  for (const o of closed) writeTradeDoc(tx, uid, aid, o);
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
      openedAt: Date.now()
    };
    tx.set(posRef, { symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, sl: pos.sl, tp: pos.tp, openedAt: pos.openedAt });
    tx.delete(ordCol(uid, aid).doc(order.id));
    state.orders = state.orders.filter((o) => o.id !== order.id);
    state.positions.push(pos);
  }
  const today = dayKey();
  const dayStart = { ...state.account.dayStart || {} };
  if (dayStart[today] == null) dayStart[today] = state.account.balance;
  state.account.dayStart = dayStart;
  return { closed, filled: result.fills.length };
}
function persistAccountTx(tx, uid, aid, state, quotes, prices) {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
  tx.update(accountsCol(uid).doc(aid), {
    balance: state.account.balance,
    dayStart: state.account.dayStart,
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
  const out = [];
  for (const doc of snap.docs) {
    const state = await readState(uid, doc.id);
    const { quotes, prices } = await quotesForState(state);
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, state.account.leverage || DEFAULT_LEVERAGE);
    out.push({
      id: doc.id,
      label: state.account.label,
      type: state.account.type,
      balance: state.account.balance,
      startingBalance: state.account.startingBalance,
      leverage: state.account.leverage,
      createdAt: state.account.createdAt,
      dayStart: state.account.dayStart ?? {},
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
async function createAccount(uid, label, startingBalance) {
  const existing = await accountsCol(uid).get();
  if (existing.size >= MAX_ACCOUNTS) throw new HttpError(409, "TOO_MANY_ACCOUNTS", `Maximum ${MAX_ACCOUNTS} accounts`);
  const balance = Math.round(Math.min(5e6, Math.max(1e3, Number(startingBalance) || 1e5)) * 100) / 100;
  const today = dayKey();
  const doc = {
    label: String(label || "DEMO").slice(0, 32) || "DEMO",
    type: "DEMO",
    balance,
    startingBalance: balance,
    leverage: DEFAULT_LEVERAGE,
    status: "active",
    createdAt: Date.now(),
    dayStart: { [today]: balance }
  };
  const ref = await accountsCol(uid).add(doc);
  return { id: ref.id, ...doc, metrics: computeMetrics(balance, [], {}, {}, DEFAULT_LEVERAGE), positions: [], orders: [] };
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
    const quote = requireQuote(quotes, spec.symbol);
    const v = validateNewOrder({
      spec,
      side: req.side,
      kind,
      lots: Number(req.lots),
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
        lots: Number(req.lots),
        entry: v.entry,
        sl: req.sl ?? null,
        tp: req.tp ?? null,
        openedAt: Date.now(),
        comment: String(req.comment || "").slice(0, 120) || null
      };
      tx.set(posRef, pos);
      const m2 = computeMetrics(state.account.balance, [...state.positions, { id: posRef.id, ...pos }], quotes, prices, leverage);
      tx.update(accRef, {
        dayStart: state.account.dayStart,
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
      lots: Number(req.lots),
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
    const pnl = positionPnlUsd(spec, pos.side, closeLots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    const outcome = {
      symbol: pos.symbol,
      side: pos.side,
      lots: closeLots,
      entry: pos.entry,
      exit,
      pnl,
      reason: "manual",
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      positionId: pos.id
    };
    writeTradeDoc(tx, uid, accountId, outcome);
    if (closeLots === pos.lots) {
      tx.delete(posCol(uid, accountId).doc(pos.id));
      state.positions = state.positions.filter((p) => p.id !== pos.id);
    } else {
      const remaining = Math.round((pos.lots - closeLots) * 100) / 100;
      tx.update(posCol(uid, accountId).doc(pos.id), { lots: remaining });
      pos.lots = remaining;
    }
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { closed: outcome, metrics, exit, quote };
  });
}
async function modifyPosition(uid, accountId, positionId, sl, tp) {
  const snap = await posCol(uid, accountId).doc(positionId).get();
  const data = snap.data();
  if (!data) throw new HttpError(404, "NO_POSITION", "Position not found");
  const entry = Number(data.entry);
  const num = (x) => x == null || x === "" ? null : Number(x);
  const slNum = num(sl), tpNum = num(tp);
  const side = data.side;
  if (slNum != null && !Number.isFinite(slNum)) throw new HttpError(400, "BAD_SL", "Invalid Stop Loss");
  if (tpNum != null && !Number.isFinite(tpNum)) throw new HttpError(400, "BAD_TP", "Invalid Take Profit");
  if (side === "buy") {
    if (slNum != null && slNum >= entry) throw new HttpError(400, "BAD_SL", "For a BUY, Stop Loss must be below the entry price");
    if (tpNum != null && tpNum <= entry) throw new HttpError(400, "BAD_TP", "For a BUY, Take Profit must be above the entry price");
  } else {
    if (slNum != null && slNum <= entry) throw new HttpError(400, "BAD_SL", "For a SELL, Stop Loss must be above the entry price");
    if (tpNum != null && tpNum >= entry) throw new HttpError(400, "BAD_TP", "For a SELL, Take Profit must be below the entry price");
  }
  const patch = { slModifiedAt: Date.now() };
  if (sl !== void 0) patch.sl = slNum;
  if (tp !== void 0) patch.tp = tpNum;
  await posCol(uid, accountId).doc(positionId).update(patch);
  return { ok: true, ...patch, sl: slNum, tp: tpNum };
}
async function cancelOrder(uid, accountId, orderId) {
  const ref = ordCol(uid, accountId).doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "NO_ORDER", "Order not found");
  await ref.delete();
  return { ok: true };
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
    json(res, 200, { account: await createAccount(user.uid, body.label, body.startingBalance) });
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
  }
};
var index_default = handle(async (req, res) => {
  const action = getAction(req);
  if (!action) return health(res);
  const route = routes[action];
  if (!route) {
    return json(res, 400, { error: "BAD_ACTION", message: "Unknown trading action" });
  }
  if (action === "history") {
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
