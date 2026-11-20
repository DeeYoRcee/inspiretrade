/**
 * GET /api/quotes?symbol=EURUSD=X&range=5d&interval=1m
 *
 * Server-side proxy for real (sometimes delayed) market data. Primary source:
 * the public Yahoo Finance chart API — Yahoo blocks browser CORS, so the
 * client cannot call it directly, and provider credentials (TwelveData /
 * AlphaVantage) are not configured in this deployment.
 *
 * Fallback source: stooq.com CSV (free, no key, generous to datacenter IPs).
 * Yahoo regularly rate-limits Vercel serverless IPs (HTTP 429/999), which made
 * every non-crypto instrument fail. When Yahoo errors, we transparently fall
 * back to stooq — same bars shape, marked source:"stooq", delayed:true.
 * Responses are cached at the edge (s-maxage) to keep upstream request volume
 * low and stay inside Vercel Hobby function limits.
 */
import { handle, requireUser, requireAdmin, rtdb } from "./lib/firebase";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** yahoo symbol → stooq symbol (verified against stooq's CSV endpoints). */
const STOOQ_MAP: Record<string, string> = {
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
  "^FTSE": "^ukx",
};

/**
 * Phase 18: cash-index futures fallback. Yahoo's cash-index intraday feed
 * (^NDX etc.) can serve day-old bars from datacenter IPs while the INDEX
 * FUTURES contracts on the same API stay fresh (verified: ^NDX 944 min vs
 * NQ=F 10 min). A futures contract is a different instrument, so the
 * fallback result carries identity:"futures" and the badge says Futures
 * fallback — never silently mixed into a spot chart.
 */
const INDEX_FUTURES_FALLBACK: Record<string, string> = {
  "^NDX": "NQ=F",
  "^DJI": "YM=F",
  "^GSPC": "ES=F",
};

const stooqOf = (sym: string) => STOOQ_MAP[sym] ?? (sym.endsWith("=X") ? sym.slice(0, -2).toLowerCase() : null);

function csvToQuotes(csv: string): Record<string, { price: number | null; previousClose: number | null }> {
  const out: Record<string, { price: number | null; previousClose: number | null }> = {};
  const lines = csv.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 7) continue;
    const close = Number(cols[6]);
    const open = Number(cols[3]);
    out[cols[0].toLowerCase()] = {
      price: Number.isFinite(close) && close > 0 ? close : null,
      previousClose: Number.isFinite(open) && open > 0 ? open : null,
    };
  }
  return out;
}

/** stooq intraday/daily CSV → bars. Intraday timestamps are German local
 * wall time (CET in winter, CEST in summer) — the offset is resolved per bar
 * date via the Intl timezone DB, never hardcoded (a fixed +1h shifted every
 * candle by one hour across the whole summer half of the year). */
