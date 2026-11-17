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

// api/_src/quotes.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
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
  const tzOffsetMs = (dateStr) => {
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
      time = Math.floor((Date.parse(`${d}T${t}:00Z`) - tzOffsetMs(d)) / 1e3);
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
var inflight = /* @__PURE__ */ new Map();
var BARS_FRESH_MS = 12e3;
var BARS_STALE_MS = 6e4;
var BATCH_FRESH_MS = 3e4;
var BATCH_STALE_MS = 12e4;
function pruneCache(cache, staleMs) {
  if (cache.size < 64) return;
  const cutoff = Date.now() - staleMs * 2;
  for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}
async function doFetch(cache, key, fetcher) {
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const payload = await fetcher();
      cache.set(key, { at: Date.now(), payload });
      return payload;
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
  }
  return p;
}
async function cachedPayload(cache, key, freshMs, staleMs, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < freshMs) return hit.payload;
  if (hit && Date.now() - hit.at < staleMs) {
    if (!inflight.has(key)) void doFetch(cache, key, fetcher).catch(() => {
    });
    pruneCache(cache, staleMs);
    return hit.payload;
  }
  try {
    const payload = await doFetch(cache, key, fetcher);
    pruneCache(cache, staleMs);
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
var quotes_default = handle(async (req, res) => {
  await requireUser(req);
  const url = new URL(req.url || "/", "http://localhost");
  const batch = (url.searchParams.get("symbols") || "").trim();
  const symbols = (url.searchParams.get("symbol") || "").trim();
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
  if (batch) {
    const list = batch.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9^.=\-]{1,20}$/i.test(s)).slice(0, 20);
    if (!list.length) return res.status(200).json({ ok: true, quotes: [] });
    const payload = await cachedPayload(batchCache, list.slice().sort().join(","), BATCH_FRESH_MS, BATCH_STALE_MS, async () => {
      const quotes = await Promise.all(
        list.map(async (sym) => {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6e3);
            const yres = await fetch(
              `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
              { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal }
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
              headers: { "User-Agent": UA },
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
        const code = SPOT_API_MAP[sym];
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
  const fromYahoo = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    const yres = await fetch(yurl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!yres.ok) throw new Error(`yahoo ${yres.status}`);
    const data = await yres.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("EMPTY_RESULT");
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue;
      bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    const meta = result.meta || {};
    const spotCode = SPOT_API_MAP[symbols];
    let live = false;
    if (spotCode && !periodMode) {
      const spot = await fetchSpot(spotCode);
      if (spot != null && mergeSpotBars(bars, spot, interval)) live = true;
    }
    return {
      source: live ? "spot+yahoo" : "yahoo",
      delayed: !live,
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
      headers: { "User-Agent": UA },
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
    return {
      source: "stooq",
      delayed: true,
      symbol: symbols,
      currency: null,
      regularMarketPrice: last?.close ?? null,
      previousClose: capped.length > 1 ? capped[capped.length - 2].close : null,
      bars: capped
    };
  };
  try {
    const cacheKey = periodMode ? `${symbols}|p:${Math.floor(period1 / 600)}-${Math.floor(period2 / 600)}|${interval}` : `${symbols}|${range}|${interval}`;
    const payload = await cachedPayload(barsCache, cacheKey, BARS_FRESH_MS, BARS_STALE_MS, async () => {
      try {
        return { ok: true, ...await fromYahoo() };
      } catch (e) {
        try {
          return { ok: true, ...await fromStooq() };
        } catch (e2) {
          throw new Error(`yahoo: ${String(e?.message || e)}; stooq: ${String(e2?.message || e2)}`);
        }
      }
    });
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(200).json({ ok: false, error: "FEED_UNAVAILABLE", detail: String(err?.message || err) });
  }
});
export {
  quotes_default as default,
  mergeSpotBars
};
