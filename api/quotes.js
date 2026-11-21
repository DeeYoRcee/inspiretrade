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

// shared/feed-validation.ts
function parseShardRow(row) {
  if (!row) return null;
  let a;
  if (row.charCodeAt(0) === 91) {
    try {
      const v = JSON.parse(row);
      if (!Array.isArray(v)) return null;
      a = v;
    } catch {
      return null;
    }
  } else {
    const c = row.split(",");
    a = [c[0], c[1], c[2], c[3], c[4], c[5]];
  }
  const t = Number(a[0]), o = Number(a[1]), h = Number(a[2]), l = Number(a[3]), c2 = Number(a[4]);
  if (![t, o, h, l, c2].every(Number.isFinite)) return null;
  if (t <= 0 || o <= 0 || h < Math.max(o, c2) || l > Math.min(o, c2)) return null;
  return [t, o, h, l, c2, Number(a[5]) || 0];
}
var finitePositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
function checkBar(b) {
  const { open: o, high: h, low: l, close: c } = b;
  if (![o, h, l, c].every(finitePositive)) {
    return { ok: false, repaired: false, reason: "non-finite-price" };
  }
  if (h < l) return { ok: false, repaired: false, reason: "high-low-inverted" };
  if (h < Math.max(o, c)) return { ok: true, repaired: true, reason: "high-below-body" };
  if (l > Math.min(o, c)) return { ok: true, repaired: true, reason: "low-above-body" };
  return { ok: true, repaired: false };
}
function validateBars(bars) {
  const out = [];
  let invalid = 0;
  let repaired = 0;
  for (const b of bars) {
    const check = checkBar(b);
    if (!check.ok) {
      invalid++;
      continue;
    }
    if (check.repaired) {
      repaired++;
      out.push({
        ...b,
        high: Math.max(b.high, b.open, b.close),
        low: Math.min(b.low, b.open, b.close)
      });
      continue;
    }
    out.push(b);
  }
  return { bars: out, invalid, repaired };
}
function alignAndDedupe(bars, sec) {
  const byTime = /* @__PURE__ */ new Map();
  let dropped = 0;
  let aligned = 0;
  for (const b of bars) {
    const bucket = bucketStart(b.time, sec);
    const time = bucket !== b.time ? bucket : b.time;
    if (bucket !== b.time) aligned++;
    const bar = time === b.time ? b : { ...b, time };
    const prev = byTime.get(time);
    if (!prev) {
      byTime.set(time, bar);
      continue;
    }
    dropped++;
    const range = (x) => x.high - x.low;
    const vol = (x) => typeof x.volume === "number" && x.volume > 0 ? 1 : 0;
    if (range(bar) > range(prev)) byTime.set(time, bar);
    else if (range(bar) === range(prev) && vol(bar) > vol(prev)) byTime.set(time, bar);
  }
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { bars: out, dropped, aligned };
}
function bucketStart(nowSec, sec) {
  if (sec === 604800) {
    const MONDAY_ANCHOR = 345600;
    return Math.floor((nowSec - MONDAY_ANCHOR) / sec) * sec + MONDAY_ANCHOR;
  }
  if (sec >= 86400) return Math.floor(nowSec / 86400) * 86400;
  return Math.floor(nowSec / sec) * sec;
}
function spotMergeGuard(bars, spot, g) {
  if (!bars.length) return { ok: false, reason: "empty-bars" };
  const now = g.nowSec ?? Math.floor(Date.now() / 1e3);
  const bucket = bucketStart(now, g.sec);
  const last = bars[bars.length - 1];
  if (Math.abs(bucket - last.time) > g.sec) return { ok: false, reason: "stale-history" };
  const maxDev = g.maxDeviationPct ?? 0.02;
  if (last.close > 0 && Math.abs(spot / last.close - 1) > maxDev) {
    return { ok: false, reason: "spot-outlier" };
  }
  return { ok: true };
}
function minuteIslandFilter(bars, jumpPct = 0.02, maxIslandSec = 6 * 3600) {
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const out = [];
  const ranges = [];
  let rejected = 0;
  const n = sorted.length;
  if (n < 3) return { bars: sorted, rejected, ranges };
  const PLATEAU_BAND = 75e-4;
  const STUCK_RANGE_PCT = 2e-4;
  let keepFrom = 0;
  for (let j1 = 1; j1 < n; j1++) {
    const prev = sorted[j1 - 1].close;
    if (!(prev > 0) || Math.abs(sorted[j1].close / prev - 1) <= jumpPct) continue;
    if (j1 < keepFrom) continue;
    let j2 = j1 + 1;
    while (j2 < n && sorted[j2].time - sorted[j1].time <= maxIslandSec && Math.abs(sorted[j2].close / sorted[j1].close - 1) <= PLATEAU_BAND) j2++;
    const island = sorted.slice(j1, j2);
    const anchor = sorted[j1 - 1].close;
    const meanClose = island.reduce((s, x) => s + x.close, 0) / island.length;
    const islandDev = Math.abs(meanClose / anchor - 1);
    const meanRange = island.reduce((s, x) => s + (x.high - x.low), 0) / island.length;
    const stuck = meanRange / meanClose < STUCK_RANGE_PCT;
    const returnDev = j2 < n ? Math.abs(sorted[j2].close / anchor - 1) : Infinity;
    if (stuck && islandDev > jumpPct / 2 && returnDev < islandDev) {
      out.push(...sorted.slice(keepFrom, j1));
      rejected += island.length;
      ranges.push({ from: island[0].time, to: island[island.length - 1].time });
      keepFrom = j2;
      j1 = j2 - 1;
    }
  }
  out.push(...sorted.slice(keepFrom));
  return { bars: out, rejected, ranges };
}
function flatShare(bars) {
  if (!bars.length) return 0;
  let flat = 0;
  for (const b of bars) {
    if (b.open === b.high && b.high === b.low && b.low === b.close) flat++;
  }
  return flat / bars.length;
}
function repairOutlierExtremes(bars, minBars = 5) {
  const out = bars.map((b) => ({ ...b }));
  let repairedHigh = 0;
  let repairedLow = 0;
  if (out.length < minBars) return { bars: out, repairedHigh, repairedLow };
  const diffs = [];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1].close;
    const b = out[i].close;
    if (a > 0 && b > 0) diffs.push(Math.abs(b / a - 1));
  }
  diffs.sort((x, y) => x - y);
  const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  const K = Math.max(0.012, med * 6);
  const finitePos = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
  for (let i = 0; i < out.length; i++) {
    const prev = out[i - 1];
    const next = out[i + 1];
    const hiRefs = [prev?.high, next?.high].filter(finitePos);
    const loRefs = [prev?.low, next?.low].filter(finitePos);
    if (!hiRefs.length || !loRefs.length) continue;
    const refHi = Math.max(...hiRefs);
    const refLo = Math.min(...loRefs);
    const b = out[i];
    const bodyHi = Math.max(b.open, b.close);
    const bodyLo = Math.min(b.open, b.close);
    const bodyInsideNeighbourhood = bodyHi <= refHi * (1 + K) && bodyLo >= refLo * (1 - K);
    if (!bodyInsideNeighbourhood) continue;
    if (b.high > refHi * (1 + K)) {
      b.high = bodyHi;
      repairedHigh++;
    }
    if (b.low < refLo * (1 - K)) {
      b.low = bodyLo;
      repairedLow++;
    }
  }
  return { bars: out, repairedHigh, repairedLow };
}
function staleRunFilter(bars, opts) {
  const minRunSec = opts?.minRunSec ?? 45 * 60;
  const flatPct = opts?.flatPct ?? 5e-4;
  const stepPct = opts?.stepPct ?? 1e-3;
  const confirmSec = opts?.confirmSec ?? 30 * 60;
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const ranges = [];
  let rejected = 0;
  const n = sorted.length;
  if (n < 8) return { bars: sorted, rejected, ranges };
  const drop = /* @__PURE__ */ new Set();
  let i = 1;
  while (i < n) {
    const stepIn = sorted[i - 1].close > 0 ? Math.abs(sorted[i].close / sorted[i - 1].close - 1) : 0;
    const rngIn = sorted[i].close > 0 ? (sorted[i].high - sorted[i].low) / sorted[i].close : 0;
    if (stepIn > flatPct || rngIn > flatPct) {
      i++;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < n) {
      const prev = sorted[j - 1];
      const cur = sorted[j];
      const step = prev.close > 0 ? Math.abs(cur.close / prev.close - 1) : 0;
      const rng = cur.close > 0 ? (cur.high - cur.low) / cur.close : 0;
      if (step > flatPct || rng > flatPct) break;
      j++;
    }
    const runSec = j - 1 > start ? sorted[j - 1].time - sorted[start].time : 0;
    if (runSec >= minRunSec && j < n) {
      const run = sorted.slice(start, j);
      const runMean = run.reduce((s, x) => s + x.close, 0) / run.length;
      const exitStep = sorted[j - 1].close > 0 ? Math.abs(sorted[j].close / sorted[j - 1].close - 1) : 0;
      let aliveBefore = false;
      for (let k = start; k > 0 && sorted[start].time - sorted[k - 1].time <= 3600; k--) {
        const a = sorted[k - 1].close;
        const b = sorted[k].close;
        if (a > 0 && Math.abs(b / a - 1) > flatPct * 2) {
          aliveBefore = true;
          break;
        }
      }
      const band = runMean * flatPct;
      let returned = false;
      for (let k = j; k < n && sorted[k].time - sorted[j - 1].time <= confirmSec; k++) {
        if (Math.abs(sorted[k].close - runMean) <= band) {
          returned = true;
          break;
        }
      }
      const postShift = runMean > 0 ? Math.abs(sorted[n - 1].close / runMean - 1) : 0;
      if (aliveBefore && exitStep >= stepPct && !returned && postShift >= stepPct) {
        for (let k = start; k < j; k++) drop.add(k);
        rejected += run.length;
        ranges.push({ from: run[0].time, to: run[run.length - 1].time });
        i = j + 1;
        continue;
      }
    }
    i = j > i ? j + 1 : i + 1;
  }
  if (!rejected) return { bars: sorted, rejected, ranges };
  return { bars: sorted.filter((_, k) => !drop.has(k)), rejected, ranges };
}

