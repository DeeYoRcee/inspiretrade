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
  const action = (url.searchParams.get("action") || "").trim();
  if (action === "spot-history") {
    const code = (url.searchParams.get("code") || "XAU").toUpperCase() === "XAG" ? "XAG" : "XAU";
    const snap = await rtdb().ref(`spotTicks/${code}`).once("value");
    const obj = snap.val() || {};
    const now = Math.floor(Date.now() / 1e3);
    const minT = now - 8 * 86400;
    const candles = Object.entries(obj).map(([t, c]) => ({ t: Number(t), o: Number(c?.o), h: Number(c?.h), l: Number(c?.l), c: Number(c?.c), s: Number(c?.s || 0) })).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o) && c.t >= minT).sort((a, b) => a.t - b.t);
    return res.json({ ok: true, code, candles });
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
      const incoming = (Array.isArray(rec?.candles) ? rec.candles.slice(0, 40) : []).map((c) => ({ t: Number(c?.t), o: Number(c?.o), h: Number(c?.h), l: Number(c?.l), c: Number(c?.c), s: Number(c?.s || 1) })).filter((c) => {
        if (!Number.isFinite(c.t) || c.t % 60 !== 0 || c.t > minuteNow || c.t < now - 8 * 86400) return false;
        if (![c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v) && v > 0)) return false;
        if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c) || c.h < c.l) return false;
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
        update[String(inc.t)] = {
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
    const [loPrice, hiPrice] = code === "XAG" ? [5, 500] : [100, 2e4];
    const recordedSnap = await rtdb().ref(`spotTicks/${code}`).once("value");
    const recorded = recordedSnap.val() || {};
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
      const update = {};
      for (const v of values) {
        const t = Math.floor(Date.parse(String(v?.datetime || "").replace(" ", "T") + "Z") / 1e3);
        const o = Number(v?.open), h = Number(v?.high), l = Number(v?.low), c = Number(v?.close);
        if (!Number.isFinite(t) || t % 60 !== 0 || t > minuteNow || t < oldestAllowed) continue;
        if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
        if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) continue;
        if (o < loPrice || o > hiPrice) continue;
        const existing = recorded[String(t)];
        if (existing && Number(existing.s || 0) >= 1) continue;
        update[String(t)] = { o, h, l, c, s: 0 };
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
    const spotCode = SPOT_API_MAP[symbols];
    let live = false;
    if (spotCode && !periodMode) {
      const spot = await fetchSpot(spotCode);
      if (spot != null && mergeSpotBars(bars, spot, interval)) live = true;
    }
    const rmt = Number(meta.regularMarketTime);
    const delaySec = live ? 0 : Number.isFinite(rmt) && rmt > 0 ? Math.max(0, Math.floor(Date.now() / 1e3) - rmt) : void 0;
    return {
      source: live ? "spot+yahoo" : "yahoo",
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
    let live = false;
    const spotCode2 = SPOT_API_MAP[symbols];
    if (spotCode2 && !periodMode && last) {
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
  const fromTwelveData = async () => {
    if (!TD_FOREX.has(symbols)) throw new Error("NO_TD_MAP");
    const ti = TD_INTERVAL[interval];
    if (!ti) throw new Error("NO_TD_INTERVAL");
    const apiKey = await tdKey();
    if (!apiKey) throw new Error("NO_TD_KEY");
    const used = Number((await tdDayRef().once("value")).val() || 0);
    if (used >= TD_DAILY_BUDGET) throw new Error("TD_BUDGET_EXHAUSTED");
    const outputsize = interval === "1m" ? 5e3 : interval === "5m" ? 4e3 : 2e3;
    const fmt = (sec) => new Date(sec * 1e3).toISOString().slice(0, 19).replace("T", " ");
    let u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(`${symbols.slice(0, 3)}/${symbols.slice(3)}`)}&interval=${ti}&outputsize=${outputsize}&timezone=UTC&apikey=${apiKey}`;
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
    const last = bars[bars.length - 1];
    return {
      source: "twelvedata",
      delayed: true,
      delaySec: Math.max(0, Math.floor(Date.now() / 1e3) - last.time),
      identity: "spot",
      symbol: symbols,
      currency: null,
      regularMarketPrice: last.close,
      previousClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      bars
    };
  };
  try {
    const cacheKey = periodMode ? `${symbols}|p:${Math.floor(period1 / 600)}-${Math.floor(period2 / 600)}|${interval}` : `${symbols}|${range}|${interval}`;
    const METALS_FIRST = symbols in SPOT_API_MAP;
    const payload = await cachedPayload(barsCache, cacheKey, BARS_FRESH_MS, BARS_STALE_MS, async () => {
      const chain = METALS_FIRST ? [fromStooq, fromYahoo] : [fromYahoo, fromTwelveData, fromStooq];
      let firstErr = null;
      for (const attempt of chain) {
        try {
          return { ok: true, ...await attempt() };
        } catch (e) {
          if (attempt === fromStooq && String(e?.message).includes("STOOQ_NO_1M")) {
            if (!firstErr) firstErr = e;
            continue;
          }
          if (!firstErr) firstErr = e;
        }
      }
      throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
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