function stooqCsvToBars(csv: string): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  const lines = csv.trim().split(/\r?\n/);
  // Europe/Berlin UTC offset (ms) at 12:00 UTC of the given date (CET/CEST aware)
  const tzOffsetMs = (dateStr: string): number => {
    try {
      const noonUTC = Date.parse(`${dateStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date(noonUTC));
      const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
      const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
      return asUTC - noonUTC;
    } catch {
      return 3600_000; // fall back to CET
    }
  };
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const [d, t, o, h, l, c, v] = cols;
    const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
    if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0)) continue;
    let time: number;
    if (t && /^\d{2}:\d{2}$/.test(t)) {
      time = Math.floor((Date.parse(`${d}T${t}:00Z`) - tzOffsetMs(d)) / 1000);
    } else {
      time = Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
    }
    bars.push({ time, open, high, low, close, volume: Number(v) || 0 });
  }
  return bars;
}

const STOOQ_INTERVAL: Record<string, string> = { "1m": "5", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "d" };

// ---------------------------------------------------------------------------
// In-process cache (per warm serverless instance) with stale-while-revalidate.
//
// WHY: the client calls us through authedFetch, which sends an Authorization
// header — and Vercel never edge-caches responses to authorized requests, so
// the s-maxage headers below are dead code. Every client poll (10s × every
// user) therefore hit Yahoo directly, which is exactly what triggers Yahoo's
// IP rate limits (429/999) and silently pushed whole sessions onto the stooq
// fallback — 15+ minutes old data, i.e. the chart "always lagging behind".
// This cache collapses concurrent polls into at most one upstream call per
// TTL window per instance: fewer 429s → fewer stooq fallbacks → the chart
// stays on the fresher Yahoo source.
// ---------------------------------------------------------------------------
type CacheEntry = { at: number; payload: unknown };
const barsCache = new Map<string, CacheEntry>();
const batchCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const BARS_FRESH_MS = 12000; // client polls every 10s → every 2nd poll served from cache
const BARS_STALE_MS = 60000; // beyond this revalidate in place; stale still beats an error
const BATCH_FRESH_MS = 30000;
const BATCH_STALE_MS = 120000;

function pruneCache(cache: Map<string, CacheEntry>, staleMs: number) {
  if (cache.size < 64) return;
  const cutoff = Date.now() - staleMs * 2;
  for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}

/** Coalesced upstream fetch: one request per key regardless of caller count. */
async function doFetch(cache: Map<string, CacheEntry>, key: string, fetcher: () => Promise<unknown>): Promise<unknown> {
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const payload = await fetcher();
      cache.set(key, { at: Date.now(), payload });
      return payload;
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, p);
  }
  return p;
}

/**
 * fresh → serve as-is; stale → serve immediately + background revalidate;
 * miss → fetch (falling back to the last known payload instead of an error
 * when both upstream sources die).
 */
async function cachedPayload(
  cache: Map<string, CacheEntry>,
  key: string,
  freshMs: number,
  staleMs: number,
  fetcher: () => Promise<unknown>,
): Promise<unknown> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < freshMs) return hit.payload;
  if (hit && Date.now() - hit.at < staleMs) {
    if (!inflight.has(key)) void doFetch(cache, key, fetcher).catch(() => { /* keep stale */ });
    pruneCache(cache, staleMs);
    return hit.payload;
  }
  try {
    const payload = await doFetch(cache, key, fetcher);
    pruneCache(cache, staleMs);
    return payload;
  } catch (e) {
    if (hit) return hit.payload; // old data beats an error state
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Live spot overlay for precious metals (gold / silver).
//
// Yahoo's own chart candles trail 5-15 min behind the market — that is the
// whole "gold chart always lags" complaint. gold-api.com serves a free,
// keyless spot price that (verified live) matches Yahoo's GC=F
// regularMarketPrice to the cent, refreshing within seconds. We paint that
// spot onto the current bar so the tail of the chart is live while older
// bars stay Yahoo's. Fail-open everywhere: if the spot service is down,
// stale, or the interval is unknown, we simply return plain Yahoo data.
// ---------------------------------------------------------------------------
const SPOT_API_MAP: Record<string, string> = { "GC=F": "XAU", "SI=F": "XAG" };
const SPOT_TTL_MS = 30000;       // spot refresh window (gold-api updates every few seconds)
const SPOT_MAX_AGE_MS = 600000;  // spot older than 10 min = closed market — never paint it
const spotCache = new Map<string, { at: number; price: number }>();

async function fetchSpot(code: string): Promise<number | null> {
  const cached = spotCache.get(code);
  if (cached && Date.now() - cached.at < SPOT_TTL_MS) return cached.price;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://api.gold-api.com/price/${code}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const data: any = await res.json();
    const price = Number(data?.price);
    const updatedAt = Date.parse(data?.updatedAt || "") || 0;
    if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
    if (updatedAt && Date.now() - updatedAt > SPOT_MAX_AGE_MS) throw new Error("STALE_SPOT"); // weekend / closed
    spotCache.set(code, { at: Date.now(), price });
    return price;
  } catch {
    return cached?.price ?? null; // transient error → last known spot
  }
}

import {
  validateBars, alignAndDedupe, spotMergeGuard, bucketStart, minuteIslandFilter,
  type RawBar,
} from "../../shared/feed-validation";
import { aggregateBars } from "../../shared/terminal";
import { DUKA_MAP, fetchDukaDay, decodeDukaDay } from "./lib/duka";

/**
 * TrueFX free real-time feed (Phase 17, moved to lib/truefx.ts in Phase 18) —
 * no key, anonymous CSV, covers the 10 majors live. The lib exposes the
 * genuine BID and ASK plus MID; the CHART paints BID (Dukascopy's free
 * history is BID-side, broker charts plot bid) while execution quotes use
 * MID. Format: PAIR,ts_ms,bigBid,pipsBid,bigAsk,pipsAsk,high,low,open —
 * price = bigFigure concatenated with points ("1.09"+"921" → 1.09921).
 */
import { truefxQuotes } from "./lib/truefx";

// ---- Phase 20: TrueFX live-minute recorder ---------------------------------
// Yahoo's FX intraday 1m bars are CLOSE-ONLY (O=H=L=C on every bar — verified
// 2026-11-19: EURUSD=X 6712/6712, GBPUSD=X 2493/2493 flat) and the Dukascopy
// store publishes with a 1-2 day lag, so TODAY's session has no real OHLC
// source at all. The recorder fills that hole with genuine data: every
// request that already fetches TrueFX folds the observed BID into an RTDB
// minute candle (fxLive/{code}/{minute} = {o,h,l,c,s}) — the same
// self-recording contract the metals engine uses. Candles exist only where
// ticks were actually observed (a 10s chart poll ≈ 6 samples/minute), gaps
// stay gaps, nothing is fabricated. fxBars (full-tick Dukascopy OHLC) wins
// wherever both exist; fxLive fills the publication gap.
type FxLiveMinute = { o: number; h: number; l: number; c: number; s: number };
const FXLIVE_MAX_AGE_SEC = 3 * 86400;
const fxLiveCache = new Map<string, { at: number; minutes: Map<number, FxLiveMinute> }>();

async function fxLiveMinutes(code: string): Promise<Map<number, FxLiveMinute>> {
  const nowMs = Date.now();
  const hit = fxLiveCache.get(code);
  if (hit && nowMs - hit.at < 60000) return hit.minutes;
  const minutes = new Map<number, FxLiveMinute>();
  try {
    const snap = await rtdb().ref(`fxLive/${code}`).once("value");
    const obj: Record<string, any> = snap.val() || {};
    const cutoff = Math.floor(nowMs / 1000) - FXLIVE_MAX_AGE_SEC;
    for (const [k, v] of Object.entries(obj)) {
      const t = Number(k);
      const o = Number(v?.o), h = Number(v?.h), l = Number(v?.l), c = Number(v?.c), s = Number(v?.s || 1);
      if (!Number.isFinite(t) || t < cutoff || t % 60 !== 0) continue;
      if (![o, h, l, c].every(Number.isFinite) || o <= 0) continue;
      minutes.set(t, { o, h, l, c, s: Number.isFinite(s) ? s : 1 });
    }
  } catch { /* RTDB hiccup — the recorder continues with an empty map */ }
  fxLiveCache.set(code, { at: nowMs, minutes });
  return minutes;
}

/** Fold observed TrueFX BIDs into the live-minute recorder (best-effort —
 * a recording failure must never block the market-data response). */
async function recordFxLiveBids(bids: Record<string, number | undefined>): Promise<void> {
  const t = Math.floor(Date.now() / 1000 / 60) * 60;
  const update: Record<string, FxLiveMinute> = {};
  const touched: string[] = [];
  try {
    for (const [code, bidRaw] of Object.entries(bids)) {
      const bid = Number(bidRaw);
      if (!DUKA_MAP[code] || !(bid > 0)) continue;
      const minutes = await fxLiveMinutes(code);
      const ex = minutes.get(t);
      const merged: FxLiveMinute = ex
        ? { o: ex.o, c: bid, h: Math.max(ex.h, bid), l: Math.min(ex.l, bid), s: ex.s + 1 }
        : { o: bid, c: bid, h: bid, l: bid, s: 1 };
      minutes.set(t, merged);
      update[`fxLive/${code}/${t}`] = merged;
      touched.push(code);
    }
    if (Object.keys(update).length) {
      await rtdb().ref().update(update);
      // occasional lazy prune — the recorder only ever reads the last 3 days
      if (Math.random() < 0.05) {
        const cutoff = String(t - FXLIVE_MAX_AGE_SEC);
        for (const code of touched) {
          void rtdb().ref(`fxLive/${code}`).orderByKey().endAt(cutoff).limitToFirst(2000).remove().catch(() => {});
        }
      }
    }
  } catch { /* recording is best-effort */ }
}

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60, "2m": 120, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "60m": 3600, "1h": 3600, "90m": 5400, "1d": 86400,
};

/** Paint the live spot onto the current bar: update the open bucket in place,
 * or open the next bucket (open = previous close — the candle body stays
 * continuous, no seam jump even if the basis moves).
 *
 * Phase 10 guards (root cause of the "thin last candles + abnormally long
 * wicks" defect): Yahoo's REST history can lag minutes behind — painting the
 * CURRENT spot bucket then fabricated a bar spanning |spot − delayed close|
 * (giant wick) plus a run of empty buckets on the time axis. We now refuse
 * to paint unless the history is at most ONE bucket behind, and reject spot
 * outliers (|spot/lastClose − 1| > 2% — corrupted tick; metals cannot move
 * 2% inside one candle). Genuine prices are never modified. */
export function mergeSpotBars(
  bars: { time: number; open: number; high: number; low: number; close: number; volume?: number }[],
  spot: number,
  interval: string,
): boolean {
  const sec = INTERVAL_SECONDS[interval];
  if (!sec) return false;
  const guard = spotMergeGuard(bars, spot, { sec });
  if (!guard.ok) return false;
  const now = Math.floor(Date.now() / 1000);
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
  return false; // spot bucket precedes the last bar (clock skew) — leave bars untouched
}

// ---- Twelve Data shared budget (Phase 16c) ---------------------------------
// The repo is public — the key lives only in RTDB config/providerKeys/
// twelvedata or the TWELVE_DATA_API_KEY env var. A daily RTDB counter keeps
// the free tier (8 req/min, 800 credits/day) from being drained by history
// fallbacks and backfills; both spend from the same daily budget.
const TD_DAILY_BUDGET = 260;
const tdDayRef = () => rtdb().ref(`config/tdUsage/${new Date().toISOString().slice(0, 10)}`);
const tdSpend = async (n = 1) => {
  try {
    await tdDayRef().transaction((cur: any) => Number(cur || 0) + n);
  } catch { /* budget tracking is best-effort */ }
};
const tdKey = async (): Promise<string> => {
  const env = String(process.env.TWELVE_DATA_API_KEY || "");
  if (/^[a-f0-9]{32}$/i.test(env)) return env;
  const stored = String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
  return /^[a-f0-9]{32}$/i.test(stored) ? stored : "";
};

export default handle(async (req, res) => {
  await requireUser(req);

  const url = new URL(req.url || "/", "http://localhost");
  const batch = (url.searchParams.get("symbols") || "").trim();
  let symbols = (url.searchParams.get("symbol") || "").trim();
  // Phase 17: the catalog's yahoo identifiers carry an "=X" suffix for forex
  // (EURUSD=X) — the Dukascopy/TrueFX/TD integrations key on the bare code,
  // so normalize once at the front door. Yahoo itself accepts both spellings.
  const bareCode = symbols.replace(/=X$/i, "");
  const range = (url.searchParams.get("range") || "5d").trim();
  const interval = (url.searchParams.get("interval") || "1m").trim();
  // Optional arbitrary epoch window (replay/backtest history loader). Accepts
  // seconds or milliseconds; Yahoo's chart API takes seconds.
  const toSec = (v: string | null) => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e11 ? n / 1000 : n);
  };
  const period1 = toSec(url.searchParams.get("period1"));
  const period2 = toSec(url.searchParams.get("period2"));
  const periodMode = period1 != null && period2 != null && period2 > period1;

  // ---- Phase 16: self-recorded spot candles (XAU / XAG) ------------------
  // There is no free keyless provider of genuine XAUUSD-SPOT 1m OHLC history
  // (Yahoo spot symbols are delisted, stooq sits behind a browser PoW
  // challenge, institutional feeds need credentials), and Yahoo's GC=F is a
  // COMEX futures contract — a DIFFERENT instrument that must never be mixed
  // into a spot chart. Instead the terminal records its own real spot
  // candles: every 1s gold-api tick observed by any client is folded into a
  // minute candle and merged here (o=earliest, c=latest, h/l envelope,
  // samples=max). Gaps stay gaps — nothing is fabricated.
  const action = (url.searchParams.get("action") || "").trim();
  if (action === "spot-history") {
    const code = (url.searchParams.get("code") || "XAU").toUpperCase() === "XAG" ? "XAG" : "XAU";
    const snap = await rtdb().ref(`spotTicks/${code}`).once("value");
    const obj: Record<string, any> = snap.val() || {};
    const now = Math.floor(Date.now() / 1000);
    const minT = now - 8 * 86400;
    const candles = Object.entries(obj)
      .map(([t, c]) => ({ t: Number(t), o: Number(c?.o), h: Number(c?.h), l: Number(c?.l), c: Number(c?.c), s: Number(c?.s || 0) }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o) && c.t >= minT)
      .sort((a, b) => a.t - b.t);
    return res.json({ ok: true, code, candles });
  }
  if (action === "spot-record" && req.method === "POST") {
    const raw = typeof (req as any).body === "string" ? JSON.parse((req as any).body || "{}") : ((req as any).body || {});
    const records: any[] = Array.isArray(raw?.records) ? raw.records.slice(0, 4) : [];
    const now = Math.floor(Date.now() / 1000);
    const minuteNow = Math.floor(now / 60) * 60;
    let accepted = 0;
    for (const rec of records) {
      const code = rec?.code === "XAG" ? "XAG" : rec?.code === "XAU" ? "XAU" : null;
      if (!code) continue;
      const incoming = (Array.isArray(rec?.candles) ? rec.candles.slice(0, 40) : [])
        .map((c: any) => ({ t: Number(c?.t), o: Number(c?.o), h: Number(c?.h), l: Number(c?.l), c: Number(c?.c), s: Number(c?.s || 1) }))
        .filter((c: any) => {
          // same validity rules as the client (shared/spot-tail logic, inlined
          // for the bundled function): aligned, sane envelope, ≤ 8 days old
          if (!Number.isFinite(c.t) || c.t % 60 !== 0 || c.t > minuteNow || c.t < now - 8 * 86400) return false;
          if (![c.o, c.h, c.l, c.c].every((v: number) => Number.isFinite(v) && v > 0)) return false;
          if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c) || c.h < c.l) return false;
          if (!Number.isFinite(c.s) || c.s < 1 || c.s > 60) return false;
          return true;
        });
      if (!incoming.length) continue;
      const ref = rtdb().ref(`spotTicks/${code}`);
      const snap = await ref.once("value");
      const existing: Record<string, any> = snap.val() || {};
      const update: Record<string, { o: number; h: number; l: number; c: number; s: number }> = {};
      for (const inc of incoming) {
        const ex = existing[String(inc.t)];
        if (!ex) { update[String(inc.t)] = { o: inc.o, h: inc.h, l: inc.l, c: inc.c, s: inc.s }; accepted += 1; continue; }
        // deterministic merge (mirror of client mergeSpotCandles): the stored
        // candle holds the earlier open, the incoming one the newest close,
        // high/low/samples take the envelope.
        // Phase 18: a PROVIDER bar (s = 0 — genuine Twelve Data minute OHLC)
        // must not be degraded by a 1-2 sample recorded dot: only its envelope
        // expands; with s ≥ 3 the observations are dense enough to take over
        // the close honestly.
        update[String(inc.t)] = Number(ex.s || 0) === 0 && inc.s < 3
          ? { o: Number(ex.o) || inc.o, c: Number(ex.c) || inc.c, h: Math.max(inc.h, Number(ex.h) || inc.h), l: Math.min(inc.l, Number(ex.l) || inc.l), s: Math.max(inc.s, Number(ex.s || 0)) }
          : {
              o: Number(ex.o) || inc.o,
              c: inc.c,
              h: Math.max(inc.h, Number(ex.h) || inc.h),
              l: Math.min(inc.l, Number(ex.l) || inc.l),
              s: Math.max(inc.s, Number(ex.s || 0)),
            };
        accepted += 1;
      }
      if (Object.keys(update).length) await ref.update(update);
    }
    return res.json({ ok: true, accepted });
  }

  // ---- Twelve Data spot backfill (Phase 16) -------------------------------
  // The repo is PUBLIC, so the provider key must never be committed. It lives
  // server-side only: RTDB `config/providerKeys/twelvedata` (written by an
  // admin via set-provider-key) or the TWELVE_DATA_API_KEY env var. A caller
  // may also pass the key for a single call (transit over HTTPS, not stored
  // unless the caller is an admin and store=true).
  if (action === "set-provider-key" && req.method === "POST") {
    const adminUser = await requireAdmin(req);
    const raw = typeof (req as any).body === "string" ? JSON.parse((req as any).body || "{}") : ((req as any).body || {});
    const key = String(raw?.key || "").trim();
    if (!/^[a-f0-9]{32}$/i.test(key)) return res.status(400).json({ ok: false, error: "BAD_KEY" });
    await rtdb().ref("config/providerKeys/twelvedata").set(key);
    return res.json({ ok: true, stored: true });
  }
  if (action === "backfill-spot" && req.method === "POST") {
    const raw = typeof (req as any).body === "string" ? JSON.parse((req as any).body || "{}") : ((req as any).body || {});
    const code = raw?.code === "XAG" ? "XAG" : "XAU";
    const pages = Math.min(Math.max(Number(raw?.pages) || 8, 1), 8); // TD free tier: 8 req/min
    // resolve the key: explicit (this call only) → stored config → env
    let key = /^[a-f0-9]{32}$/i.test(String(raw?.key || "")) ? String(raw.key) : "";
    if (!key) {
      key = String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
      if (!key) key = String(process.env.TWELVE_DATA_API_KEY || "");
    }
    if (!/^[a-f0-9]{32}$/i.test(key)) return res.json({ ok: false, reason: "no-key" });
    // store only on an explicit admin request — never persist caller-supplied keys silently
    if (raw?.store === true) {
      try {
        await requireAdmin(req);
        if (/^[a-f0-9]{32}$/i.test(String(raw?.key || ""))) await rtdb().ref("config/providerKeys/twelvedata").set(String(raw.key));
      } catch { /* non-admin: key is used for this call only */ }
    }
    // cooldown: one backfill per code per 2 min (protects the 8 req/min budget)
    const gateRef = rtdb().ref(`config/backfillAt/${code}`);
    const lastAt = Number((await gateRef.once("value")).val() || 0);
    const nowMs = Date.now();
    if (nowMs - lastAt < 120000) return res.json({ ok: false, reason: "cooldown", retryInSec: Math.ceil((120000 - (nowMs - lastAt)) / 1000) });
    await gateRef.set(nowMs);

    const symbol = code === "XAG" ? "XAG/USD" : "XAU/USD";
    const used = Number((await tdDayRef().once("value")).val() || 0);
    if (used >= TD_DAILY_BUDGET) return res.json({ ok: false, reason: "td-budget-exhausted" });
    const nowSec = Math.floor(Date.now() / 1000);
    const minuteNow = Math.floor(nowSec / 60) * 60;
    const oldestAllowed = nowSec - 60 * 86400; // 60 days of 1m is plenty for M1→D1
    const [loPrice, hiPrice] = code === "XAG" ? [5, 500] : [100, 20000]; // price-band identity
    // existing minutes with self-recorded ticks (s ≥ 1) WIN over provider bars
    const recordedSnap = await rtdb().ref(`spotTicks/${code}`).once("value");
    const recorded: Record<string, any> = recordedSnap.val() || {};
    // Phase 20.4 — seam protection. gold-api's live feed lags ~16-30s
    // (measured 2026-11-19), but TD's own newest 1m bar can lag by minutes on
    // the free tier. A provider bar for a minute the recorder never observed,
    // landing right next to the live candle, renders minutes-old prices as if
    // current — the user sees the chart tail "3-4 candles behind" the real
    // market (TradingView). Rule: when TD's newest bar is stale (>2 min old)
    // AND the recorder's own freshest observation is recent (≤15 min — the
    // seam zone), provider bars NEWER than that observation are dropped and
    // the seam stays a short honest gap; the live 1s tail continues fresh.
    // When TD is fresh, or the recorder is long absent (tab closed for
    // hours), the provider fills the seam normally — continuity beats a
    // giant hole.
    let lastRecordedMin: number | null = null;
    for (const k of Object.keys(recorded)) {
      const t = Number(k);
      if (Number.isFinite(t) && Number(recorded[k]?.s || 0) >= 1 && (lastRecordedMin == null || t > lastRecordedMin)) lastRecordedMin = t;
    }
    let newestTdSeen = 0;
    let seamCap: number | null = null;
    let written = 0;
    let oldest: number | null = null;
    let endDate = "";
    for (let p = 0; p < pages; p++) {
      const qs = new URLSearchParams({ symbol, interval: "1min", outputsize: "5000", timezone: "UTC", apikey: key });
      if (endDate) qs.set("end_date", endDate);
      let d: any = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const r = await fetch(`https://api.twelvedata.com/time_series?${qs.toString()}`, { signal: controller.signal });
        clearTimeout(timer);
        d = await r.json();
        await tdSpend(1);
      } catch { break; }
      const values: any[] = Array.isArray(d?.values) ? d.values : [];
      if (!values.length) break;
      const valid: { t: number; o: number; h: number; l: number; c: number }[] = [];
      for (const v of values) {
        // datetime "YYYY-MM-DD HH:MM:SS" in UTC (timezone=UTC param)
        const t = Math.floor(Date.parse(String(v?.datetime || "").replace(" ", "T") + "Z") / 1000);
        const o = Number(v?.open), h = Number(v?.high), l = Number(v?.low), c = Number(v?.close);
        if (!Number.isFinite(t) || t % 60 !== 0 || t > minuteNow || t < oldestAllowed) continue;
        if (![o, h, l, c].every((x: number) => Number.isFinite(x) && x > 0)) continue;
        if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) continue;
        if (o < loPrice || o > hiPrice) continue;
        if (t > newestTdSeen) newestTdSeen = t;
        valid.push({ t, o, h, l, c });
      }
      if (seamCap == null && valid.length) {
        const tdDelayed = minuteNow - newestTdSeen > 120;
        seamCap = tdDelayed && lastRecordedMin != null && minuteNow - lastRecordedMin <= 15 * 60 ? lastRecordedMin : null;
      }
      const update: Record<string, { o: number; h: number; l: number; c: number; s: number }> = {};
      for (const b of valid) {
        if (seamCap != null && b.t > seamCap) continue; // seam protection (above)
        const t = b.t, o = b.o, h = b.h, l = b.l, c = b.c;
        const existing = recorded[String(t)];
        if (!existing) {
          // no self-recorded observation for this minute → genuine provider OHLC
          update[String(t)] = { o, h, l, c, s: 0 };
        } else if (
          Number(existing.s || 0) > 2 &&
          (Math.abs(c / Number(existing.c) - 1) > 0.02 || Math.abs(Number(existing.o) / c - 1) > 0.02)
        ) {
          // Phase 20.3: the recorded bar DISAGREES with the provider's real
          // minute by >2% — a stuck-price glitch (gold-api served a stale
          // price stamped fresh for hours on 2026-11-19; envelope-expanding
          // such bars kept the corruption alive). The provider's genuine
          // minute OHLC replaces the corrupted observations; the sample count
          // survives so the volume block keeps its honest meaning.
          update[String(t)] = { o, h, l, c, s: Number(existing.s || 1) };
        } else if (Number(existing.s || 0) <= 2) {
          // sparse recorded bar (1-2 observed samples ≈ a dot): replace the
          // sampled OHLC with the provider's genuine minute OHLC, but the
          // observed price is still real — keep it inside the envelope
          update[String(t)] = { o, h: Math.max(h, Number(existing.h) || h), l: Math.min(l, Number(existing.l) || l), c, s: Number(existing.s || 1) };
        } else if (Number(existing.h) < h || Number(existing.l) > l) {
          // well-recorded bar (s ≥ 3, price-consistent): the observations are
          // real, but the provider sees intra-minute extremes a 1s poll can
          // miss — expand the envelope only; observed open/close stay untouched
          update[String(t)] = {
            o: Number(existing.o), c: Number(existing.c), s: Number(existing.s || 1),
            h: Math.max(Number(existing.h) || h, h), l: Math.min(Number(existing.l) || l, l),
          };
        }
        // else: recorded envelope already covers the provider bar — keep it
        if (oldest == null || t < oldest) oldest = t;
      }
      if (Object.keys(update).length) {
        const entries = Object.entries(update);
        const ref = rtdb().ref(`spotTicks/${code}`);
        for (let i = 0; i < entries.length; i += 2000) {
          await ref.update(Object.fromEntries(entries.slice(i, i + 2000)));
        }
        written += entries.length;
      }
      if (values.length < 5000) break; // provider history exhausted
      endDate = String(values[values.length - 1].datetime); // walk further back
      await new Promise((r) => setTimeout(r, 250)); // stay inside 8 req/min
    }
    return res.json({ ok: true, code, written, oldest });
  }

  // ---- Dukascopy deep forex backfill (Phase 17) ----------------------------
  // Free, key-less, months-deep 1m forex history — one LZMA file per UTC day
  // per pair (publication lag ≈ 1–2 days, weekends 404). Bars land in
  // RTDB fxBars/{code}/{minute} = {o,h,l,c,v} and serve charts/replay via
  // fromFxStore. No credits to burn — just a cooldown + a light daily file
  // cap as an abuse guard.
  if (action === "backfill-fx" && req.method === "POST") {
    const raw = typeof (req as any).body === "string" ? JSON.parse((req as any).body || "{}") : ((req as any).body || {});
    const code = String(raw?.code || "").toUpperCase();
    const dukaSym = DUKA_MAP[code];
    if (!dukaSym) return res.json({ ok: false, reason: "not-on-duka" });
    const days = Math.min(Math.max(Number(raw?.days) || 30, 1), 35);
    const gate = rtdb().ref(`config/dukaBackfillAt/${code}`);
    const lastAt = Number((await gate.once("value")).val() || 0);
    const nowMs = Date.now();
    if (nowMs - lastAt < 90000) return res.json({ ok: false, reason: "cooldown", retryInSec: Math.ceil((90000 - (nowMs - lastAt)) / 1000) });
    await gate.set(nowMs);
    const usageRef = rtdb().ref(`config/dukaUsage/${new Date().toISOString().slice(0, 10)}`);
    let filesUsed = Number((await usageRef.once("value")).val() || 0);
    if (filesUsed >= 600) return res.json({ ok: false, reason: "daily-cap" });

    // walk back day by day, starting 2 days ago (publication lag), parallel
    // batches of 5 to stay well inside the function time budget
    const today = new Date();
    const wanted: Date[] = [];
    for (let i = 2; i < days + 2 && wanted.length < days; i++) wanted.push(new Date(today.getTime() - i * 86400000));
    const update: Record<string, { o: number; h: number; l: number; c: number; v: number }> = {};
    let filesFetched = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (let i = 0; i < wanted.length; i += 5) {
      const chunk = wanted.slice(i, i + 5);
      const files = await Promise.all(chunk.map((d) => fetchDukaDay(dukaSym, d)));
      filesUsed += files.filter(Boolean).length;
      // CDN unreachable? bail after the first empty batch — the function has
      // a hard wall-clock budget and must answer before Vercel kills it
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
      for (let i = 0; i < entries.length; i += 2000) {
        await ref.update(Object.fromEntries(entries.slice(i, i + 2000)));
      }
      written = entries.length;
      const meta = (await rtdb().ref(`fxMeta/${code}`).once("value")).val() || {};
      await rtdb().ref(`fxMeta/${code}`).set({
        oldest: meta.oldest && oldest ? Math.min(meta.oldest, oldest) : (oldest ?? meta.oldest ?? 0),
        newest: meta.newest && newest ? Math.max(meta.newest, newest) : (newest ?? meta.newest ?? 0),
        updatedAt: nowMs,
      });
    }
    return res.json({ ok: true, code, written, oldest, newest, files: filesFetched });
  }

  // ---- Bulk forex-store ingest (Phase 17) ----------------------------------
  // The Dukascopy CDN is flaky per network: when an environment CAN reach it,
  // it decodes day files locally and pushes the decoded bars here instead of
  // letting every function call hammer the CDN. Same validation contract as
  // backfill-fx; capped at 50k bars per call.
  if (action === "import-fx" && req.method === "POST") {
    const raw = typeof (req as any).body === "string" ? JSON.parse((req as any).body || "{}") : ((req as any).body || {});
    const code = String(raw?.code || "").toUpperCase();
    if (!DUKA_MAP[code]) return res.json({ ok: false, reason: "not-on-duka" });
    const barsIn: any[] = Array.isArray(raw?.bars) ? raw.bars : [];
    const nowSec = Math.floor(Date.now() / 1000);
    const update: Record<string, { o: number; h: number; l: number; c: number; v: number }> = {};
    for (const b of barsIn.slice(0, 50000)) {
      const t = Math.floor(Number(b?.t));
      const o = Number(b?.o), h = Number(b?.h), l = Number(b?.l), c = Number(b?.c), v = Number(b?.v ?? 0);
      if (!Number.isFinite(t) || t % 60 !== 0 || t > Math.floor(nowSec / 60) * 60 || t < nowSec - 400 * 86400) continue;
      if (![o, h, l, c].every((x: number) => Number.isFinite(x) && x > 0)) continue;
      if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) continue;
      if (o < 0.2 || o > 600) continue; // forex band identity
      update[String(t)] = { o, h, l, c, v: Math.round(v * 100) / 100 };
    }
    const entries = Object.entries(update);
    if (!entries.length) return res.json({ ok: false, reason: "no-valid-bars" });
    let oldest: number | null = null, newest: number | null = null;
    for (const [k, b] of entries) {
      const tk = Number(k);
      if (oldest == null || tk < oldest) oldest = tk;
      if (newest == null || tk > newest) newest = tk;
    }
    const ref = rtdb().ref(`fxBars/${code}`);
    for (let i = 0; i < entries.length; i += 2000) {
      await ref.update(Object.fromEntries(entries.slice(i, i + 2000)));
    }
    const meta = (await rtdb().ref(`fxMeta/${code}`).once("value")).val() || {};
    await rtdb().ref(`fxMeta/${code}`).set({
      oldest: meta.oldest && oldest ? Math.min(meta.oldest, oldest) : (oldest ?? 0),
      newest: meta.newest && newest ? Math.max(meta.newest, newest) : (newest ?? 0),
      updatedAt: Date.now(),
    });
    return res.json({ ok: true, code, written: entries.length, oldest, newest });
  }

  // ---- Batch quote mode: GET /api/quotes?symbols=EURUSD=X,GC=F ----------
  // Light last-price snapshot for the Market Watch panel.
  if (batch) {
    const list = batch.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9^.=\-]{1,20}$/i.test(s)).slice(0, 20);
    if (!list.length) return res.status(200).json({ ok: true, quotes: [] });
    const payload = await cachedPayload(batchCache, list.slice().sort().join(","), BATCH_FRESH_MS, BATCH_STALE_MS, async () => {
      // TrueFX first: one anonymous request prices the 10 majors in real
      // time — Yahoo only has to answer what TrueFX does not cover
      const tfx = await truefxQuotes();
      // Phase 20: every TrueFX fetch feeds the live-minute recorder — the
      // Market Watch poll alone keeps today's real OHLC accumulating for
      // every catalog major, even with no chart open
      void recordFxLiveBids(Object.fromEntries(Object.entries(tfx).map(([c, q]) => [c, q.bid])));
      const quotes = await Promise.all(
      list.map(async (sym) => {
        const t = tfx[sym.replace(/=X$/, "")];
        if (t) return { symbol: sym, price: t.mid, previousClose: t.open, source: "truefx", live: true };
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const yres = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
            { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal },
          );
          clearTimeout(timer);
          if (!yres.ok) throw new Error(String(yres.status));
          const data: any = await yres.json();
          const meta = data?.chart?.result?.[0]?.meta || {};
          return { symbol: meta.symbol || sym, price: meta.regularMarketPrice ?? null, previousClose: meta.chartPreviousClose ?? null };
        } catch {
          return { symbol: sym, price: null, previousClose: null };
        }
      }),
    );

    // stooq fallback for the symbols Yahoo failed on (one CSV call for all).
    const failed = quotes.filter((q) => q.price == null);
    if (failed.length > 0) {
      const stooqSyms = failed.map((q) => stooqOf(q.symbol)).filter(Boolean) as string[];
      if (stooqSyms.length > 0) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const sres = await fetch(`https://stooq.com/q/l/?s=${stooqSyms.join("+")}&f=sd2t2ohlcv&h&e=csv`, {
            headers: { "User-Agent": UA }, signal: controller.signal,
          });
          clearTimeout(timer);
          if (sres.ok) {
            const bySym = csvToQuotes(await sres.text());
            for (const q of failed) {
              const sq = bySym[stooqOf(q.symbol)?.toLowerCase() || ""];
              if (sq?.price != null) { q.price = sq.price; q.previousClose = sq.previousClose; }
            }
          }
        } catch { /* keep nulls — client shows offline state */ }
      }
    }

    // live spot overwrite for mapped metals — Yahoo's batch meta is delayed,
    // the gold-api spot is fresh (Market Watch should move in real time too).
    // Phase 18: the catalog symbols themselves (XAUUSD/XAGUSD) are accepted
    // alongside the yahoo futures identifiers — the spot price is the same
    // genuine source the chart and the execution engine use.
    await Promise.all(list.map(async (sym, i) => {
      const code = SPOT_API_MAP[sym] ?? (sym === "XAUUSD" ? "XAU" : sym === "XAGUSD" ? "XAG" : null);
      if (!code) return;
      const spot = await fetchSpot(code);
      if (spot != null && quotes[i]) quotes[i].price = spot;
    }));

    // total upstream failure must not poison the cache — throw so the caller
    // falls back to the last known payload or surfaces the offline state
    if (quotes.every((q) => q.price == null)) throw new Error("ALL_SOURCES_FAILED");
    return { ok: true, quotes };
    });

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(payload);
  }

  if (!/^[A-Z0-9^.=\-]{1,20}$/i.test(symbols)) {
    return res.status(400).json({ ok: false, error: "BAD_SYMBOL" });
  }

  const yurl = periodMode
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?period1=${period1}&period2=${period2}&interval=${encodeURIComponent(interval)}&includePrePost=false`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;

  const yahooBarsFor = async (yahooSym: string, label: string) => {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?${periodMode
        ? `period1=${period1}&period2=${period2}`
        : `range=${range}`}&interval=${interval}`,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`YAHOO_HTTP_${res.status}`);
    const data: any = await res.json();
    const chartResult = data?.chart?.result?.[0];
    if (!chartResult) throw new Error("YAHOO_NO_RESULT");
    const meta = chartResult.meta || {};
    if (String(meta.symbol || "").toUpperCase() !== yahooSym.toUpperCase()) throw new Error("YAHOO_SYMBOL_MISMATCH");
    const timestamps: number[] = chartResult.timestamp || [];
    const q = chartResult.indicators?.quote?.[0] || {};
    const raw: RawBar[] = timestamps.map((t: number, i: number) => ({
      time: t, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] ?? 0,
    })).filter((b: RawBar) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) && b.time > 0);
    if (!raw.length) throw new Error("YAHOO_NO_BARS");
    const checked = validateBars(raw);
    const deduped = alignAndDedupe(checked.bars, INTERVAL_SECONDS[interval] ?? 60);
    const bars = deduped.bars;
    if (!bars.length) throw new Error("YAHOO_NO_VALID_BARS");
    const last = bars[bars.length - 1];
    return {
      source: label,
      delayed: true,
      delaySec: Math.max(0, Math.floor(Date.now() / 1000) - last.time),
      identity: "futures",
      symbol: symbols,
      currency: meta.currency ?? null,
      regularMarketPrice: last.close,
      previousClose: meta.chartPreviousClose ?? null,
      bars,
    };
  };

  const fromYahoo = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const yres = await fetch(yurl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!yres.ok) throw new Error(`yahoo ${yres.status}`);
    const data: any = await yres.json();

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("EMPTY_RESULT");
    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const raw: RawBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue;
      raw.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    // Phase 10: validate every bar (repair H/L envelope, reject broken) and
    // align+dedupe timestamps — Yahoo's stream ends with a phantom bar that
    // is NOT minute-aligned (O=H=L=C, volume 0) and renders as a zero-width
    // vertical line at the right edge of the chart.
    const checked = validateBars(raw);
    const deduped = alignAndDedupe(checked.bars, INTERVAL_SECONDS[interval] ?? 60);
    const bars = deduped.bars;
    const meta = result.meta || {};
    // live tail overlay (Phase 18 rules):
    //  - metals: NOT painted here. SPOT_API_MAP's yahoo identifiers (GC=F/SI=F)
    //    are COMEX FUTURES contracts — painting the gold-api SPOT onto futures
    //    bars silently mixes two instruments (futures history + spot tail, with
    //    a genuine $ basis between them). The spot chart chain answers from
    //    stooq's genuine spot CSV first and paints there; if stooq is down the
    //    chart shows plainly-delayed futures with the honest DELAYED badge.
    //  - forex: TrueFX majors paint a real-time BID tail — bid, not mid, so
    //    the live bucket stays on the same price side as the Dukascopy BID
    //    history (execution quotes take the mid in trading/prices.ts).
    // spotMergeGuard inside mergeSpotBars refuses stale gaps and outlier
    // ticks; skipped in period mode: replay/backtest history must stay pure.
    let live = false;
    if (DUKA_MAP[bareCode] && !periodMode) {
      const t = (await truefxQuotes())[bareCode];
      // Phase 20: record the observed BID BEFORE any rejection below — every
      // request must feed the live-minute recorder or a cold session would
      // never accumulate today's real OHLC
      if (t) void recordFxLiveBids({ [bareCode]: t.bid });
      if (t && mergeSpotBars(bars, t.bid, interval)) live = true;
    }
    // Phase 20: Yahoo's FX intraday 1m bars are CLOSE-ONLY — every bar
    // arrives O=H=L=C (verified live 2026-11-19: EURUSD=X 6712/6712 flat,
    // GBPUSD=X 2493/2493). Rendered as candlesticks they are 1-2px dots —
    // the "tiny green dots" defect. A flat series is not candle data: reject
    // it so the chain serves genuine OHLC (the Dukascopy store ∪ TrueFX
    // live recorder, then Twelve Data) instead. Higher FX intervals carry
    // real OHLC (5m 11% flat = quiet minutes, 15m+ <1%) and stay.
    if (DUKA_MAP[bareCode] && interval === "1m" && bars.length > 20) {
      const flat = bars.filter((b) => b.open === b.high && b.high === b.low && b.low === b.close).length;
      if (flat / bars.length >= 0.9) {
        throw new Error(`FLAT_FX_OHLC: ${Math.round((100 * flat) / bars.length)}% of ${symbols} 1m bars are O=H=L=C — close-only series, not candles`);
      }
    }
    // measured delay: the provider's own market-time lag (0 when the live
    // spot merge succeeded) — the chart says "Delayed data (yahoo) · ~9 min"
    // instead of presenting delayed prices as real-time
    const rmt = Number(meta.regularMarketTime);
    const delaySec = live ? 0 : Number.isFinite(rmt) && rmt > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - rmt) : undefined;
    return {
      source: live ? "truefx+yahoo" : "yahoo",
      delayed: !live,
      delaySec,
      // what the yahoo identifier actually represents for THIS request —
      // GC=F/SI=F are COMEX futures; the badge must never pass them off as spot
      identity: SPOT_API_MAP[symbols] ? "futures" : "spot",
      invalidBars: checked.invalid + deduped.dropped, // aligned-only bars are normalizations, not invalid
      symbol: meta.symbol || symbols,
      currency: meta.currency || null,
      regularMarketPrice: live ? bars[bars.length - 1].close : (meta.regularMarketPrice ?? null),
      previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      bars,
    };
  };

  const fromStooq = async () => {
    const sq = stooqOf(symbols);
    if (!sq) throw new Error("NO_STOOQ_MAP");
    // stooq has no true 1-minute CSV: its finest intraday feed is 5-minute.
    // Serving that as "1m" mislabeled every candle — refuse instead and let
    // the client show the honest error/retry state.
    if (interval === "1m") throw new Error("STOOQ_NO_1M");
    const si = STOOQ_INTERVAL[interval];
    if (!si) throw new Error("NO_STOOQ_INTERVAL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const sres = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sq)}&i=${si}`, {
      headers: { "User-Agent": UA }, signal: controller.signal,
    });
    clearTimeout(timer);
    if (!sres.ok) throw new Error(`stooq ${sres.status}`);
    const bars = stooqCsvToBars(await sres.text());
    if (bars.length === 0) throw new Error("STOOQ_EMPTY");
    // Respect the requested window: period mode filters by epoch, otherwise
    // keep roughly the last `range` worth of bars.
    const perDay = si === "d" ? 1 : Math.round(1440 / Number(si));
    const days = range.endsWith("d") ? Number(range.slice(0, -1)) || 5 : range.endsWith("mo") ? Number(range.slice(0, -2)) * 30 || 150 : 5;
    let capped = periodMode
      ? bars.filter((b: any) => b.time >= (period1 as number) && b.time <= (period2 as number))
      : bars.slice(Math.max(0, bars.length - days * perDay));
    capped = capped as any[];
    const last = capped[capped.length - 1];
    // live spot paint works for the stooq source too — stooq's own tail lags
    // several minutes, and the gold-api spot is the genuine spot price
    let live = false;
    const spotCode2 = SPOT_API_MAP[symbols];
    if (spotCode2 && !periodMode && last) {
      const spot = await fetchSpot(spotCode2);
      if (spot != null && mergeSpotBars(capped, spot, si === "d" ? "1d" : interval === "5m" ? "5m" : interval)) live = true;
    }
    return {
      source: live ? "spot+stooq" : "stooq",
      delayed: !live,
      delaySec: live ? 0 : undefined,
      identity: "spot",
      symbol: symbols,
      currency: null,
      regularMarketPrice: last?.close ?? null,
      previousClose: capped.length > 1 ? capped[capped.length - 2].close : null,
      bars: capped,
    };
  };

  // ---- Twelve Data fallback (Phase 16c) ------------------------------------
  // Yahoo rate-limits datacenter IPs intermittently; stooq has no 1m CSV at
  // all, so a Yahoo blip used to strand forex M1 charts in a hard error state.
  // The user's Twelve Data free key covers every catalog forex pair (verified
  // 2026-11-19: majors, crosses and exotics — 26/26 OK, timezone=UTC), so it
  // slots into the chain between Yahoo and stooq. The repo is public — the
  // key lives only in RTDB config/providerKeys/twelvedata or the
  // TWELVE_DATA_API_KEY env var, and a daily RTDB budget counter keeps the
  // free tier (8 req/min, 800 credits/day) from being drained by fallbacks.
  const TD_FOREX = new Set([
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
    "EURGBP", "EURJPY", "EURCHF", "EURAUD", "EURNZD", "EURCAD",
    "GBPJPY", "GBPCHF", "GBPAUD", "GBPCAD", "GBPNZD",
    "AUDJPY", "AUDNZD", "AUDCAD", "AUDCHF",
    "NZDJPY", "NZDCAD", "NZDCHF", "CADJPY", "CADCHF", "CHFJPY",
    "USDSGD", "USDNOK", "USDSEK", "USDZAR", "USDTRY", "USDMXN",
  ]);
  const TD_INTERVAL: Record<string, string> = {
    "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "1d": "1day",
  };
  // hard daily ceiling for TD history-fallback requests — the counter itself
  // is module-level and shared with the spot backfill below
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
    const outputsize = interval === "1m" ? 5000 : interval === "5m" ? 4000 : 2000;
    const fmt = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
    // datetime comes back in real UTC (timezone=UTC) — the same anchors the
    // spot engine uses, so the merged chart stays minute-aligned
    let u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(`${bareCode.slice(0, 3)}/${bareCode.slice(3)}`)}&interval=${ti}&outputsize=${outputsize}&timezone=UTC&apikey=${apiKey}`;
    // period mode (replay/backtest) must honor the requested window: TD needs
    // explicit start/end in UTC, otherwise it returns the newest bars only
    if (periodMode) u += `&start_date=${encodeURIComponent(fmt(period1 as number))}&end_date=${encodeURIComponent(fmt(period2 as number))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let d: any = null;
    try {
      const r = await fetch(u, { signal: controller.signal });
      d = await r.json();
    } catch (e: any) {
      throw new Error(`twelvedata ${String(e?.message || e).slice(0, 60)}`);
    } finally {
      clearTimeout(timer);
    }
    const values: any[] = Array.isArray(d?.values) ? d.values : [];
    if (!values.length) throw new Error(`TD: ${String(d?.message || "EMPTY").slice(0, 70)}`);
    await tdSpend(1);
    const raw: RawBar[] = values.map((v) => ({
      time: Math.floor(Date.parse(String(v?.datetime || "").replace(" ", "T") + "Z") / 1000),
      open: Number(v?.open), high: Number(v?.high), low: Number(v?.low), close: Number(v?.close), volume: 0,
    })).filter((b) => Number.isFinite(b.time) && b.time > 0 && [b.open, b.high, b.low, b.close].every(Number.isFinite));
    const checked = validateBars(raw);
    const deduped = alignAndDedupe(checked.bars, INTERVAL_SECONDS[interval] ?? 60);
    const bars = deduped.bars;
    if (!bars.length) throw new Error("TD_NO_VALID_BARS");
    let live = false;
    if (!periodMode) {
      const t = (await truefxQuotes())[bareCode];
      // Phase 18: paint the genuine BID — same price side as the Dukascopy
      // BID history the store serves; mid is reserved for execution quotes
      // Phase 20: and feed the live-minute recorder
      if (t) void recordFxLiveBids({ [bareCode]: t.bid });
      if (t && mergeSpotBars(bars, t.bid, interval)) live = true;
    }
    const last = bars[bars.length - 1];
    return {
      source: live ? "truefx+twelvedata" : "twelvedata",
      delayed: !live,
      delaySec: live ? 0 : Math.max(0, Math.floor(Date.now() / 1000) - last.time),
      identity: "spot",
      symbol: symbols,
      currency: null,
      regularMarketPrice: last.close,
      previousClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      bars,
    };
  };

  // ---- Dukascopy store source (Phase 17, Phase 20 live union) --------------
  // Serves the months-deep 1m history pre-backfilled into fxBars/{code} by
  // the backfill-fx action, UNIONED with the TrueFX live-minute recorder
  // (fxLive/{code}) that fills Dukascopy's 1-2 day publication gap with real
  // observed BID candles. Zero upstream candle requests, zero credits. In
  // period mode (replay/backtest) it answers first when the window is stored;
  // in live range mode it is the primary FX intraday source — Yahoo's 1m FX
  // is close-only (FLAT_FX_OHLC) and Twelve Data is budget-limited.
  const fromFxStore = async () => {
    if (!DUKA_MAP[bareCode]) throw new Error("NO_FX_STORE");
    const sec = INTERVAL_SECONDS[interval];
    if (!sec || sec > 3600) throw new Error("FX_STORE_INTRADAY_ONLY");
    const meta = (await rtdb().ref(`fxMeta/${bareCode}`).once("value")).val() || {};
    const nowSec = Math.floor(Date.now() / 1000);
    let t1: number, t2: number;
    if (periodMode) {
      t1 = period1 as number;
      t2 = period2 as number;
    } else {
      const days = range.endsWith("d") ? Number(range.slice(0, -1)) || 5 : 5;
      t1 = nowSec - days * 86400;
      t2 = nowSec;
    }
    // store depth (Dukascopy BID 1m — full-tick OHLC, authoritative)
    const snap = await rtdb().ref(`fxBars/${bareCode}`)
      .orderByKey().startAt(String(t1)).endAt(String(t2)).once("value");
    const val: Record<string, any> = snap.val() || {};
    const byTime = new Map<number, RawBar>();
    for (const [k, b] of Object.entries(val)) {
      const time = Number(k);
      const o = Number(b?.o), h = Number(b?.h), l = Number(b?.l), c = Number(b?.c);
      if ([time, o, h, l, c].every(Number.isFinite) && time > 0 && o > 0 && h >= l && l > 0) {
        byTime.set(time, { time, open: o, high: h, low: l, close: c, volume: Number(b?.v ?? 0) });
      }
    }
    // live union: the recorder's real observed BID minutes fill the gap the
    // publication lag leaves; the store wins wherever both exist
    const live = await fxLiveMinutes(bareCode);
    for (const [time, m] of live) {
      if (time < t1 || time > t2 || byTime.has(time)) continue;
      byTime.set(time, { time, open: m.o, high: m.h, low: m.l, close: m.c, volume: m.s });
    }
    const raw = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (raw.length < 200) throw new Error("FX_STORE_THIN");
    // Phase 20: stuck-price glitch islands (a provider serving a stale price
    // with a fresh stamp) are rejected before they can reach a chart
    const island = minuteIslandFilter(raw);
    const checked = validateBars(island.bars);
    const deduped = alignAndDedupe(checked.bars, 60);
    const m1 = deduped.bars;
    if (!m1.length) throw new Error("FX_STORE_EMPTY_AFTER_VALIDATE");
    const bars = sec === 60 ? m1 : aggregateBars(m1, sec / 60);
    const newest = bars[bars.length - 1].time;
    // Live range mode: a stale union must NEVER become the primary chart —
    // a tail a day old looks broken. The recorder keeps the union fresh
    // whenever any user is polling; a truly dead session errors honestly.
    if (!periodMode && newest < nowSec - 90 * 60) {
      throw new Error("FX_STORE_STALE");
    }
    const last = bars[bars.length - 1];
    return {
      source: "fx-store+live",
      delayed: newest < nowSec - 300,
      delaySec: Math.max(0, nowSec - newest),
      identity: "spot",
      symbol: bareCode,
      currency: null,
      regularMarketPrice: last.close,
      previousClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      bars,
      islandBars: island.rejected,
    };
  };

  try {
    const cacheKey = periodMode
      ? `${symbols}|p:${Math.floor((period1 as number) / 600)}-${Math.floor((period2 as number) / 600)}|${interval}`
      : `${symbols}|${range}|${interval}`;
    // Instrument identity: for METALS the yahoo identifier is a COMEX
    // futures contract, but the instrument the user charts is SPOT gold /
    // silver. stooq's CSV IS spot — try it FIRST and fall back to Yahoo's
    // futures only as a clearly-labelled last resort (identity: "futures").
    // For FX and indices the yahoo symbol is already the genuine underlying.
    const METALS_FIRST = symbols in SPOT_API_MAP;
    // Phase 22 — computed OUTSIDE the cached builder: the live-tail repaint
    // below runs per REQUEST (bypassing the 12s bars cache for the tail only)
    const fxIntraday = !!DUKA_MAP[bareCode] && (INTERVAL_SECONDS[interval] ?? 60) <= 3600;
    const payload = await cachedPayload(barsCache, cacheKey, BARS_FRESH_MS, BARS_STALE_MS, async () => {
      // Phase 20 FX intraday order: Yahoo first (real OHLC on 5m+ and the
      // live-tail paint on every interval — and it feeds the fxLive recorder
      // before any rejection), then the store ∪ live recorder (genuine OHLC,
      // months deep, zero credits), THEN budget-limited Twelve Data. The old
      // order put TD second: Yahoo's 1m FX is close-only, so every M1 poll
      // drained the 260/day budget and the chart died by midday.
      const chain = METALS_FIRST
        ? [fromStooq, fromYahoo]
        : fxIntraday
          ? [fromYahoo, fromFxStore, fromTwelveData, fromYahooFutures, fromStooq]
          : [fromYahoo, fromTwelveData, fromYahooFutures, fromStooq, fromFxStore];
      let firstErr: unknown = null;
      // staleness-aware chain (Phase 18): a source can SUCCEED while serving
      // day-old bars (Yahoo's cash-index feed does exactly that for ^NDX from
      // datacenter IPs). For intraday live loads, remember the stale answer
      // and let later sources try to beat it; serve the freshest available.
      let staleResult: any = null;
      for (const attempt of chain) {
        try {
          const result = { ok: true, ...(await attempt()) };
          const tooStale = !periodMode && interval !== "1d" && Number(result.delaySec ?? 0) > 2700;
          if (tooStale) {
            if (!staleResult || Number(result.delaySec ?? 0) < Number(staleResult.delaySec ?? 1e9)) staleResult = result;
            continue;
          }
          return result;
        } catch (e: any) {
          // stooq has no 1m CSV at all — skip it silently for 1m and let the
          // next source answer instead of burying the real error
          if (attempt === fromStooq && String(e?.message).includes("STOOQ_NO_1M")) {
            if (!firstErr) firstErr = e;
            continue;
          }
          if (!firstErr) firstErr = e;
        }
      }
      if (staleResult) return staleResult;
      throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
    });
    // Phase 22 — live-tail repaint per REQUEST: the bars cache serves 12s-fresh
    // history, but TrueFX ticks are ~0s fresh (measured, phase19 matrix). For
    // FX intraday the CURRENT TrueFX BID is folded onto the tail on every
    // request — a 2s client poll now moves the last candle at genuine tick
    // cadence instead of the cache cadence. Same guards as the builder's own
    // paint (stale-gap + outlier refusal in mergeSpotBars; never in period
    // mode, never for futures-labeled payloads).
    let final: any = payload;
    if (fxIntraday && !periodMode && Array.isArray(final?.bars) && final.bars.length) {
      try {
        const t = (await truefxQuotes())[bareCode];
        if (t?.bid > 0 && mergeSpotBars(final.bars, t.bid, interval)) {
          void recordFxLiveBids({ [bareCode]: t.bid });
          final = { ...final, bars: final.bars, at: Date.now(), liveTail: "truefx" };
        }
      } catch { /* TrueFX hiccup — serve the cached payload as-is */ }
    }
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json(final);
  } catch (err: any) {
    return res.status(200).json({ ok: false, error: "FEED_UNAVAILABLE", detail: String(err?.message || err) });
  }
});