// shared/terminal.ts
var INSTRUMENTS = [
  // ---- Metals — SPOT prices only. Yahoo has no spot gold/silver symbol
  // (XAUUSD=X 404s), so history comes from stooq's spot CSV (primary) with
  // Yahoo's COMEX contract as a LAST-RESORT fallback that the badge labels
  // explicitly as futures. The live tail is gold-api's keyless spot feed.
  // PAXGUSDT / XAUTUSDT are tokenized assets (~0.4% below spot) and are
  // deliberately NOT used — they are different financial instruments.
  { symbol: "XAUUSD", name: "Gold Spot / U.S. Dollar", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes", yahoo: "GC=F", spotCode: "XAU", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 0.01, priceBand: [1e3, 2e4], feedLabel: "gold-api spot (chart + execution) \xB7 history stooq (spot)" },
  { symbol: "XAGUSD", name: "Silver Spot / U.S. Dollar", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5e3, quote: "USD", feed: "quotes", yahoo: "SI=F", spotCode: "XAG", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-3, priceBand: [5, 200], feedLabel: "gold-api spot (chart + execution) \xB7 history stooq (spot)" },
  // ---- Forex majors — TrueFX prices the 10 majors LIVE (genuine bid/ask:
  // the chart paints BID to match Dukascopy's BID-side history, execution
  // quotes take the mid). Yahoo's FX identifiers are the genuine interbank
  // spot market but delayed by Yahoo's distribution — they supply history
  // and the execution fallback for pairs TrueFX does not carry (NZDUSD).
  { symbol: "EURUSD", name: "Euro / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "EURUSD=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-5, priceBand: [0.5, 2], feedLabel: "TrueFX live \xB7 Yahoo history (delayed)" },
  { symbol: "GBPUSD", name: "British Pound / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-5, priceBand: [0.9, 2.2], feedLabel: "TrueFX live \xB7 Yahoo history (delayed)" },
  { symbol: "USDJPY", name: "U.S. Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 1e5, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-3, priceBand: [80, 250], feedLabel: "TrueFX live \xB7 Yahoo history (delayed)" },
  { symbol: "AUDUSD", name: "Australian Dollar / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-5, priceBand: [0.4, 1.3], feedLabel: "TrueFX live \xB7 Yahoo history (delayed)" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-5, priceBand: [0.4, 1.2], feedLabel: "Yahoo FX spot (delayed)" },
  { symbol: "USDCAD", name: "U.S. Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-5, priceBand: [0.9, 2], feedLabel: "TrueFX live \xB7 Yahoo history (delayed)" },
  { symbol: "USDCHF", name: "U.S. Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X", underlier: "spot", session: "Sun 22:00 \u2013 Fri 21:00 UTC (24/5)", tickSize: 1e-5, priceBand: [0.6, 1.6], feedLabel: "TrueFX live \xB7 Yahoo history (delayed)" },
  // ---- Crypto — Binance is the industry-standard price venue. Binance
  // quotes USDT pairs (BTC/USDT), the badge discloses that basis (USDT ≈ USD).
  { symbol: "BTCUSD", name: "Bitcoin / U.S. Dollar", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT", underlier: "spot", session: "24/7", tickSize: 0.01, priceBand: [5e3, 5e5], feedLabel: "Binance \xB7 BTC/USDT (USDT \u2248 USD)" },
  { symbol: "ETHUSD", name: "Ethereum / U.S. Dollar", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT", underlier: "spot", session: "24/7", tickSize: 0.01, priceBand: [100, 2e4], feedLabel: "Binance \xB7 ETH/USDT (USDT \u2248 USD)" },
  { symbol: "SOLUSD", name: "Solana / U.S. Dollar", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT", underlier: "spot", session: "24/7", tickSize: 0.01, priceBand: [5, 2e3], feedLabel: "Binance \xB7 SOL/USDT (USDT \u2248 USD)" },
  { symbol: "XRPUSD", name: "XRP / U.S. Dollar", assetClass: "crypto", digits: 4, pipSize: 1e-4, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT", underlier: "spot", session: "24/7", tickSize: 1e-4, priceBand: [0.05, 20], feedLabel: "Binance \xB7 XRP/USDT (USDT \u2248 USD)" },
  // ---- Indices — CFD reference levels tracked from the underlying index.
  { symbol: "NAS100", name: "US Tech 100 (NDX)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX", underlier: "index", session: "Mon\u2013Fri 13:30\u201320:00 UTC (US cash)", tickSize: 0.25, priceBand: [3e3, 4e4], feedLabel: "Yahoo index (delayed)" },
  { symbol: "US30", name: "Wall Street 30 (DJI)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI", underlier: "index", session: "Mon\u2013Fri 13:30\u201320:00 UTC (US cash)", tickSize: 1, priceBand: [1e4, 8e4], feedLabel: "Yahoo index (delayed)" },
  { symbol: "SPX500", name: "US 500 (S&P 500)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC", underlier: "index", session: "Mon\u2013Fri 13:30\u201320:00 UTC (US cash)", tickSize: 0.25, priceBand: [1500, 15e3], feedLabel: "Yahoo index (delayed)" },
  { symbol: "GER40", name: "Germany 40 (DAX)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI", underlier: "index", session: "Mon\u2013Fri 08:00\u201321:00 UTC (Xetra)", tickSize: 1, priceBand: [5e3, 5e4], feedLabel: "Yahoo index (delayed)" },
  { symbol: "UK100", name: "UK 100 (FTSE 100)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE", underlier: "index", session: "Mon\u2013Fri 08:00\u201316:30 UTC (LSE)", tickSize: 0.5, priceBand: [3e3, 2e4], feedLabel: "Yahoo index (delayed)" }
];
function getInstrument(symbol) {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}
function normalizeDailyAnchors(bars) {
  return bars.map((b) => {
    if (b.time % 86400 === 0) return b;
    return { ...b, time: Math.floor((b.time + 12 * 3600) / 86400) * 86400 };
  });
}
function mergeFxStoreDaily(deep, recent) {
  const byTime = /* @__PURE__ */ new Map();
  for (const b of deep) byTime.set(b.time, b);
  for (const b of recent) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
function aggregateBars(bars, factorMinutes) {
  const bucket = factorMinutes * 60;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = Math.floor(b.time / bucket) * bucket;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}
var SPOT_PRICE_BANDS = {
  XAU: getInstrument("XAUUSD")?.priceBand ?? [1e3, 2e4],
  XAG: getInstrument("XAGUSD")?.priceBand ?? [5, 200]
};

// shared/sessions.ts
var SESSIONS = [
  { id: "sydney", city: "Sydney", tz: "Australia/Sydney", flag: "\u{1F1E6}\u{1F1FA}", openMin: 7 * 60, closeMin: 16 * 60 },
  { id: "tokyo", city: "Tokyo", tz: "Asia/Tokyo", flag: "\u{1F1EF}\u{1F1F5}", openMin: 9 * 60, closeMin: 18 * 60 },
  { id: "london", city: "London", tz: "Europe/London", flag: "\u{1F1EC}\u{1F1E7}", openMin: 8 * 60, closeMin: 17 * 60 },
  { id: "newyork", city: "New York", tz: "America/New_York", flag: "\u{1F1FA}\u{1F1F8}", openMin: 8 * 60, closeMin: 17 * 60 }
];
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function tzWallClock(tz, instant) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short"
  });
  const parts = dtf.formatToParts(new Date(instant));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(get("hour")) % 24;
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    h,
    mi: Number(get("minute")),
    s: Number(get("second")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday")))
  };
}
function tzOffsetMs(tz, instant) {
  const w = tzWallClock(tz, instant);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - instant;
}

// shared/market-hours.ts
var HOLIDAYS = {};
var NY = "America/New_York";
var FX_OPEN_DOW = 0;
var FX_OPEN_MIN = 17 * 60;
var FX_CLOSE_DOW = 5;
var FX_CLOSE_MIN = 17 * 60;
var METAL_OPEN_MIN = 18 * 60;
var METAL_BREAK_FROM = 17 * 60;
var METAL_BREAK_TO = 18 * 60;
var INDEX_SESSIONS = {
  NAS100: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  US30: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  SPX500: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  GER40: { tz: "Europe/Berlin", fromMin: 9 * 60, toMin: 17 * 60 + 30 },
  UK100: { tz: "Europe/London", fromMin: 8 * 60, toMin: 16 * 60 + 30 }
};
function isHoliday(symbol, at) {
  const days = HOLIDAYS[symbol];
  if (!days || !days.length) return false;
  const d = tzWallClock("UTC", at);
  const iso = `${String(d.y).padStart(4, "0")}-${String(d.mo).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  return days.includes(iso);
}
function fxWindow(inst, at) {
  const w = tzWallClock(NY, at);
  const mins = w.h * 60 + w.mi;
  const metal = inst.assetClass === "metal";
  if (w.weekday === 6) return { open: false, reason: "weekend" };
  if (w.weekday === FX_CLOSE_DOW && mins >= FX_CLOSE_MIN) return { open: false, reason: "weekend" };
  if (w.weekday === FX_OPEN_DOW && mins < (metal ? METAL_OPEN_MIN : FX_OPEN_MIN)) {
    return { open: false, reason: "weekend" };
  }
  if (metal && w.weekday >= 1 && w.weekday <= 4 && mins >= METAL_BREAK_FROM && mins < METAL_BREAK_TO) {
    return { open: false, reason: "daily-break" };
  }
  return { open: true, reason: "open" };
}
function windowAt(symbol, inst, at) {
  if (!inst) return { open: false, reason: "unknown" };
  if (inst.assetClass === "crypto") return { open: true, reason: "open" };
  if (isHoliday(symbol, at)) return { open: false, reason: "holiday" };
  if (inst.assetClass === "index") {
    const s = INDEX_SESSIONS[symbol];
    if (!s) return { open: true, reason: "open" };
    const w = tzWallClock(s.tz, at);
    const mins = w.h * 60 + w.mi;
    const open = w.weekday >= 1 && w.weekday <= 5 && mins >= s.fromMin && mins < s.toMin;
    return { open, reason: open ? "open" : "weekend" };
  }
  if (inst.assetClass === "forex" || inst.assetClass === "metal") return fxWindow(inst, at);
  return { open: true, reason: "open" };
}
function marketHours(symbol, at = Date.now()) {
  const inst = getInstrument(symbol);
  const w = windowAt(symbol, inst, at);
  return { ...w, nextOpenMs: w.open ? null : nextOpen(symbol, at) };
}
function nextOpen(symbol, at = Date.now()) {
  const inst = getInstrument(symbol);
  if (windowAt(symbol, inst, at).open) return null;
  const step = 15 * 6e4;
  for (let t = Math.ceil(at / step) * step, n = 0; n < 9 * 96; n++, t += step) {
    if (windowAt(symbol, inst, t).open) return t;
  }
  return null;
}
function wallInstantSec(daySec, minutes, tz) {
  const dayMs = daySec * 1e3;
  const guessMs = dayMs + minutes * 6e4;
  const off = tzOffsetMs(tz, guessMs);
  let t = guessMs - off;
  const off2 = tzOffsetMs(tz, t);
  if (off2 !== off) t = guessMs - off2;
  return Math.floor(t / 1e3);
}
function closedIntervals(symbol, fromSec, toSec) {
  const inst = getInstrument(symbol);
  if (!inst) return [];
  const cls = inst.assetClass;
  if (cls === "crypto" || cls !== "forex" && cls !== "metal" && cls !== "index") return [];
  const out = [];
  const fromDay = Math.floor(fromSec / 86400);
  const toDay = Math.floor(toSec / 86400);
  const metal = cls === "metal";
  for (let day = fromDay; day <= toDay; day++) {
    const dayStart = day * 86400;
    const dayEnd = dayStart + 86400;
    const noonMs = dayStart * 1e3 + 12 * 3600 * 1e3;
    if (isHoliday(symbol, noonMs)) {
      out.push({ from: dayStart, to: dayEnd });
      continue;
    }
    if (cls === "index") {
      const s = INDEX_SESSIONS[symbol];
      if (!s) continue;
      const w2 = tzWallClock(s.tz, noonMs);
      if (w2.weekday === 0 || w2.weekday === 6) {
        out.push({ from: dayStart, to: dayEnd });
        continue;
      }
      out.push({ from: dayStart, to: wallInstantSec(dayStart, s.fromMin, s.tz) });
      out.push({ from: wallInstantSec(dayStart, s.toMin, s.tz), to: dayEnd });
      continue;
    }
    const w = tzWallClock(NY, noonMs);
    const openMin = metal && w.weekday === 0 ? METAL_OPEN_MIN : FX_OPEN_MIN;
    if (w.weekday === 6) {
      out.push({ from: dayStart, to: dayEnd });
      continue;
    }
    if (w.weekday === 0) out.push({ from: dayStart, to: wallInstantSec(dayStart, openMin, NY) });
    if (w.weekday === 5) out.push({ from: wallInstantSec(dayStart, FX_CLOSE_MIN, NY), to: dayEnd });
    if (metal && w.weekday >= 1 && w.weekday <= 4) {
      out.push({ from: wallInstantSec(dayStart, METAL_BREAK_FROM, NY), to: wallInstantSec(dayStart, METAL_BREAK_TO, NY) });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}
function filterClosedCandles(symbol, candles) {
  if (!candles.length) return candles;
  const times = candles.map((c) => c.time);
  const intervals = closedIntervals(symbol, Math.min(...times) - 60, Math.max(...times) + 60);
  if (!intervals.length) return candles;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const out = [];
  let k = 0;
  for (const c of sorted) {
    while (k < intervals.length && intervals[k].to <= c.time) k++;
    if (k < intervals.length && c.time >= intervals[k].from && c.time < intervals[k].to) continue;
    out.push(c);
  }
  return out;
}

// api/_src/lib/duka.ts
import { decompress } from "lzma-native";
var DUKA_MAP = {
  EURUSD: "EURUSD",
  GBPUSD: "GBPUSD",
  USDJPY: "USDJPY",
  USDCHF: "USDCHF",
  USDCAD: "USDCAD",
  AUDUSD: "AUDUSD",
  NZDUSD: "NZDUSD",
  EURGBP: "EURGBP",
  EURJPY: "EURJPY",
  EURCHF: "EURCHF",
  EURAUD: "EURAUD",
  EURNZD: "EURNZD",
  EURCAD: "EURCAD",
  GBPJPY: "GBPJPY",
  GBPCHF: "GBPCHF",
  GBPAUD: "GBPAUD",
  GBPCAD: "GBPCAD",
  GBPNZD: "GBPNZD",
  AUDJPY: "AUDJPY",
  AUDNZD: "AUDNZD",
  AUDCAD: "AUDCAD",
  AUDCHF: "AUDCHF",
  NZDJPY: "NZDJPY",
  NZDCAD: "NZDCAD",
  NZDCHF: "NZDCHF",
  CADJPY: "CADJPY",
  CADCHF: "CADCHF",
  CHFJPY: "CHFJPY",
  USDSGD: "USDSGD",
  USDNOK: "USDNOK",
  USDSEK: "USDSEK",
  USDZAR: "USDZAR",
  USDTRY: "USDTRY",
  USDMXN: "USDMXN"
};
var JPY_QUOTE = /* @__PURE__ */ new Set(["USDJPY", "EURJPY", "GBPJPY", "AUDJPY", "NZDJPY", "CADJPY", "CHFJPY"]);
function dukaPoints(code) {
  if (code === "XAUUSD" || code === "XAGUSD") return 1e3;
  return JPY_QUOTE.has(code) ? 1e3 : 1e5;
}
var DUKA_METALS = { XAUUSD: "XAUUSD", XAGUSD: "XAGUSD" };
var DUKA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function fetchDukaDay(dukaSym, day) {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  const url = `https://datafeed.dukascopy.com/datafeed/${dukaSym}/${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/BID_candles_min_1.bi5`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2e4);
    let rateLimited = false;
    try {
      const res = await fetch(url, { headers: { "User-Agent": DUKA_UA }, signal: controller.signal });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100) return buf;
      }
      if (res.status === 429 || res.status === 503) rateLimited = true;
    } catch {
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, rateLimited ? 1200 + attempt * 1800 : 400));
  }
  return null;
}
async function decodeDukaDay(buf, code, day) {
  const raw = await new Promise((resolve) => {
    decompress(buf, (result) => {
      if (result == null) return resolve(Buffer.alloc(0));
      resolve(Buffer.isBuffer(result) ? result : Buffer.from(result));
    });
  }).catch(() => Buffer.alloc(0));
  if (raw.length < 24) return [];
  const div = dukaPoints(code);
  const dayStart = Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 1e3);
  const out = [];
  for (let off = 0; off + 24 <= raw.length; off += 24) {
    const t = dayStart + raw.readInt32BE(off);
    const o = raw.readInt32BE(off + 4) / div;
    const c = raw.readInt32BE(off + 8) / div;
    const l = raw.readInt32BE(off + 12) / div;
    const h = raw.readInt32BE(off + 16) / div;
    const v = raw.readFloatBE(off + 20);
    if (![o, h, l, c].every(Number.isFinite) || !Number.isFinite(v)) continue;
    if (h < Math.max(o, c) || l > Math.min(o, c) || h < l || o <= 0) continue;
    if (h === l && v <= 0) continue;
    if (!Number.isFinite(t) || t % 60 !== 0) continue;
    out.push({ t, o, h, l, c, v: Math.round(v * 100) / 100 });
  }
  return out;
}

// api/_src/lib/hist-sessions.ts
function inMarketHours(tSec, assetClass) {
  const d = new Date(tSec * 1e3);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (assetClass === "crypto") return true;
  if (assetClass === "index") return dow >= 1 && dow <= 5 && mins >= 810 && mins < 1200;
  if (dow === 6) return false;
  if (dow === 5) return mins < (assetClass === "forex" ? 22 * 60 - 5 : 21 * 60);
  if (dow === 0) return mins >= 22 * 60;
  return true;
}
function missingIntervals(bars, tfSec, fromSec, toSec, assetClass, maxReport = 12) {
  if (tfSec <= 0) return { count: 0, sample: [], longestGapSec: 0 };
  const have = new Set(bars.map((b) => b.time));
  const sample = [];
  let count = 0;
  let gapStart = null;
  let longestGapSec = 0;
  for (let t = Math.ceil(fromSec / tfSec) * tfSec; t <= toSec; t += tfSec) {
    if (!inMarketHours(t, assetClass)) {
      if (gapStart != null) {
        longestGapSec = Math.max(longestGapSec, t - gapStart);
        gapStart = null;
      }
      continue;
    }
    if (!have.has(t)) {
      count++;
      if (gapStart == null) gapStart = t;
      if (sample.length < maxReport) sample.push(t);
    } else if (gapStart != null) {
      longestGapSec = Math.max(longestGapSec, t - gapStart);
      gapStart = null;
    }
  }
  return { count, sample, longestGapSec };
}
var HIST_MONTHS_CAP = {
  "1m": 240,
  "5m": 240,
  "15m": 240,
  "30m": 240,
  "1h": 240,
  "2h": 240,
  "4h": 240,
  "1d": 240,
  "1W": 240,
  "1M": 240
};
function clampBackfillMonths(requested, tf) {
  const cap = HIST_MONTHS_CAP[tf] ?? 12;
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return cap;
  return Math.min(Math.floor(n), cap);
}
function backfillWindowFrom(months, nowSec) {
  return nowSec - Math.round(months * 30.44 * 86400);
}
var READ_AGG_CHAIN = {
  "3m": [{ src: "1m", factorMin: 3 }],
  "5m": [{ src: "1m", factorMin: 5 }],
  "15m": [{ src: "1m", factorMin: 15 }],
  "30m": [{ src: "1m", factorMin: 30 }],
  "1h": [{ src: "1m", factorMin: 60 }],
  "2h": [{ src: "1h", factorMin: 120 }, { src: "1m", factorMin: 120 }],
  "4h": [{ src: "1h", factorMin: 240 }, { src: "1m", factorMin: 240 }],
  "1W": [{ src: "1d", factorMin: 10080 }],
  "1M": [{ src: "1d", factorMin: 43200 }]
};
var MAX_1M_FOLD_WINDOW_SEC = 90 * 86400;

// api/_src/lib/hist.ts
var HIST_STOOQ = {
  XAUUSD: "xauusd",
  XAGUSD: "xagusd",
  EURUSD: "eurusd",
  GBPUSD: "gbpusd",
  USDJPY: "usdjpy",
  AUDUSD: "audusd",
  NZDUSD: "nzdusd",
  USDCAD: "usdcad",
  USDCHF: "usdchf",
  "^NDX": "^ndq",
  "^DJI": "^dji",
  "^GSPC": "^spx",
  "^GDAXI": "^dax",
  "^FTSE": "^ukx"
};
var HIST_TD = { XAUUSD: "XAU/USD", XAGUSD: "XAG/USD" };
var HIST_STOOQ_INTERVAL = {
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "1d": "d"
};
var HIST_TD_DAILY_BUDGET = 150;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var dayKey = (tSec) => new Date(tSec * 1e3).toISOString().slice(0, 10);
function groupByDay(bars) {
  const days = /* @__PURE__ */ new Map();
  for (const b of bars) {
    const k = dayKey(b.time);
    let arr = days.get(k);
    if (!arr) {
      arr = [];
      days.set(k, arr);
    }
    arr.push([b.time, b.open, b.high, b.low, b.close, b.volume ?? 0]);
  }
  return days;
}
async function writeShards(symbol, tf, raw, provider, opts) {
  const checked = validateBars(raw);
  const { bars } = alignAndDedupe(checked.bars, tf === "1d" ? 86400 : tf === "1W" ? 604800 : tf === "1M" ? 2592e3 : 60);
  const rejected = checked.invalid + (raw.length - checked.bars.length);
  const out = { written: 0, skipped: 0, days: [], rejected };
  const metaRef = rtdb().ref(`histMeta/${symbol}/${tf}`);
  const dataRef = rtdb().ref(`hist/${symbol}/${tf}`);
  for (const [day, rows] of groupByDay(bars)) {
    const t0 = rows[0][0];
    if (opts?.before != null && t0 >= opts.before) {
      out.skipped++;
      continue;
    }
    if (opts?.after != null && t0 < opts.after) {
      out.skipped++;
      continue;
    }
    try {
      const existingTag = (await metaRef.child(day).once("value")).val();
      if (existingTag && !opts?.force) {
        out.skipped++;
        continue;
      }
      await dataRef.child(day).set(rows.map((r) => JSON.stringify(r)).join("|"));
      await metaRef.child(day).set(provider);
      out.written++;
      out.days.push(day);
    } catch (e) {
      break;
    }
  }
  return out;
}
async function readShards(symbol, tf, fromSec, toSec) {
  const fromDay = dayKey(fromSec);
  const toDay = dayKey(toSec);
  const snap = await rtdb().ref(`hist/${symbol}/${tf}`).orderByKey().startAt(fromDay).endAt(toDay).once("value");
  const obj = snap.val() || {};
  const bars = [];
  const providers = {};
  const metaSnap = await rtdb().ref(`histMeta/${symbol}/${tf}`).orderByKey().startAt(fromDay).endAt(toDay).once("value");
  const meta = metaSnap.val() || {};
  for (const [day, blob] of Object.entries(obj)) {
    const p = meta[day] || "unknown";
    providers[p] = (providers[p] ?? 0) + 1;
    if (typeof blob !== "string" || !blob) continue;
    for (const row of blob.split("|")) {
      const a = parseShardRow(row);
      if (a) bars.push({ time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] });
    }
  }
  if (tf === "1d") return { bars: normalizeDailyAnchors(bars), providers };
  bars.sort((a, b) => a.time - b.time);
  return { bars, providers };
}
async function fetchStooqBars(stooqSym, interval) {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${stooqSym}&i=${interval}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`STOOQ_${res.status}`);
  const text = await res.text();
  if (text.startsWith("<!DOCTYPE") || /access denied/i.test(text.slice(0, 200))) throw new Error("STOOQ_BLOCKED");
  const tzOffsetMs2 = (dateStr) => {
    try {
      const noonUTC = Date.parse(`${dateStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).formatToParts(new Date(noonUTC));
      const get = (k) => Number(parts.find((p) => p.type === k)?.value ?? 0);
      const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
      return asUTC - noonUTC;
    } catch {
      return 36e5;
    }
  };
  const bars = [];
  const lines = text.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const [d, t, o, h, l, c, v] = cols;
    const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
    if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0)) continue;
    let time;
    if (t && /^\d{2}:\d{2}$/.test(t)) {
      time = Math.floor((Date.parse(`${d}T${t}:00Z`) - tzOffsetMs2(d)) / 1e3);
    } else {
      time = Math.floor(Date.parse(`${d}T00:00:00Z`) / 1e3);
    }
    bars.push({ time, open, high, low, close, volume: Number(v) || 0 });
  }
  return bars;
}
var histTdDayRef = () => rtdb().ref(`config/histTDUsage/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`);
var histTdSpend = async (n = 1) => {
  try {
    await histTdDayRef().transaction((cur) => Number(cur || 0) + n);
  } catch {
  }
};
async function tdWalkM1(apiKey, tdSym, startSec, endSec, maxPages, spentToday) {
  const bars = [];
  let pages = 0;
  let end = endSec;
  let exhausted = false;
  const budgetLeft = HIST_TD_DAILY_BUDGET - spentToday;
  const pageCap = Math.min(maxPages, Math.max(0, budgetLeft));
  while (pages < pageCap && end > startSec) {
    const from = Math.max(startSec, end - 5e3 * 60);
    const u = `https://api.twelvedata.com/time_series?apikey=${encodeURIComponent(apiKey)}&symbol=${encodeURIComponent(tdSym)}&interval=1min&outputsize=5000&timezone=UTC&start_date=${new Date(from * 1e3).toISOString().slice(0, 19)}&end_date=${new Date(end * 1e3).toISOString().slice(0, 19)}&format=JSON&order=ASC`;
    let json;
    try {
      const res = await fetch(u);
      json = await res.json();
    } catch {
      json = { status: "error" };
    }
    if (json?.status === "error" || !Array.isArray(json?.values)) {
      exhausted = true;
      break;
    }
    for (const v of json.values) {
      const t = Math.floor(Date.parse(`${String(v.datetime).replace(" ", "T")}Z`) / 1e3);
      const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
      if (![t, o, h, l, c].every(Number.isFinite) || t <= 0 || o <= 0) continue;
      if (h < Math.max(o, c) || l > Math.min(o, c)) continue;
      bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Number(v.volume) || 0 });
    }
    pages++;
    histTdSpend(1);
    end = from - 1;
    if (json.values.length < 5e3) {
      exhausted = true;
      break;
    }
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, pages, oldest: bars.length ? bars[0].time : null, exhausted };
}
async function dukaWalkM1(code, fromSec, toSec, maxDays, fileBudget, fileUsed, deadlineMs = 45e3) {
  const dukaSym = DUKA_MAP[code] ?? DUKA_METALS[code];
  if (!dukaSym) throw new Error("NOT_ON_DUKA");
  const startedAt = Date.now();
  const bars = [];
  let files = 0;
  let oldest = null;
  let timedOut = false;
  const days = [];
  for (let day = Math.floor(toSec / 86400) * 86400; day >= fromSec && days.length < maxDays; day -= 86400) days.push(new Date(day * 1e3));
  for (let i = 0; i < days.length && fileUsed + files < fileBudget; i += 5) {
    if (Date.now() - startedAt > deadlineMs) {
      timedOut = true;
      break;
    }
    const chunk = days.slice(i, i + 5);
    const bufs = await Promise.all(chunk.map((d) => fetchDukaDay(dukaSym, d)));
    if (oldest == null && files === 0 && bufs.every((b) => b == null) && i >= 5) break;
    for (let k = 0; k < chunk.length; k++) {
      const buf = bufs[k];
      if (!buf) continue;
      files++;
      const decoded = await decodeDukaDay(buf, code, chunk[k]);
      for (const b of decoded) {
        if (b.t < fromSec || b.t > toSec) continue;
        bars.push({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
        if (oldest == null || b.t < oldest) oldest = b.t;
      }
    }
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, files, oldest, timedOut };
}
var ASSET_CLASS = {
  XAUUSD: "metal",
  XAGUSD: "metal"
};
function assetClassOf(symbol) {
  if (ASSET_CLASS[symbol]) return ASSET_CLASS[symbol];
  if (symbol.startsWith("^")) return "index";
  if (/USD[T]?$/i.test(symbol) && symbol.length >= 6) return "crypto";
  if (symbol.endsWith("=X") || /^[A-Z]{6}$/.test(symbol)) return "forex";
  return "index";
}
async function runBackfillStep(req) {
  const { symbol, tf } = req;
  const months = clampBackfillMonths(req.months, tf);
  const now = Math.floor(Date.now() / 1e3);
  const wantFrom = backfillWindowFrom(months, now);
  const stateRef = rtdb().ref(`histState/${symbol}/${tf}`);
  const state = (await stateRef.once("value")).val() || {};
  const covered = state.oldest ? Math.min(state.oldest, wantFrom) : wantFrom;
  const base = { ok: true, symbol, tf, provider: "", written: 0, skipped: 0, rejected: 0, oldest: state.oldest ?? null, newest: state.newest ?? null, cursor: state.oldest ?? null, targetFrom: wantFrom, done: false };
  try {
    if (assetClassOf(symbol) === "crypto") {
      return { ...base, provider: "binance", done: true, note: "crypto history is served natively by the Binance REST/WS engine (loadOlder pagination)" };
    }
    if (tf === "1m") {
      if (DUKA_METALS[symbol] || DUKA_MAP[symbol]) {
        const usageRef = rtdb().ref(`config/dukaUsage/${DUKA_METALS[symbol] ? "metals" : "fx"}/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`);
        const used = Number((await usageRef.once("value")).val() || 0);
        if (used >= 1200) return { ...base, ok: false, provider: "dukascopy", error: "daily-file-cap" };
        const top = state.oldest != null ? Math.min(state.oldest, now - 2 * 86400) : now - 2 * 86400;
        const walk = await dukaWalkM1(symbol, covered, top, req.maxDays ?? 240, 900, used, req.deadlineMs ?? 22e3);
        const sh2 = await writeShards(symbol, tf, walk.bars, "dukascopy-bid", { force: req.force });
        await usageRef.set(used + walk.files);
        let foldedNote = "";
        try {
          if (walk.bars.length) {
            const hourBars = aggregateBars(walk.bars, 60);
            const dayBars = aggregateBars(walk.bars, 1440);
            const hs = await writeShards(symbol, "1h", hourBars, "dukascopy-bid-fold", { force: req.force });
            const ds = await writeShards(symbol, "1d", dayBars, "dukascopy-bid-fold", { force: req.force });
            foldedNote = ` \xB7 folds 1h+${hs.written}/1d+${ds.written}`;
          }
        } catch {
        }
        const newOldest = walk.oldest ?? state.oldest ?? null;
        const done = newOldest != null && newOldest <= covered;
        await stateRef.set({
          provider: "dukascopy-bid",
          oldest: newOldest,
          newest: state.newest ?? now - 2 * 86400,
          cursor: newOldest,
          targetFrom: wantFrom,
          done,
          files: (state.files ?? 0) + walk.files,
          written: (state.written ?? 0) + sh2.written,
          rejected: (state.rejected ?? 0) + sh2.rejected,
          updatedAt: Date.now(),
          error: null
        });
        if (sh2.written > 0 || done) {
          return { ...base, provider: "dukascopy-bid", written: sh2.written, skipped: sh2.skipped, rejected: sh2.rejected, oldest: newOldest, cursor: newOldest, done, timedOut: walk.timedOut, note: `${walk.files} day files${walk.timedOut ? " \xB7 wall-clock budget reached \u2014 resume to continue" : ""}${foldedNote}` };
        }
        if (walk.files === 0) {
          return { ...base, ok: false, provider: "dukascopy-bid", error: "CDN_UNREACHABLE", note: "Dukascopy returned 0 day files (429/503 rate-limit or network block) \u2014 depth resumes when the CDN answers; TwelveData fallback needs a stored key" };
        }
        return { ...base, provider: "dukascopy-bid", written: 0, skipped: sh2.skipped, rejected: sh2.rejected, oldest: newOldest, cursor: newOldest, done, timedOut: walk.timedOut, note: `${walk.files} day files fetched, ${sh2.skipped} already stored \u2014 no new days in this window (resume walks deeper)${foldedNote}` };
      }
      const tdSym = HIST_TD[symbol];
      if (tdSym) {
        const apiKey = String(process.env.TWELVE_DATA_API_KEY || "") || String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
        if (!/^[a-f0-9]{32}$/i.test(apiKey)) return { ...base, ok: false, provider: "twelvedata", error: "no-key" };
        const spent = Number((await histTdDayRef().once("value")).val() || 0);
        const walk = await tdWalkM1(apiKey, tdSym, covered, state.oldest ?? now, req.maxPages ?? 10, spent);
        const sh2 = await writeShards(symbol, tf, walk.bars, "twelvedata", { force: req.force });
        const oldest2 = walk.oldest ?? sh2.days.length ? Math.min(...sh2.days.map((d) => Date.parse(`${d}T00:00:00Z`) / 1e3), walk.oldest ?? Infinity) : null;
        const newOldest = walk.oldest ?? state.oldest ?? null;
        await stateRef.set({
          provider: "twelvedata",
          oldest: newOldest,
          newest: state.newest ?? now,
          cursor: newOldest,
          targetFrom: wantFrom,
          done: walk.exhausted || newOldest != null && newOldest <= covered,
          pages: (state.pages ?? 0) + walk.pages,
          written: (state.written ?? 0) + sh2.written,
          rejected: (state.rejected ?? 0) + sh2.rejected,
          updatedAt: Date.now(),
          error: walk.exhausted && !newOldest ? "provider refused / no deeper data" : null
        });
        return { ...base, provider: "twelvedata", written: sh2.written, skipped: sh2.skipped, rejected: sh2.rejected, oldest: newOldest, newest: now, cursor: newOldest, done: walk.exhausted, note: `${walk.pages} pages spent (${Math.max(0, HIST_TD_DAILY_BUDGET - spent - walk.pages)} credits left today)` };
      }
      if (DUKA_MAP[symbol]) {
        const usageRef = rtdb().ref(`config/dukaUsage/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`);
        const used = Number((await usageRef.once("value")).val() || 0);
        if (used >= 1200) return { ...base, ok: false, provider: "dukascopy", error: "daily-file-cap" };
        const top = state.oldest != null ? Math.min(state.oldest, now - 2 * 86400) : now - 2 * 86400;
        const walk = await dukaWalkM1(symbol, covered, top, req.maxDays ?? 240, 900, used, req.deadlineMs ?? 22e3);
        const sh2 = await writeShards(symbol, tf, walk.bars, "dukascopy-bid", { force: req.force });
        await usageRef.set(used + walk.files);
        let foldedNote = "";
        try {
          if (walk.bars.length) {
            const hourBars = aggregateBars(walk.bars, 60);
            const dayBars = aggregateBars(walk.bars, 1440);
            const hs = await writeShards(symbol, "1h", hourBars, "dukascopy-bid-fold", { force: req.force });
            const ds = await writeShards(symbol, "1d", dayBars, "dukascopy-bid-fold", { force: req.force });
            foldedNote = ` \xB7 folds 1h+${hs.written}/1d+${ds.written}`;
          }
        } catch {
        }
        const newOldest = walk.oldest ?? state.oldest ?? null;
        const done = newOldest != null && newOldest <= covered;
        await stateRef.set({
          provider: "dukascopy-bid",
          oldest: newOldest,
          newest: state.newest ?? now - 2 * 86400,
          cursor: newOldest,
          targetFrom: wantFrom,
          done,
          files: (state.files ?? 0) + walk.files,
          written: (state.written ?? 0) + sh2.written,
          rejected: (state.rejected ?? 0) + sh2.rejected,
          updatedAt: Date.now(),
          error: null
        });
        return { ...base, provider: "dukascopy-bid", written: sh2.written, skipped: sh2.skipped, rejected: sh2.rejected, oldest: newOldest, cursor: newOldest, done, timedOut: walk.timedOut, note: `${walk.files} day files${walk.timedOut ? " \xB7 wall-clock budget reached \u2014 resume to continue" : ""}${foldedNote}` };
      }
      return { ...base, ok: false, provider: "none", error: "NO_1M_SOURCE (stooq refuses 1m; metals are not on the Dukascopy feed; TwelveData key missing)" };
    }
    const stooqSym = HIST_STOOQ[symbol];
    if (!stooqSym) return { ...base, ok: false, provider: "none", error: `no deep source for ${symbol} ${tf}` };
    const iv = HIST_STOOQ_INTERVAL[tf];
    if (!iv) {
      const srcTf = tf === "2h" || tf === "4h" ? "1h" : tf === "1W" || tf === "1M" ? "1d" : null;
      if (!srcTf) return { ...base, ok: false, provider: "none", error: `no source interval for ${tf}` };
      const srcBars = await fetchStooqBars(stooqSym, HIST_STOOQ_INTERVAL[srcTf]);
      const inWin2 = srcBars.filter((b) => b.time >= covered);
      let agg;
      if (tf === "1W" || tf === "1M") {
        const sec = tf === "1W" ? 604800 : 2592e3;
        const byBucket = /* @__PURE__ */ new Map();
        for (const b of inWin2) {
          const k = bucketStart(b.time, sec);
          let arr = byBucket.get(k);
          if (!arr) {
            arr = [];
            byBucket.set(k, arr);
          }
          arr.push(b);
        }
        agg = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([t, arr]) => ({
          time: t,
          open: arr[0].open,
          high: Math.max(...arr.map((b) => b.high)),
          low: Math.min(...arr.map((b) => b.low)),
          close: arr[arr.length - 1].close,
          volume: arr.reduce((s, b) => s + (b.volume ?? 0), 0)
        }));
      } else {
        agg = aggregateBars(inWin2, Number(tf.slice(0, -1)) * 60);
      }
      const sh2 = await writeShards(symbol, tf, agg, `stooq-${srcTf}-fold`, { force: req.force });
      await stateRef.set({ provider: `stooq-${srcTf}-fold`, oldest: agg.length ? agg[0].time : state.oldest ?? null, newest: agg.length ? agg[agg.length - 1].time : state.newest ?? null, targetFrom: wantFrom, done: true, written: (state.written ?? 0) + sh2.written, rejected: (state.rejected ?? 0) + sh2.rejected, updatedAt: Date.now(), error: null });
      return { ...base, provider: `stooq-${srcTf}-fold`, written: sh2.written, skipped: sh2.skipped, rejected: sh2.rejected, oldest: agg.length ? agg[0].time : null, newest: agg.length ? agg[agg.length - 1].time : null, done: true };
    }
    const raw = await fetchStooqBars(stooqSym, iv);
    const inWin = raw.filter((b) => b.time >= covered && b.time <= now);
    const sh = await writeShards(symbol, tf, inWin, "stooq-spot", { force: req.force });
    const oldest = inWin.length ? inWin[0].time : state.oldest ?? null;
    const newest = inWin.length ? inWin[inWin.length - 1].time : state.newest ?? null;
    await stateRef.set({
      provider: "stooq-spot",
      oldest,
      newest,
      cursor: oldest,
      targetFrom: wantFrom,
      done: true,
      written: (state.written ?? 0) + sh.written,
      rejected: (state.rejected ?? 0) + sh.rejected,
      updatedAt: Date.now(),
      error: null
    });
    return { ...base, provider: "stooq-spot", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest, newest, cursor: oldest, done: true, note: `${raw.length} archive rows scanned` };
  } catch (e) {
    const msg = String(e?.message || e);
    await stateRef.update({ error: msg, updatedAt: Date.now() }).catch(() => {
    });
    return { ...base, ok: false, error: msg };
  }
}
async function readRange(symbol, tf, fromSec, toSec) {
  const native = await readShards(symbol, tf, fromSec, toSec);
  if (native.bars.length) {
    const repaired = repairOutlierExtremes(native.bars);
    return { ok: true, symbol, tf, bars: repaired.bars, providers: native.providers };
  }
  const chain = READ_AGG_CHAIN[tf];
  if (chain) {
    for (const agg of chain) {
      if (agg.src === "1m" && toSec - fromSec > MAX_1M_FOLD_WINDOW_SEC) continue;
      const src = await readShards(symbol, agg.src, fromSec, toSec);
      if (!src.bars.length) continue;
      const folded = aggregateBars(src.bars, agg.factorMin);
      const out = repairOutlierExtremes(folded).bars;
      const providers = {};
      for (const [p, n] of Object.entries(src.providers)) providers[`${p}\u2192${tf}-fold`] = n;
      return { ok: true, symbol, tf, bars: out, providers };
    }
  }
  return { ok: true, symbol, tf, bars: [], providers: {}, note: "no stored history in this window" };
}
async function coverageReport(symbol, tfs) {
  const ac = assetClassOf(symbol);
  const rows = [];
  const now = Math.floor(Date.now() / 1e3);
  for (const tf of tfs) {
    const state = (await rtdb().ref(`histState/${symbol}/${tf}`).once("value")).val() || null;
    const snap = await rtdb().ref(`hist/${symbol}/${tf}`).once("value");
    const obj = snap.val() || {};
    let count = 0;
    let earliest = null;
    let latest = null;
    const metaSnap = await rtdb().ref(`histMeta/${symbol}/${tf}`).once("value");
    const meta = metaSnap.val() || {};
    const providers = {};
    const bars = [];
    for (const [day, blob] of Object.entries(obj)) {
      const p = meta[day] || "unknown";
      providers[p] = (providers[p] ?? 0) + 1;
      if (typeof blob !== "string") continue;
      const rows2 = blob ? blob.split("|") : [];
      count += rows2.length;
      for (const row of rows2) {
        const a = parseShardRow(row);
        if (!a) continue;
        if (earliest == null || a[0] < earliest) earliest = a[0];
        if (latest == null || a[0] > latest) latest = a[0];
        if (bars.length < 2e5) bars.push({ time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] });
      }
    }
    const tfSec = tf === "1d" ? 86400 : tf === "1W" ? 604800 : tf === "1M" ? 2592e3 : tf === "1h" || tf === "2h" || tf === "4h" ? Number(tf.slice(0, -1)) * 3600 : Number(tf.slice(0, -1)) * 60;
    const missing = earliest && latest ? missingIntervals(bars, tfSec, Math.max(earliest, now - 180 * 86400), Math.min(latest, now), ac) : { count: 0, sample: [], longestGapSec: 0 };
    rows.push({ symbol, tf, earliest, latest, candleCount: count, providers, missing, state });
  }
  return rows;
}

// api/_src/lib/truefx.ts
var TRUEFX_URL = "https://webrates.truefx.com/rates/connect.html?f=csv";
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var TRUEFX_BIG_FIGURE_RE = /^\d+\.(?:\d{2})?$/;
function parseTrueFxRow(f, ctx) {
  if (f.length < 8) return null;
  const pair = f[0]?.trim();
  if (!pair || !pair.includes("/")) return null;
  const code = pair.replace("/", "");
  if (!TRUEFX_BIG_FIGURE_RE.test(String(f[2])) || !TRUEFX_BIG_FIGURE_RE.test(String(f[4]))) return null;
  const bid = Number.parseFloat(String(f[2]) + String(f[3]));
  const ask = Number.parseFloat(String(f[4]) + String(f[5]));
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
  const last = ctx?.lastGood?.[code];
  if (last && last > 0 && Math.abs(bid / last - 1) > 0.015) {
    const nowMs = ctx?.nowMs ?? Date.now();
    const acceptedAt = ctx?.lastGoodAt?.[code] ?? 0;
    if (nowMs - acceptedAt < 3e5) return null;
  }
  const ts = Number(f[1]);
  const open = Number.isFinite(Number(f[8])) ? Number(f[8]) : null;
  return { code, quote: { bid, ask, mid: (bid + ask) / 2, ts: Number.isFinite(ts) ? ts : 0, open } };
}
var CACHE_TTL_MS = 2e3;
var cache = null;
var inflight = null;
var truefxQuotes = async () => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.quotes;
  if (inflight) return inflight;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    try {
      const res = await fetch(TRUEFX_URL, { headers: { "User-Agent": UA2, Accept: "text/csv" }, signal: controller.signal });
      if (!res.ok) return cache?.quotes ?? {};
      const text = await res.text();
      const out = {};
      const lg = {};
      const lga = {};
      for (const [code, q] of Object.entries(cache?.quotes ?? {})) {
        lg[code] = q.bid;
        lga[code] = cache?.at ?? 0;
      }
      for (const line of text.split("\n")) {
        const parsed = parseTrueFxRow(line.split(","), { lastGood: lg, lastGoodAt: lga, nowMs: Date.now() });
        if (!parsed) continue;
        out[parsed.code] = parsed.quote;
        lg[parsed.code] = parsed.quote.bid;
        lga[parsed.code] = Date.now();
      }
      if (Object.keys(out).length) cache = { at: Date.now(), quotes: out };
      return out;
    } catch {
      return cache?.quotes ?? {};
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
};

// api/_src/quotes.ts
var UA3 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var STOOQ_MAP = {
  "GC=F": "xauusd",
  "SI=F": "xagusd",
  "EURUSD=X": "eurusd",
  "GBPUSD=X": "gbpusd",
  "USDJPY=X": "usdjpy",
  "AUDUSD=X": "audusd",
  "NZDUSD=X": "nzdusd",
  "USDCAD=X": "usdcad",
  "USDCHF=X": "usdchf",
  "^NDX": "^ndq",
  "^DJI": "^dji",
  "^GSPC": "^spx",
  "^GDAXI": "^dax",
  "^FTSE": "^ukx"
};
var INDEX_FUTURES_FALLBACK = {
  "^NDX": "NQ=F",
  "^DJI": "YM=F",
  "^GSPC": "ES=F"
};
var stooqOf = (sym) => STOOQ_MAP[sym] ?? (sym.endsWith("=X") ? sym.slice(0, -2).toLowerCase() : null);
function csvToQuotes(csv) {
  const out = {};
  const lines = csv.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 7) continue;
    const close = Number(cols[6]);
    const open = Number(cols[3]);
    out[cols[0].toLowerCase()] = {
      price: Number.isFinite(close) && close > 0 ? close : null,
      previousClose: Number.isFinite(open) && open > 0 ? open : null
    };
  }
  return out;
}
function stooqCsvToBars(csv) {
  const bars = [];
  const lines = csv.trim().split(/\r?\n/);
  const tzOffsetMs2 = (dateStr) => {
    try {
      const noonUTC = Date.parse(`${dateStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).formatToParts(new Date(noonUTC));
      const get = (k) => Number(parts.find((p) => p.type === k)?.value ?? 0);
      const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
      return asUTC - noonUTC;
    } catch {
      return 36e5;
    }
  };
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const [d, t, o, h, l, c, v] = cols;
    const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
    if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0)) continue;
    let time;
    if (t && /^\d{2}:\d{2}$/.test(t)) {
      time = Math.floor((Date.parse(`${d}T${t}:00Z`) - tzOffsetMs2(d)) / 1e3);
    } else {
      time = Math.floor(Date.parse(`${d}T00:00:00Z`) / 1e3);
    }
    bars.push({ time, open, high, low, close, volume: Number(v) || 0 });
  }
  return bars;
}
var STOOQ_INTERVAL = { "1m": "5", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "d" };
var barsCache = /* @__PURE__ */ new Map();
var batchCache = /* @__PURE__ */ new Map();
var inflight2 = /* @__PURE__ */ new Map();
var BARS_FRESH_MS = 12e3;
var BARS_STALE_MS = 6e4;
var BATCH_FRESH_MS = 3e4;
var BATCH_STALE_MS = 12e4;
function pruneCache(cache2, staleMs) {
  if (cache2.size < 64) return;
  const cutoff = Date.now() - staleMs * 2;
  for (const [k, v] of cache2) if (v.at < cutoff) cache2.delete(k);
}
async function doFetch(cache2, key, fetcher) {
  let p = inflight2.get(key);
  if (!p) {
    p = (async () => {
      const payload = await fetcher();
      cache2.set(key, { at: Date.now(), payload });
      return payload;
    })().finally(() => {
      inflight2.delete(key);
    });
    inflight2.set(key, p);
  }
  return p;
}
async function cachedPayload(cache2, key, freshMs, staleMs, fetcher) {
  const hit = cache2.get(key);
  if (hit && Date.now() - hit.at < freshMs) return hit.payload;
  if (hit && Date.now() - hit.at < staleMs) {
    if (!inflight2.has(key)) void doFetch(cache2, key, fetcher).catch(() => {
    });
    pruneCache(cache2, staleMs);
    return hit.payload;
  }
  try {
    const payload = await doFetch(cache2, key, fetcher);
    pruneCache(cache2, staleMs);
    return payload;
  } catch (e) {
    if (hit) return hit.payload;
    throw e;
  }
}
var SPOT_API_MAP = { "GC=F": "XAU", "SI=F": "XAG" };
var SPOT_TTL_MS = 3e4;
var SPOT_MAX_AGE_MS = 6e5;
var spotCache = /* @__PURE__ */ new Map();
async function fetchSpot(code) {
  const cached = spotCache.get(code);
  if (cached && Date.now() - cached.at < SPOT_TTL_MS) return cached.price;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6e3);
    const res = await fetch(`https://api.gold-api.com/price/${code}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const price = Number(data?.price);
    const updatedAt = Date.parse(data?.updatedAt || "") || 0;
    if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
    if (updatedAt && Date.now() - updatedAt > SPOT_MAX_AGE_MS) throw new Error("STALE_SPOT");
    spotCache.set(code, { at: Date.now(), price });
    return price;
  } catch {
    return cached?.price ?? null;
  }
}
var FXLIVE_MAX_AGE_SEC = 3 * 86400;
var fxLiveCache = /* @__PURE__ */ new Map();
async function fxLiveMinutes(code) {
  const nowMs = Date.now();
  const hit = fxLiveCache.get(code);
  if (hit && nowMs - hit.at < 6e4) return hit.minutes;
  const minutes = /* @__PURE__ */ new Map();
  try {
    const snap = await rtdb().ref(`fxLive/${code}`).once("value");
    const obj = snap.val() || {};
    const cutoff = Math.floor(nowMs / 1e3) - FXLIVE_MAX_AGE_SEC;
    for (const [k, v] of Object.entries(obj)) {
      const t = Number(k);
      const o = Number(v?.o), h = Number(v?.h), l = Number(v?.l), c = Number(v?.c), s = Number(v?.s || 1);
      if (!Number.isFinite(t) || t < cutoff || t % 60 !== 0) continue;
      if (![o, h, l, c].every(Number.isFinite) || o <= 0) continue;
      minutes.set(t, { o, h, l, c, s: Number.isFinite(s) ? s : 1 });
    }
  } catch {
  }
  fxLiveCache.set(code, { at: nowMs, minutes });
  return minutes;
}
async function recordFxLiveBids(bids) {
  const t = Math.floor(Date.now() / 1e3 / 60) * 60;
  const touched = [];
  try {
    for (const [code, bidRaw] of Object.entries(bids)) {
      const bid = Number(bidRaw);
      if (!DUKA_MAP[code] || !(bid > 0)) continue;
      await rtdb().ref(`fxLive/${code}/${t}`).transaction((cur) => {
        const o = Number(cur?.o), h = Number(cur?.h), l = Number(cur?.l), s = Number(cur?.s || 1);
        if (cur && [o, h, l, Number(cur.c)].every(Number.isFinite) && o > 0) {
          return { o, c: bid, h: Math.max(h, bid), l: Math.min(l, bid), s: s + 1 };
        }
        return { o: bid, c: bid, h: bid, l: bid, s: 1 };
      });
      touched.push(code);
      try {
        const minutes = await fxLiveMinutes(code);
        const ex = minutes.get(t);
        const merged = ex ? { o: ex.o, c: bid, h: Math.max(ex.h, bid), l: Math.min(ex.l, bid), s: ex.s + 1 } : { o: bid, c: bid, h: bid, l: bid, s: 1 };
        minutes.set(t, merged);
      } catch {
      }
    }
    if (touched.length && Math.random() < 0.05) {
      const cutoff = String(t - FXLIVE_MAX_AGE_SEC);
      for (const code of touched) {
        void rtdb().ref(`fxLive/${code}`).orderByKey().endAt(cutoff).limitToFirst(2e3).remove().catch(() => {
        });
      }
    }
  } catch {
  }
}
var INTERVAL_SECONDS = {
  "1m": 60,
  "2m": 120,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "60m": 3600,
  "1h": 3600,
  "90m": 5400,
  "1d": 86400
};
function mergeSpotBars(bars, spot, interval) {
  const sec = INTERVAL_SECONDS[interval];
  if (!sec) return false;
  const guard = spotMergeGuard(bars, spot, { sec });
  if (!guard.ok) return false;
  const now = Math.floor(Date.now() / 1e3);
  const bucket = bucketStart(now, sec);
  const last = bars[bars.length - 1];
  if (last.time === bucket) {
    last.close = spot;
    if (spot > last.high) last.high = spot;
    if (spot < last.low) last.low = spot;
    return true;
  }
  if (bucket > last.time) {
    bars.push({ time: bucket, open: last.close, high: Math.max(last.close, spot), low: Math.min(last.close, spot), close: spot, volume: 0 });
    return true;
  }
  return false;
}
var TD_DAILY_BUDGET = 260;
var tdDayRef = () => rtdb().ref(`config/tdUsage/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`);
var tdSpend = async (n = 1) => {
  try {
    await tdDayRef().transaction((cur) => Number(cur || 0) + n);
  } catch {
  }
};
var tdKey = async () => {
  const env = String(process.env.TWELVE_DATA_API_KEY || "");
  if (/^[a-f0-9]{32}$/i.test(env)) return env;
  const stored = String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
  return /^[a-f0-9]{32}$/i.test(stored) ? stored : "";
};
var quotes_default = handle(async (req, res) => {
  await requireUser(req);
  const url = new URL(req.url || "/", "http://localhost");
  const batch = (url.searchParams.get("symbols") || "").trim();
  let symbols = (url.searchParams.get("symbol") || "").trim();
  const bareCode = symbols.replace(/=X$/i, "");
  const range = (url.searchParams.get("range") || "5d").trim();
  const interval = (url.searchParams.get("interval") || "1m").trim();
  const toSec = (v) => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e11 ? n / 1e3 : n);
  };
  const period1 = toSec(url.searchParams.get("period1"));
  const period2 = toSec(url.searchParams.get("period2"));
  const periodMode = period1 != null && period2 != null && period2 > period1;
  const action = (url.searchParams.get("action") || "").trim();
  if (action === "spot-history") {
    const code = (url.searchParams.get("code") || "XAU").toUpperCase() === "XAG" ? "XAG" : "XAU";
    const snap = await rtdb().ref(`spotTicks/${code}`).once("value");
    const obj = snap.val() || {};
    const now = Math.floor(Date.now() / 1e3);
    const tfSec = Math.max(60, Math.min(2592e3, Math.floor(Number(url.searchParams.get("tf")) || 60)));
    const minT = tfSec > 60 ? 0 : now - 65 * 86400;
    let rawCandles = Object.entries(obj).map(([t, c]) => ({ t: Number(t), o: Number(c?.o), h: Number(c?.h), l: Number(c?.l), c: Number(c?.c), s: Number(c?.s || 0), time: Number(t) })).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o) && c.t >= minT && c.t <= now).sort((a, b) => a.t - b.t);
    rawCandles = filterClosedCandles(code === "XAU" ? "XAUUSD" : "XAGUSD", rawCandles);
    const checked = validateBars(rawCandles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.s })));
    if (tfSec > 60) {
      const agg = aggregateBars(checked.bars, tfSec / 60);
      const bars = repairOutlierExtremes(agg.slice(-4e3)).bars;
      return res.json({ ok: true, code, tf: tfSec, bars, count: bars.length });
    }
    const candles = checked.bars.map((b) => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, s: Number(b.volume || 0) }));
    return res.json({ ok: true, code, tf: tfSec, candles });
  }
  if (action === "spot-record" && req.method === "POST") {
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const records = Array.isArray(raw?.records) ? raw.records.slice(0, 4) : [];
    const now = Math.floor(Date.now() / 1e3);
    const minuteNow = Math.floor(now / 60) * 60;
    let accepted = 0;
    for (const rec of records) {
      const code = rec?.code === "XAG" ? "XAG" : rec?.code === "XAU" ? "XAU" : null;
      if (!code) continue;
      const [loBand, hiBand] = SPOT_PRICE_BANDS[code];
      const recSymbol = code === "XAU" ? "XAUUSD" : "XAGUSD";
      const recIntervals = closedIntervals(recSymbol, now - 8 * 86400, minuteNow);
      const closedAtRec = (t) => {
        let lo = 0, hi = recIntervals.length - 1;
        while (lo <= hi) {
          const mid = lo + hi >> 1;
          const iv = recIntervals[mid];
          if (t < iv.from) hi = mid - 1;
          else if (t >= iv.to) lo = mid + 1;
          else return true;
        }
        return false;
      };
      const incoming = (Array.isArray(rec?.candles) ? rec.candles.slice(0, 40) : []).map((c) => ({ t: Number(c?.t), o: Number(c?.o), h: Number(c?.h), l: Number(c?.l), c: Number(c?.c), s: Number(c?.s || 1) })).filter((c) => {
        if (!Number.isFinite(c.t) || c.t % 60 !== 0 || c.t > minuteNow || c.t < now - 8 * 86400) return false;
        if (closedAtRec(c.t)) return false;
        if (![c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v) && v > 0)) return false;
        if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c) || c.h < c.l) return false;
        if (c.o < loBand || c.o > hiBand || c.c < loBand || c.c > hiBand) return false;
        if (!Number.isFinite(c.s) || c.s < 1 || c.s > 60) return false;
        return true;
      });
      if (!incoming.length) continue;
      const ref = rtdb().ref(`spotTicks/${code}`);
      const snap = await ref.once("value");
      const existing = snap.val() || {};
      const update = {};
      for (const inc of incoming) {
        const ex = existing[String(inc.t)];
        if (!ex) {
          update[String(inc.t)] = { o: inc.o, h: inc.h, l: inc.l, c: inc.c, s: inc.s };
          accepted += 1;
          continue;
        }
        update[String(inc.t)] = Number(ex.s || 0) === 0 && inc.s < 3 ? { o: Number(ex.o) || inc.o, c: Number(ex.c) || inc.c, h: Math.max(inc.h, Number(ex.h) || inc.h), l: Math.min(inc.l, Number(ex.l) || inc.l), s: Math.max(inc.s, Number(ex.s || 0)) } : {
          o: Number(ex.o) || inc.o,
          c: inc.c,
          h: Math.max(inc.h, Number(ex.h) || inc.h),
          l: Math.min(inc.l, Number(ex.l) || inc.l),
          s: Math.max(inc.s, Number(ex.s || 0))
        };
        accepted += 1;
      }
      if (Object.keys(update).length) await ref.update(update);
    }
    return res.json({ ok: true, accepted });
  }
  if (action === "set-provider-key" && req.method === "POST") {
    const adminUser = await requireAdmin(req);
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const key = String(raw?.key || "").trim();
    if (!/^[a-f0-9]{32}$/i.test(key)) return res.status(400).json({ ok: false, error: "BAD_KEY" });
    await rtdb().ref("config/providerKeys/twelvedata").set(key);
    return res.json({ ok: true, stored: true });
  }
  if (action === "backfill-spot" && req.method === "POST") {
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = raw?.code === "XAG" ? "XAG" : "XAU";
    const pages = Math.min(Math.max(Number(raw?.pages) || 8, 1), 8);
    let key = /^[a-f0-9]{32}$/i.test(String(raw?.key || "")) ? String(raw.key) : "";
    if (!key) {
      key = String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
      if (!key) key = String(process.env.TWELVE_DATA_API_KEY || "");
    }
    if (!/^[a-f0-9]{32}$/i.test(key)) return res.json({ ok: false, reason: "no-key" });
    if (raw?.store === true) {
      try {
        await requireAdmin(req);
        if (/^[a-f0-9]{32}$/i.test(String(raw?.key || ""))) await rtdb().ref("config/providerKeys/twelvedata").set(String(raw.key));
      } catch {
      }
    }
    const gateRef = rtdb().ref(`config/backfillAt/${code}`);
    const lastAt = Number((await gateRef.once("value")).val() || 0);
    const nowMs = Date.now();
    if (nowMs - lastAt < 12e4) return res.json({ ok: false, reason: "cooldown", retryInSec: Math.ceil((12e4 - (nowMs - lastAt)) / 1e3) });
    await gateRef.set(nowMs);
    const symbol = code === "XAG" ? "XAG/USD" : "XAU/USD";
    const used = Number((await tdDayRef().once("value")).val() || 0);
    if (used >= TD_DAILY_BUDGET) return res.json({ ok: false, reason: "td-budget-exhausted" });
    const nowSec = Math.floor(Date.now() / 1e3);
    const minuteNow = Math.floor(nowSec / 60) * 60;
    const oldestAllowed = nowSec - 60 * 86400;
    const [loPrice, hiPrice] = SPOT_PRICE_BANDS[code] ?? [100, 2e4];
    const recordedSnap = await rtdb().ref(`spotTicks/${code}`).once("value");
    const recorded = recordedSnap.val() || {};
    let lastRecordedMin = null;
    for (const k of Object.keys(recorded)) {
      const t = Number(k);
      if (Number.isFinite(t) && Number(recorded[k]?.s || 0) >= 1 && (lastRecordedMin == null || t > lastRecordedMin)) lastRecordedMin = t;
    }
    let newestTdSeen = 0;
    let seamCap = null;
    let written = 0;
    let oldest = null;
    let endDate = "";
    for (let p = 0; p < pages; p++) {
      const qs = new URLSearchParams({ symbol, interval: "1min", outputsize: "5000", timezone: "UTC", apikey: key });
      if (endDate) qs.set("end_date", endDate);
      let d = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15e3);
        const r = await fetch(`https://api.twelvedata.com/time_series?${qs.toString()}`, { signal: controller.signal });
        clearTimeout(timer);
        d = await r.json();
        await tdSpend(1);
      } catch {
        break;
      }
      const values = Array.isArray(d?.values) ? d.values : [];
      if (!values.length) break;
      const valid = [];
      for (const v of values) {
        const t = Math.floor(Date.parse(String(v?.datetime || "").replace(" ", "T") + "Z") / 1e3);
        const o = Number(v?.open), h = Number(v?.high), l = Number(v?.low), c = Number(v?.close);
        if (!Number.isFinite(t) || t % 60 !== 0 || t > minuteNow || t < oldestAllowed) continue;
        if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
        if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) continue;
        if (o < loPrice || o > hiPrice) continue;
        if (t > newestTdSeen) newestTdSeen = t;
        valid.push({ t, o, h, l, c });
      }
      if (seamCap == null && valid.length) {
        const tdDelayed = minuteNow - newestTdSeen > 120;
        seamCap = tdDelayed && lastRecordedMin != null && minuteNow - lastRecordedMin <= 15 * 60 ? lastRecordedMin : null;
      }
      const update = {};
      for (const b of valid) {
        if (seamCap != null && b.t > seamCap) continue;
        const t = b.t, o = b.o, h = b.h, l = b.l, c = b.c;
        const existing = recorded[String(t)];
        if (!existing) {
          update[String(t)] = { o, h, l, c, s: 0 };
        } else if (Number(existing.s || 0) > 2 && (Math.abs(c / Number(existing.c) - 1) > 0.02 || Math.abs(Number(existing.o) / c - 1) > 0.02)) {
          update[String(t)] = { o, h, l, c, s: Number(existing.s || 1) };
        } else if (Number(existing.s || 0) <= 2) {
          update[String(t)] = { o, h: Math.max(h, Number(existing.h) || h), l: Math.min(l, Number(existing.l) || l), c, s: Number(existing.s || 1) };
        } else if (Number(existing.h) < h || Number(existing.l) > l) {
          update[String(t)] = {
            o: Number(existing.o),
            c: Number(existing.c),
            s: Number(existing.s || 1),
            h: Math.max(Number(existing.h) || h, h),
            l: Math.min(Number(existing.l) || l, l)
          };
        }
        if (oldest == null || t < oldest) oldest = t;
      }
      if (Object.keys(update).length) {
        const entries = Object.entries(update);
        const ref = rtdb().ref(`spotTicks/${code}`);
        for (let i = 0; i < entries.length; i += 2e3) {
          await ref.update(Object.fromEntries(entries.slice(i, i + 2e3)));
        }
        written += entries.length;
      }
      if (values.length < 5e3) break;
      endDate = String(values[values.length - 1].datetime);
      await new Promise((r) => setTimeout(r, 250));
    }
    return res.json({ ok: true, code, written, oldest });
  }
  if (action === "backfill-fx" && req.method === "POST") {
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = String(raw?.code || "").toUpperCase();
    const dukaSym = DUKA_MAP[code];
    if (!dukaSym) return res.json({ ok: false, reason: "not-on-duka" });
    const days = Math.min(Math.max(Number(raw?.days) || 30, 1), 400);
    const gate = rtdb().ref(`config/dukaBackfillAt/${code}`);
    const lastAt = Number((await gate.once("value")).val() || 0);
    const nowMs = Date.now();
    if (nowMs - lastAt < 3e4) return res.json({ ok: false, reason: "cooldown", retryInSec: Math.ceil((3e4 - (nowMs - lastAt)) / 1e3) });
    await gate.set(nowMs);
    const usageRef = rtdb().ref(`config/dukaUsage/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`);
    let filesUsed = Number((await usageRef.once("value")).val() || 0);
    if (filesUsed >= 600) return res.json({ ok: false, reason: "daily-cap" });
    const startedAt = Date.now();
    const WALK_DEADLINE_MS = 45e3;
    const today = /* @__PURE__ */ new Date();
    const wanted = [];
    for (let i = 2; i < days + 2 && wanted.length < days; i++) wanted.push(new Date(today.getTime() - i * 864e5));
    const update = {};
    let filesFetched = 0;
    let oldest = null;
    let newest = null;
    let hitDeadline = false;
    for (let i = 0; i < wanted.length; i += 5) {
      if (Date.now() - startedAt > WALK_DEADLINE_MS) {
        hitDeadline = true;
        break;
      }
      const chunk = wanted.slice(i, i + 5);
      const files = await Promise.all(chunk.map((d) => fetchDukaDay(dukaSym, d)));
      filesUsed += files.filter(Boolean).length;
      if (oldest == null && newest == null && files.every((f) => f == null) && i >= 5) break;
      for (let k = 0; k < chunk.length; k++) {
        const buf = files[k];
        if (!buf) continue;
        filesFetched += 1;
        const bars = await decodeDukaDay(buf, code, chunk[k]);
        for (const b of bars) {
          update[String(b.t)] = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
          if (oldest == null || b.t < oldest) oldest = b.t;
          if (newest == null || b.t > newest) newest = b.t;
        }
      }
    }
    await usageRef.set(filesUsed);
    let written = 0;
    const entries = Object.entries(update);
    if (entries.length) {
      const ref = rtdb().ref(`fxBars/${code}`);
      for (let i = 0; i < entries.length; i += 2e3) {
        await ref.update(Object.fromEntries(entries.slice(i, i + 2e3)));
      }
      written = entries.length;
      const meta = (await rtdb().ref(`fxMeta/${code}`).once("value")).val() || {};
      await rtdb().ref(`fxMeta/${code}`).set({
        oldest: meta.oldest && oldest ? Math.min(meta.oldest, oldest) : oldest ?? meta.oldest ?? 0,
        newest: meta.newest && newest ? Math.max(meta.newest, newest) : newest ?? meta.newest ?? 0,
        updatedAt: nowMs
      });
    }
    return res.json({ ok: true, code, written, oldest, newest, files: filesFetched, note: hitDeadline ? "wall-clock budget reached \u2014 repeat after the 90s cooldown to continue" : void 0 });
  }
  if (action === "backfill-metals" && req.method === "POST") {
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const symbol = String(raw?.symbol || "").toUpperCase();
    if (symbol !== "XAUUSD" && symbol !== "XAGUSD") return res.json({ ok: false, reason: "not-a-metal" });
    const tf = String(raw?.tf || "1m");
    const gateRef = rtdb().ref(`config/metalsBackfillAt/${symbol}/${tf}`);
    const lastAt = Number((await gateRef.once("value")).val() || 0);
    const nowMs = Date.now();
    if (nowMs - lastAt < 3e4) return res.json({ ok: false, reason: "cooldown", retryInSec: Math.ceil((3e4 - (nowMs - lastAt)) / 1e3) });
    await gateRef.set(nowMs);
    const step = await runBackfillStep({
      symbol,
      tf,
      months: raw?.months != null ? Number(raw.months) : 240,
      // full genuine Dukascopy depth
      maxDays: raw?.maxDays != null ? Number(raw.maxDays) : 240
      // Phase 28: deeper per step
    });
    return res.json(step);
  }
  if (action === "hist-backfill" && req.method === "POST") {
    const adminUser = await requireAdmin(req);
    if (!adminUser) return res.status(403).json({ ok: false, error: "admin-only" });
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const symbol = String(raw?.symbol || "").toUpperCase().replace(/=X$/i, "");
    const tf = String(raw?.tf || "");
    if (!symbol || !tf) return res.json({ ok: false, error: "symbol+tf required" });
    const step = await runBackfillStep({
      symbol,
      tf,
      months: raw?.months != null ? Number(raw.months) : void 0,
      maxPages: raw?.maxPages != null ? Number(raw.maxPages) : void 0,
      force: !!raw?.force
    });
    return res.json(step);
  }
  if (action === "hist-range") {
    const sym = (symbols || bareCode).toUpperCase().replace(/=X$/i, "");
    const tf = (url.searchParams.get("tf") || "").trim();
    const from = toSec(url.searchParams.get("from"));
    const to = toSec(url.searchParams.get("to"));
    if (!sym || !tf || from == null || to == null || to <= from) {
      return res.json({ ok: false, error: "symbol, tf, from, to (epoch sec) required" });
    }
    const range2 = await readRange(sym, tf, from, Math.min(to, Math.floor(Date.now() / 1e3)));
    return res.json(range2);
  }
  if (action === "hist-status") {
    const sym = (symbols || bareCode).toUpperCase().replace(/=X$/i, "");
    const tfs = (url.searchParams.get("tfs") || "1m,5m,15m,30m,1h,4h,1d").split(",").map((s) => s.trim()).filter(Boolean);
    if (!sym) return res.json({ ok: false, error: "symbol required" });
    const rows = await coverageReport(sym, tfs);
    return res.json({ ok: true, symbol: sym, rows });
  }
  if (action === "purge-weekend" && req.method === "POST") {
    const adminUser = await requireAdmin(req);
    if (!adminUser) return res.status(403).json({ ok: false, error: "admin-only" });
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const wanted = Array.isArray(raw?.symbols) && raw.symbols.length ? raw.symbols : ["XAUUSD", "XAGUSD"];
    const now = Math.floor(Date.now() / 1e3);
    const from = now - 70 * 86400;
    const report = {};
    for (const symRaw of wanted) {
      const symbol = String(symRaw).toUpperCase();
      const code = symbol === "XAUUSD" ? "XAU" : symbol === "XAGUSD" ? "XAG" : null;
      if (!code) continue;
      const snap = await rtdb().ref(`spotTicks/${code}`).once("value");
      const obj = snap.val() || {};
      const entries = Object.entries(obj).map(([t, c]) => ({ t: Number(t), o: Number(c?.o) })).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o) && c.t >= from && c.t <= now);
      const intervals = closedIntervals(symbol, from, now);
      const toDelete = [];
      for (const c of entries) {
        let inside = false;
        for (const iv of intervals) {
          if (c.t >= iv.from && c.t < iv.to) {
            inside = true;
            break;
          }
        }
        if (inside) toDelete.push(String(c.t));
      }
      for (let i = 0; i < toDelete.length; i += 500) {
        const chunk = {};
        for (const k of toDelete.slice(i, i + 500)) chunk[k] = null;
        await rtdb().ref(`spotTicks/${code}`).update(chunk);
      }
      const removed = toDelete.length;
      report[symbol] = { removed, kept: entries.length - removed };
    }
    return res.json({ ok: true, report, at: Date.now() });
  }
  if (action === "import-hist" && req.method === "POST") {
    const adminUser = await requireAdmin(req);
    if (!adminUser) return res.status(403).json({ ok: false, error: "admin-only" });
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = String(raw?.symbol || "").toUpperCase().replace(/=X$/i, "");
    const tf = String(raw?.tf || "");
    if (!code || !tf) return res.json({ ok: false, error: "symbol+tf required" });
    if (!DUKA_MAP[code] && !DUKA_METALS[code]) return res.json({ ok: false, error: "unknown-symbol" });
    const validTfs = /* @__PURE__ */ new Set(["1m", "5m", "15m", "30m", "1h", "1d"]);
    if (!validTfs.has(tf)) return res.json({ ok: false, error: "unsupported-tf" });
    const bands = { XAUUSD: [100, 12e3], XAGUSD: [5, 200] };
    const [bandLo, bandHi] = bands[code] ?? [0.2, 600];
    const barsIn = Array.isArray(raw?.bars) ? raw.bars : [];
    const nowSec = Math.floor(Date.now() / 1e3);
    const depthFrom = nowSec - Number(HIST_MONTHS_CAP) * 30 * 86400;
    const tfSec = tf === "1m" ? 60 : tf === "5m" ? 300 : tf === "15m" ? 900 : tf === "30m" ? 1800 : tf === "1h" ? 3600 : 86400;
    const clean = [];
    let rejected = 0;
    for (const b of barsIn.slice(0, 5e4)) {
      const t = Math.floor(Number(b?.time ?? b?.t));
      const o = Number(b?.open ?? b?.o), h = Number(b?.high ?? b?.h), l = Number(b?.low ?? b?.l), c = Number(b?.close ?? b?.c);
      const v = Number(b?.volume ?? b?.v ?? 0);
      if (![t, o, h, l, c].every((x) => Number.isFinite(x)) || t <= 0) {
        rejected++;
        continue;
      }
      if (t % tfSec !== 0 || t > nowSec || t < depthFrom) {
        rejected++;
        continue;
      }
      if (h < Math.max(o, c) || l > Math.min(o, c) || h < l || l <= 0) {
        rejected++;
        continue;
      }
      if (o < bandLo || o > bandHi) {
        rejected++;
        continue;
      }
      clean.push({ time: t, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
    }
    clean.sort((a, b) => a.time - b.time);
    if (!clean.length) return res.json({ ok: false, error: "no-valid-bars", rejected });
    const provider = String(raw?.provider || "import").slice(0, 40);
    const sh = await writeShards(code, tf, clean, provider, { force: false });
    return res.json({
      ok: true,
      symbol: code,
      tf,
      provider,
      received: barsIn.length,
      accepted: clean.length,
      rejected,
      written: sh.written,
      skipped: sh.skipped,
      shardDays: sh.days.length,
      oldest: clean[0].time,
      newest: clean[clean.length - 1].time,
      note: sh.skipped > 0 ? `${sh.skipped} bars skipped \u2014 those day shards already exist (resume cursor continues deeper)` : void 0
    });
  }
  if (action === "import-fx" && req.method === "POST") {
    const adminUser = await requireAdmin(req);
    if (!adminUser) return res.status(403).json({ ok: false, reason: "admin-only" });
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = String(raw?.code || "").toUpperCase();
    if (!DUKA_MAP[code] && !DUKA_METALS[code]) return res.json({ ok: false, reason: "not-on-duka" });
    const bands = { XAUUSD: [100, 12e3], XAGUSD: [5, 200] };
    const [bandLo, bandHi] = bands[code] ?? [0.2, 600];
    const barsIn = Array.isArray(raw?.bars) ? raw.bars : [];
    const nowSec = Math.floor(Date.now() / 1e3);
    const update = {};
    for (const b of barsIn.slice(0, 5e4)) {
      const t = Math.floor(Number(b?.t));
      const o = Number(b?.o), h = Number(b?.h), l = Number(b?.l), c = Number(b?.c), v = Number(b?.v ?? 0);
      if (!Number.isFinite(t) || t % 60 !== 0 || t > Math.floor(nowSec / 60) * 60 || t < nowSec - 400 * 86400) continue;
      if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
      if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) continue;
      if (o < bandLo || o > bandHi) continue;
      update[String(t)] = { o, h, l, c, v: Math.round(v * 100) / 100 };
    }
    const entries = Object.entries(update);
    if (!entries.length) return res.json({ ok: false, reason: "no-valid-bars" });
    let oldest = null, newest = null;
    for (const [k, b] of entries) {
      const tk = Number(k);
      if (oldest == null || tk < oldest) oldest = tk;
      if (newest == null || tk > newest) newest = tk;
    }
    const ref = rtdb().ref(`fxBars/${code}`);
    for (let i = 0; i < entries.length; i += 2e3) {
      await ref.update(Object.fromEntries(entries.slice(i, i + 2e3)));
    }
    const meta = (await rtdb().ref(`fxMeta/${code}`).once("value")).val() || {};
    await rtdb().ref(`fxMeta/${code}`).set({
      oldest: meta.oldest && oldest ? Math.min(meta.oldest, oldest) : oldest ?? 0,
      newest: meta.newest && newest ? Math.max(meta.newest, newest) : newest ?? 0,
      updatedAt: Date.now()
    });
    return res.json({ ok: true, code, written: entries.length, oldest, newest });
  }
  if (batch) {
    const list = batch.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9^.=\-]{1,20}$/i.test(s)).slice(0, 20);
    if (!list.length) return res.status(200).json({ ok: true, quotes: [] });
    const payload = await cachedPayload(batchCache, list.slice().sort().join(","), BATCH_FRESH_MS, BATCH_STALE_MS, async () => {
      const tfx = await truefxQuotes();
      void recordFxLiveBids(Object.fromEntries(Object.entries(tfx).map(([c, q]) => [c, q.bid])));
      const quotes = await Promise.all(
        list.map(async (sym) => {
          const t = tfx[sym.replace(/=X$/, "")];
          if (t) return { symbol: sym, price: t.mid, previousClose: t.open, source: "truefx", live: true };
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6e3);
            const yres = await fetch(
              `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
              { headers: { "User-Agent": UA3, Accept: "application/json" }, signal: controller.signal }
            );
            clearTimeout(timer);
            if (!yres.ok) throw new Error(String(yres.status));
            const data = await yres.json();
            const meta = data?.chart?.result?.[0]?.meta || {};
            return { symbol: meta.symbol || sym, price: meta.regularMarketPrice ?? null, previousClose: meta.chartPreviousClose ?? null };
          } catch {
            return { symbol: sym, price: null, previousClose: null };
          }
        })
      );
      const failed = quotes.filter((q) => q.price == null);
      if (failed.length > 0) {
        const stooqSyms = failed.map((q) => stooqOf(q.symbol)).filter(Boolean);
        if (stooqSyms.length > 0) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6e3);
            const sres = await fetch(`https://stooq.com/q/l/?s=${stooqSyms.join("+")}&f=sd2t2ohlcv&h&e=csv`, {
              headers: { "User-Agent": UA3 },
              signal: controller.signal
            });
            clearTimeout(timer);
            if (sres.ok) {
              const bySym = csvToQuotes(await sres.text());
              for (const q of failed) {
                const sq = bySym[stooqOf(q.symbol)?.toLowerCase() || ""];
                if (sq?.price != null) {
                  q.price = sq.price;
                  q.previousClose = sq.previousClose;
                }
              }
            }
          } catch {
          }
        }
      }
      await Promise.all(list.map(async (sym, i) => {
        const code = SPOT_API_MAP[sym] ?? (sym === "XAUUSD" ? "XAU" : sym === "XAGUSD" ? "XAG" : null);
        if (!code) return;
        const spot = await fetchSpot(code);
        if (spot != null && quotes[i]) quotes[i].price = spot;
      }));
      if (quotes.every((q) => q.price == null)) throw new Error("ALL_SOURCES_FAILED");
      return { ok: true, quotes };
    });
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(payload);
  }
  if (!/^[A-Z0-9^.=\-]{1,20}$/i.test(symbols)) {
    return res.status(400).json({ ok: false, error: "BAD_SYMBOL" });
  }
  const yurl = periodMode ? `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?period1=${period1}&period2=${period2}&interval=${encodeURIComponent(interval)}&includePrePost=false` : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
  const yahooBarsFor = async (yahooSym, label) => {
    const res2 = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?${periodMode ? `period1=${period1}&period2=${period2}` : `range=${range}`}&interval=${interval}`,
      { headers: { "User-Agent": UA3, Accept: "application/json" } }
    );
    if (!res2.ok) throw new Error(`YAHOO_HTTP_${res2.status}`);
    const data = await res2.json();
    const chartResult = data?.chart?.result?.[0];
    if (!chartResult) throw new Error("YAHOO_NO_RESULT");
    const meta = chartResult.meta || {};
    if (String(meta.symbol || "").toUpperCase() !== yahooSym.toUpperCase()) throw new Error("YAHOO_SYMBOL_MISMATCH");
    const timestamps = chartResult.timestamp || [];
    const q = chartResult.indicators?.quote?.[0] || {};
    const raw = timestamps.map((t, i) => ({
      time: t,
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i] ?? 0
    })).filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) && b.time > 0);
    if (!raw.length) throw new Error("YAHOO_NO_BARS");
    const checked = validateBars(raw);
    const deduped = alignAndDedupe(checked.bars, INTERVAL_SECONDS[interval] ?? 60);
    const bars = deduped.bars;
    if (!bars.length) throw new Error("YAHOO_NO_VALID_BARS");
    const last = bars[bars.length - 1];
    return {
      source: label,
      delayed: true,
      delaySec: Math.max(0, Math.floor(Date.now() / 1e3) - last.time),
      identity: "futures",
      symbol: symbols,
      currency: meta.currency ?? null,
      regularMarketPrice: last.close,
      previousClose: meta.chartPreviousClose ?? null,
      bars
    };
  };
  const fromYahoo = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    const yres = await fetch(yurl, {
      headers: { "User-Agent": UA3, Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!yres.ok) throw new Error(`yahoo ${yres.status}`);
    const data = await yres.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("EMPTY_RESULT");
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const raw = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue;
      raw.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    const checked = validateBars(raw);
    const deduped = alignAndDedupe(checked.bars, INTERVAL_SECONDS[interval] ?? 60);
    const bars = deduped.bars;
    const meta = result.meta || {};
    let live = false;
    if (DUKA_MAP[bareCode] && !periodMode) {
      const t = (await truefxQuotes())[bareCode];
      if (t && marketHours(bareCode).open) void recordFxLiveBids({ [bareCode]: t.bid });
      if (t && marketHours(bareCode).open && mergeSpotBars(bars, t.bid, interval)) live = true;
    }
    if (DUKA_MAP[bareCode] && interval === "1m" && bars.length > 20) {
      const flat = bars.filter((b) => b.open === b.high && b.high === b.low && b.low === b.close).length;
      if (flat / bars.length >= (interval === "1m" ? 0.25 : 0.9)) {
        throw new Error(`FLAT_FX_OHLC: ${Math.round(100 * flat / bars.length)}% of ${symbols} 1m bars are O=H=L=C \u2014 close-only series, not candles`);
      }
    }
    const rmt = Number(meta.regularMarketTime);
    const delaySec = live ? 0 : Number.isFinite(rmt) && rmt > 0 ? Math.max(0, Math.floor(Date.now() / 1e3) - rmt) : void 0;
    return {
      source: live ? "truefx+yahoo" : "yahoo",
      delayed: !live,
      delaySec,
      // what the yahoo identifier actually represents for THIS request —
      // GC=F/SI=F are COMEX futures; the badge must never pass them off as spot
      identity: SPOT_API_MAP[symbols] ? "futures" : "spot",
      invalidBars: checked.invalid + deduped.dropped,
      // aligned-only bars are normalizations, not invalid
      symbol: meta.symbol || symbols,
      currency: meta.currency || null,
      regularMarketPrice: live ? bars[bars.length - 1].close : meta.regularMarketPrice ?? null,
      previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      bars
    };
  };
  const fromStooq = async () => {
    const sq = stooqOf(symbols);
    if (!sq) throw new Error("NO_STOOQ_MAP");
    if (interval === "1m") throw new Error("STOOQ_NO_1M");
    const si = STOOQ_INTERVAL[interval];
    if (!si) throw new Error("NO_STOOQ_INTERVAL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    const sres = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sq)}&i=${si}`, {
      headers: { "User-Agent": UA3 },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!sres.ok) throw new Error(`stooq ${sres.status}`);
    const bars = stooqCsvToBars(await sres.text());
    if (bars.length === 0) throw new Error("STOOQ_EMPTY");
    const perDay = si === "d" ? 1 : Math.round(1440 / Number(si));
    const days = range.endsWith("d") ? Number(range.slice(0, -1)) || 5 : range.endsWith("mo") ? Number(range.slice(0, -2)) * 30 || 150 : 5;
    let capped = periodMode ? bars.filter((b) => b.time >= period1 && b.time <= period2) : bars.slice(Math.max(0, bars.length - days * perDay));
    capped = capped;
    const last = capped[capped.length - 1];
    let live = false;
    const spotCode2 = SPOT_API_MAP[symbols];
    if (spotCode2 && !periodMode && last && marketHours(symbols).open) {
      const spot = await fetchSpot(spotCode2);
      if (spot != null && mergeSpotBars(capped, spot, si === "d" ? "1d" : interval === "5m" ? "5m" : interval)) live = true;
    }
    return {
      source: live ? "spot+stooq" : "stooq",
      delayed: !live,
      delaySec: live ? 0 : void 0,
      identity: "spot",
      symbol: symbols,
      currency: null,
      regularMarketPrice: last?.close ?? null,
      previousClose: capped.length > 1 ? capped[capped.length - 2].close : null,
      bars: capped
    };
  };
  const TD_FOREX = /* @__PURE__ */ new Set([
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "USDCHF",
    "USDCAD",
    "AUDUSD",
    "NZDUSD",
    "EURGBP",
    "EURJPY",
    "EURCHF",
    "EURAUD",
    "EURNZD",
    "EURCAD",
    "GBPJPY",
    "GBPCHF",
    "GBPAUD",
    "GBPCAD",
    "GBPNZD",
    "AUDJPY",
    "AUDNZD",
    "AUDCAD",
    "AUDCHF",
    "NZDJPY",
    "NZDCAD",
    "NZDCHF",
    "CADJPY",
    "CADCHF",
    "CHFJPY",
    "USDSGD",
    "USDNOK",
    "USDSEK",
    "USDZAR",
    "USDTRY",
    "USDMXN"
  ]);
  const TD_INTERVAL = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1h": "1h",
    "1d": "1day"
  };
  const fromYahooFutures = async () => {
    const fut = INDEX_FUTURES_FALLBACK[symbols];
    if (!fut) throw new Error("NO_FUTURES_FALLBACK");
    return yahooBarsFor(fut, "yahoo-futures");
  };
  const fromTwelveData = async () => {
    if (!TD_FOREX.has(bareCode)) throw new Error("NO_TD_MAP");
    const ti = TD_INTERVAL[interval];
    if (!ti) throw new Error("NO_TD_INTERVAL");
    const apiKey = await tdKey();
    if (!apiKey) throw new Error("NO_TD_KEY");
    const used = Number((await tdDayRef().once("value")).val() || 0);
    if (used >= TD_DAILY_BUDGET) throw new Error("TD_BUDGET_EXHAUSTED");
    const outputsize = interval === "1m" ? 5e3 : interval === "5m" ? 4e3 : 2e3;
    const fmt = (sec) => new Date(sec * 1e3).toISOString().slice(0, 19).replace("T", " ");
    let u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(`${bareCode.slice(0, 3)}/${bareCode.slice(3)}`)}&interval=${ti}&outputsize=${outputsize}&timezone=UTC&apikey=${apiKey}`;
    if (periodMode) u += `&start_date=${encodeURIComponent(fmt(period1))}&end_date=${encodeURIComponent(fmt(period2))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9e3);
    let d = null;
    try {
      const r = await fetch(u, { signal: controller.signal });
      d = await r.json();
    } catch (e) {
      throw new Error(`twelvedata ${String(e?.message || e).slice(0, 60)}`);
    } finally {
      clearTimeout(timer);
    }
    const values = Array.isArray(d?.values) ? d.values : [];
    if (!values.length) throw new Error(`TD: ${String(d?.message || "EMPTY").slice(0, 70)}`);
    await tdSpend(1);
    const raw = values.map((v) => ({
      time: Math.floor(Date.parse(String(v?.datetime || "").replace(" ", "T") + "Z") / 1e3),
      open: Number(v?.open),
      high: Number(v?.high),
      low: Number(v?.low),
      close: Number(v?.close),
      volume: 0
    })).filter((b) => Number.isFinite(b.time) && b.time > 0 && [b.open, b.high, b.low, b.close].every(Number.isFinite));
    const checked = validateBars(raw);
    const deduped = alignAndDedupe(checked.bars, INTERVAL_SECONDS[interval] ?? 60);
    const bars = deduped.bars;
    if (!bars.length) throw new Error("TD_NO_VALID_BARS");
    let live = false;
    if (!periodMode) {
      const t = (await truefxQuotes())[bareCode];
      if (t && marketHours(bareCode).open) void recordFxLiveBids({ [bareCode]: t.bid });
      if (t && marketHours(bareCode).open && mergeSpotBars(bars, t.bid, interval)) live = true;
    }
    const last = bars[bars.length - 1];
    return {
      source: live ? "truefx+twelvedata" : "twelvedata",
      delayed: !live,
      delaySec: live ? 0 : Math.max(0, Math.floor(Date.now() / 1e3) - last.time),
      identity: "spot",
      symbol: symbols,
      currency: null,
      regularMarketPrice: last.close,
      previousClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      bars
    };
  };
  const RANGE_DAILY_DAYS = { "1d": 2, "5d": 7, "1M": 32, "3M": 95, "6M": 190, "1y": 370, "5y": 1830, All: 1830, YTD: Math.max(10, Math.ceil((Date.now() - Date.UTC((/* @__PURE__ */ new Date()).getUTCFullYear(), 0, 1)) / 86400) + 10) };
  const DAILY_STORE_WINDOW_DAYS = 65;
  const fromFxStore = async () => {
    if (!DUKA_MAP[bareCode]) throw new Error("NO_FX_STORE");
    const sec = INTERVAL_SECONDS[interval];
    if (!sec) throw new Error("FX_STORE_INTRADAY_ONLY");
    const daily = sec === 86400;
    if (!daily && sec > 3600) throw new Error("FX_STORE_INTRADAY_ONLY");
    const meta = (await rtdb().ref(`fxMeta/${bareCode}`).once("value")).val() || {};
    const nowSec = Math.floor(Date.now() / 1e3);
    let t1, t2;
    if (periodMode) {
      t1 = period1;
      t2 = period2;
    } else if (daily) {
      const days = Math.min(RANGE_DAILY_DAYS[range] ?? DAILY_STORE_WINDOW_DAYS, DAILY_STORE_WINDOW_DAYS);
      t1 = nowSec - days * 86400;
      t2 = nowSec;
    } else {
      const days = range.endsWith("d") ? Number(range.slice(0, -1)) || 5 : 5;
      t1 = nowSec - days * 86400;
      t2 = nowSec;
    }
    const snap = await rtdb().ref(`fxBars/${bareCode}`).orderByKey().startAt(String(t1)).endAt(String(t2)).once("value");
    const val = snap.val() || {};
    const byTime = /* @__PURE__ */ new Map();
    for (const [k, b] of Object.entries(val)) {
      const time = Number(k);
      const o = Number(b?.o), h = Number(b?.h), l = Number(b?.l), c = Number(b?.c);
      if ([time, o, h, l, c].every(Number.isFinite) && time > 0 && o > 0 && h >= l && l > 0) {
        byTime.set(time, { time, open: o, high: h, low: l, close: c, volume: Number(b?.v ?? 0) });
      }
    }
    const live = await fxLiveMinutes(bareCode);
    for (const [time, m] of live) {
      if (time < t1 || time > t2 || byTime.has(time)) continue;
      byTime.set(time, { time, open: m.o, high: m.h, low: m.l, close: m.c, volume: m.s });
    }
    const raw = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (raw.length < 200 && !daily) throw new Error("FX_STORE_THIN");
    const island = minuteIslandFilter(raw);
    const checked = validateBars(island.bars);
    const deduped = alignAndDedupe(checked.bars, 60);
    const stale = staleRunFilter(repairOutlierExtremes(deduped.bars).bars);
    const m1 = stale.bars;
    if (!m1.length && !daily) throw new Error("FX_STORE_EMPTY_AFTER_VALIDATE");
    let bars = sec === 60 ? m1 : aggregateBars(m1, sec / 60);
    let dailyDeep = false;
    if (daily) {
      let deep = [];
      const sq = HIST_STOOQ[bareCode];
      if (sq) {
        try {
          const deepFrom = periodMode ? period1 : nowSec - Math.min(RANGE_DAILY_DAYS[range] ?? 1830, 1830) * 86400;
          deep = normalizeDailyAnchors((await fetchStooqBars(sq, "d")).filter((b) => b.time >= deepFrom - 86400)).map((b) => ({ ...b, time: Math.floor((b.time + 12 * 3600) / 86400) * 86400 })).filter((b) => b.time <= t2);
        } catch {
        }
      }
      bars = mergeFxStoreDaily(deep, bars);
      dailyDeep = deep.length > 0;
      if (!periodMode) {
        const minT = nowSec - Math.min(RANGE_DAILY_DAYS[range] ?? 1830, 1830) * 86400;
        bars = bars.filter((b) => b.time >= minT);
      }
    }
    const newest = bars.length ? bars[bars.length - 1].time : 0;
    if (!periodMode && newest < nowSec - (daily ? 5 * 86400 : 90 * 60)) {
      throw new Error("FX_STORE_STALE");
    }
    if (!bars.length) throw new Error("FX_STORE_EMPTY_AFTER_VALIDATE");
    const last = bars[bars.length - 1];
    return {
      source: daily ? dailyDeep ? "fx-store-daily+stooq-deep" : "stooq-deep" : "fx-store+live",
      delayed: newest < nowSec - 300,
      delaySec: Math.max(0, nowSec - newest),
      identity: "spot",
      symbol: bareCode,
      currency: null,
      regularMarketPrice: last.close,
      previousClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      bars,
      islandBars: island.rejected
    };
  };
  try {
    const cacheKey = periodMode ? `${symbols}|p:${Math.floor(period1 / 600)}-${Math.floor(period2 / 600)}|${interval}` : `${symbols}|${range}|${interval}`;
    const METALS_FIRST = symbols in SPOT_API_MAP;
    const fxIntraday = !!DUKA_MAP[bareCode] && (INTERVAL_SECONDS[interval] ?? 60) <= 3600;
    const payload = await cachedPayload(barsCache, cacheKey, BARS_FRESH_MS, BARS_STALE_MS, async () => {
      const chain = METALS_FIRST ? [fromStooq, fromYahoo] : fxIntraday && interval === "1m" ? [fromFxStore, fromYahoo, fromTwelveData, fromYahooFutures, fromStooq] : fxIntraday ? [fromYahoo, fromFxStore, fromTwelveData, fromYahooFutures, fromStooq] : interval === "1d" ? [fromFxStore, fromStooq, fromYahoo, fromTwelveData, fromYahooFutures] : [fromYahoo, fromTwelveData, fromYahooFutures, fromStooq, fromFxStore];
      let firstErr = null;
      let staleResult = null;
      const annotateCloseOnly = (r) => {
        if (!fxIntraday || interval !== "1m" || !Array.isArray(r?.bars) || !r.bars.length) return r;
        if (String(r.source || "").startsWith("fx-store")) return r;
        const share = flatShare(r.bars);
        if (share < 0.05) return r;
        return {
          ...r,
          closeOnlyShare: Math.round(share * 1e3) / 10,
          // percent, 1 decimal
          note: `close-only share ${Math.round(share * 100)}% (Yahoo 1m fallback) \u2014 genuine Dukascopy OHLC replaces this as the store heals`
        };
      };
      for (const attempt of chain) {
        try {
          const result = { ok: true, ...await attempt() };
          const tooStale = !periodMode && interval !== "1d" && Number(result.delaySec ?? 0) > 2700;
          if (tooStale) {
            if (!staleResult || Number(result.delaySec ?? 0) < Number(staleResult.delaySec ?? 1e9)) staleResult = result;
            continue;
          }
          return annotateCloseOnly(result);
        } catch (e) {
          if (attempt === fromStooq && String(e?.message).includes("STOOQ_NO_1M")) {
            if (!firstErr) firstErr = e;
            continue;
          }
          if (!firstErr) firstErr = e;
        }
      }
      if (staleResult) return annotateCloseOnly(staleResult);
      throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
    });
    let final = payload;
    if (fxIntraday && !periodMode && Array.isArray(final?.bars) && final.bars.length) {
      const marketLive = marketHours(bareCode).open;
      try {
        const t = (await truefxQuotes())[bareCode];
        const bidConsistent = typeof final.source === "string" && final.source.startsWith("fx-store");
        if (t?.bid > 0 && bidConsistent && marketLive) {
          void recordFxLiveBids({ [bareCode]: t.bid });
          const bars2 = final.bars.slice();
          if (mergeSpotBars(bars2, t.bid, interval)) {
            final = { ...final, bars: bars2, at: Date.now(), liveTail: "truefx" };
          }
        } else if (t?.bid > 0 && marketLive) {
          void recordFxLiveBids({ [bareCode]: t.bid });
        }
      } catch {
      }
    }
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json(final);
  } catch (err) {
    return res.status(200).json({ ok: false, error: "FEED_UNAVAILABLE", detail: String(err?.message || err) });
  }
});
export {
  quotes_default as default,
  mergeSpotBars
};
