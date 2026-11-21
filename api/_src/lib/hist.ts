/**
 * Phase 23 — deep historical data engine (api/_src/lib/hist.ts).
 *
 * Purpose: XAUUSD (and every other instrument) must not stop at the day the
 * self-recorder started. Root cause audit (Phase 23 §1): the metals chart
 * path never requested provider history (option A) and the recorded store is
 * read-filtered to 8 days (a D-class cap that made "Nov 12" the floor).
 *
 * This engine provides a persistent, provenance-tracked, day-sharded
 * historical store in RTDB, backfilled from FREE sources — with honest
 * limits, no fabricated candles and no futures-as-spot substitutions:
 *
 *   · stooq          — genuine SPOT xauusd/xagusd CSV + forex majors +
 *                      cash indices. Native 5m/15m/30m/1h/d1, deep archives.
 *                      (1m is NOT served by stooq — STOOQ_NO_1M.)
 *   · Dukascopy      — forex m1 BID candles via the official public bi5
 *                      datafeed (years deep, publication lag 1-2 days).
 *                      Metals are NOT served by the datafeed (verified
 *                      Phase 17: XAUUSD connections drop) — honest limit.
 *   · Twelve Data    — metals m1 (XAU/USD, XAG/USD) with the existing free
 *                      key, paginated walk-back, daily-budgeted and
 *                      RESUMABLE across function invocations via a cursor.
 *
 * Storage layout (one small write per UTC day per symbol+tf):
 *   hist/{symbol}/{tf}/{YYYY-MM-DD}      = JSON string of [t,o,h,l,c,v] rows
 *   histMeta/{symbol}/{tf}/{YYYY-MM-DD}  = provider tag (provenance)
 *   histState/{symbol}/{tf}              = backfill cursor + stats (resume)
 *   config/histTDUsage/{YYYY-MM-DD}      = TwelveData credits spent by THIS
 *                                          engine (independent 150/day cap so
 *                                          the live backfill never starves)
 *
 * Every write passes shared/feed-validation (envelope repair, H/L checks,
 * duplicate reconciliation, ordering). Rejections are counted, not silently
 * dropped.
 */
import { rtdb } from "./firebase";
import { validateBars, alignAndDedupe, repairOutlierExtremes, parseShardRow, type RawBar } from "../../../shared/feed-validation";
import { aggregateBars } from "../../../shared/terminal";
import { fetchDukaDay, decodeDukaDay, DUKA_MAP, DUKA_METALS } from "./duka";
import { inMarketHours, missingIntervals, HIST_MONTHS_CAP, clampBackfillMonths, backfillWindowFrom, READ_AGG_CHAIN, MAX_1M_FOLD_WINDOW_SEC, isIntradayTf, dropClosedAnchors, foldWeekComplete, assetClassOf, type AssetClass } from "./hist-sessions";
import { bucketStart } from "../../../shared/feed-validation";
import { normalizeDailyAnchors } from "../../../shared/terminal";
import { closedIntervals } from "../../../shared/market-hours";

export { inMarketHours, missingIntervals, HIST_MONTHS_CAP, clampBackfillMonths, backfillWindowFrom, READ_AGG_CHAIN, MAX_1M_FOLD_WINDOW_SEC };

// ---- symbol maps -----------------------------------------------------------

/** Terminal symbol → stooq ticker (genuine SPOT for metals, cash index for
 * indices, direct pair for forex). Mirrors quotes.ts STOOQ_MAP keyed on the
 * bare terminal code instead of the yahoo identifier. */
export const HIST_STOOQ: Record<string, string> = {
  XAUUSD: "xauusd", XAGUSD: "xagusd",
  EURUSD: "eurusd", GBPUSD: "gbpusd", USDJPY: "usdjpy", AUDUSD: "audusd",
  NZDUSD: "nzdusd", USDCAD: "usdcad", USDCHF: "usdchf",
  "^NDX": "^ndq", "^DJI": "^dji", "^GSPC": "^spx", "^GDAXI": "^dax", "^FTSE": "^ukx",
};

/** Terminal symbol → TwelveData pair (metals m1). */
const HIST_TD: Record<string, string> = { XAUUSD: "XAU/USD", XAGUSD: "XAG/USD" };

/** stooq interval id per timeframe (no 1m — stooq refuses it). */
const HIST_STOOQ_INTERVAL: Record<string, string> = {
  "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "d",
};

/** TwelveData credits this engine may spend per UTC day (independent of the
 * live-chain budget so a deep backfill can never starve the chart). */
const HIST_TD_DAILY_BUDGET = 150;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---- day shards ------------------------------------------------------------

const dayKey = (tSec: number): string => new Date(tSec * 1000).toISOString().slice(0, 10);

/** compact row tuple: [t, o, h, l, c, v] */
type ShardBar = [number, number, number, number, number, number];

/** Group validated bars into UTC day buckets, serialized as compact arrays. */
function groupByDay(bars: RawBar[]): Map<string, ShardBar[]> {
  const days = new Map<string, ShardBar[]>();
  for (const b of bars) {
    const k = dayKey(b.time);
    let arr = days.get(k);
    if (!arr) { arr = []; days.set(k, arr); }
    arr.push([b.time, b.open, b.high, b.low, b.close, b.volume ?? 0]);
  }
  return days;
}

export interface ShardsWritten { written: number; skipped: number; days: string[]; rejected: number }

/**
 * Persist bars into day shards with provenance + dedupe:
 *  · a day already tagged with the SAME provider is skipped (no repeated
 *    downloads, no duplicate timestamps — TEST J/H requirement);
 *  · a day tagged with a DIFFERENT provider wins for its own window only if
 *    it is empty here (first-provider-wins per day; mixing providers inside
 *    one day would create seams — recorded-live data always wins at READ).
 */
export async function writeShards(
  symbol: string, tf: string, raw: RawBar[], provider: string,
  opts?: { before?: number; after?: number; force?: boolean },
): Promise<ShardsWritten> {
  const checked = validateBars(raw);
  const aligned = alignAndDedupe(checked.bars, tf === "1d" ? 86400 : tf === "1W" ? 604800 : tf === "1M" ? 2592000 : 60);
  let rejected = checked.invalid + (raw.length - checked.bars.length);
  // Phase 31: closed-session anchors must never ENTER the deep store. The
  // Dukascopy weekend files for metals publish static quotes (a flat row
  // every minute all Saturday/Sunday — 2,879 such minutes were found live in
  // hist/XAUUSD/1m for the Nov 14-15 weekend), and the forex walk picks up
  // the minutes around the Fri-close/Sun-open boundary. Drop intraday bars
  // whose bucket anchor sits inside a closed interval; crypto passes an
  // empty interval list (closedIntervals returns []) so 24/7 is untouched.
  // 1d/1W/1M are exempt: their UTC-midnight/Monday anchors legitimately fall
  // in a closed interval while the day itself traded.
  let bars: RawBar[] = aligned.bars;
  if (isIntradayTf(tf) && assetClassOf(symbol) !== "crypto" && bars.length) {
    const g = dropClosedAnchors(bars, closedIntervals(symbol, bars[0].time - 2 * 86400, bars[bars.length - 1].time + 2 * 86400));
    rejected += g.dropped;
    bars = g.bars;
  }
  const out: ShardsWritten = { written: 0, skipped: 0, days: [], rejected };
  const metaRef = rtdb().ref(`histMeta/${symbol}/${tf}`);
  const dataRef = rtdb().ref(`hist/${symbol}/${tf}`);
  // Phase 30b BATCHED: per-day set() ops (3 RTDB round-trips × up to 240
  // days) blew the serverless wall clock — FUNCTION_INVOCATION_TIMEOUT, so
  // whole steps died after the CDN burst. One range read for dedupe +
  // multi-path update() chunks (25 days/call) collapse ~720 round-trips
  // into ~20. Idempotency and provider stamping unchanged.
  const dayMap = new Map<string, ShardBar[]>();
  for (const [day, rows] of groupByDay(bars)) {
    // optional window filter (resume cursors write only their slice)
    const t0 = rows[0][0];
    if (opts?.before != null && t0 >= opts.before) { out.skipped++; continue; }
    if (opts?.after != null && t0 < opts.after) { out.skipped++; continue; }
    dayMap.set(day, rows);
  }
  const days = [...dayMap.keys()].sort();
  let existing: Set<string> = new Set();
  if (!opts?.force && days.length) {
    const span = await metaRef.orderByKey().startAt(days[0]).endAt(days[days.length - 1]).once("value");
    existing = new Set(Object.keys(span.val() || {}));
  }
  const pending = days.filter((d) => opts?.force || !existing.has(d));
  out.skipped += days.length - pending.length;
  for (let i = 0; i < pending.length; i += 25) {
    const chunk = pending.slice(i, i + 25);
    const dataPatch: Record<string, string> = {};
    const metaPatch: Record<string, string> = {};
    for (const day of chunk) {
      const rows = dayMap.get(day)!;
      dataPatch[day] = rows.map((r) => JSON.stringify(r)).join("|");
      metaPatch[day] = provider;
    }
    try {
      await dataRef.update(dataPatch);
      await metaRef.update(metaPatch);
      out.written += chunk.length;
      out.days.push(...chunk);
    } catch (e) {
      // a chunk failure must not abort the run — the cursor allows retry
      break;
    }
  }
  return out;
}

/** Load day shards back into bar arrays. */
export async function readShards(symbol: string, tf: string, fromSec: number, toSec: number): Promise<{ bars: RawBar[]; providers: Record<string, number> }> {
  const fromDay = dayKey(fromSec);
  const toDay = dayKey(toSec);
  const snap = await rtdb().ref(`hist/${symbol}/${tf}`)
    .orderByKey().startAt(fromDay).endAt(toDay).once("value");
  const obj: Record<string, string> = snap.val() || {};
  const bars: RawBar[] = [];
  const providers: Record<string, number> = {};
  const metaSnap = await rtdb().ref(`histMeta/${symbol}/${tf}`)
    .orderByKey().startAt(fromDay).endAt(toDay).once("value");
  const meta: Record<string, string> = metaSnap.val() || {};
  for (const [day, blob] of Object.entries(obj)) {
    const p = meta[day] || "unknown";
    providers[p] = (providers[p] ?? 0) + 1;
    if (typeof blob !== "string" || !blob) continue;
    for (const row of blob.split("|")) {
      // Phase 30b: parseShardRow reads BOTH the JSON-array rows writeShards
      // emits and legacy CSV rows — the old inline CSV split rejected every
      // row (NaN), so hist-range returned nothing from the deep store.
      const a = parseShardRow(row);
      if (a) bars.push({ time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] });
    }
  }
  // Phase 29 Issue 2: daily shards written by the older stooq ingest carry
  // Europe/Berlin midnights (22:00/23:00 UTC of the previous day) while the
  // quotes route and the fold engine anchor UTC — folding both produced the
  // same day twice, one bar shifted half a day left. Re-anchor at READ time
  // (idempotent for UTC rows; only 1d granularity is touched).
  if (tf === "1d") return { bars: normalizeDailyAnchors(bars) as RawBar[], providers };
  // Phase 31: never SERVE closed-session anchors either — shards written
  // before the write-side gate still carry the poison (2,879 Sat/Sun static
  // rows in hist/XAUUSD/1m). Same intraday-only exemption as the write gate.
  if (isIntradayTf(tf) && assetClassOf(symbol) !== "crypto" && bars.length) {
    const g = dropClosedAnchors(bars, closedIntervals(symbol, fromSec - 2 * 86400, toSec + 2 * 86400));
    if (g.dropped) return { bars: g.bars, providers };
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, providers };
}

// ---- sources ---------------------------------------------------------------

/** stooq CSV → bars (Europe/Berlin wall-time resolution per bar date — the
 * same rule quotes.ts uses; intraday archives are decades deep for daily). */
export async function fetchStooqBars(stooqSym: string, interval: string): Promise<RawBar[]> {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${stooqSym}&i=${interval}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`STOOQ_${res.status}`);
  const text = await res.text();
  if (text.startsWith("<!DOCTYPE") || /access denied/i.test(text.slice(0, 200))) throw new Error("STOOQ_BLOCKED");
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
    } catch { return 3600_000; }
  };
  const bars: RawBar[] = [];
  const lines = text.trim().split(/\r?\n/);
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

const histTdDayRef = () => rtdb().ref(`config/histTDUsage/${new Date().toISOString().slice(0, 10)}`);
const histTdSpend = async (n = 1) => { try { await histTdDayRef().transaction((cur: any) => Number(cur || 0) + n); } catch { /* best-effort */ } };

export interface TDWalkResult { bars: RawBar[]; pages: number; oldest: number | null; exhausted: boolean }

/** TwelveData 1m walk-back (metals m1 fallback). Paginated: each page = 1
 * credit, ≤5000 rows, `end_date` steps back until `startSec` or the budget
 * stops it. RESUMABLE: callers persist `oldest` as the cursor. */
export async function tdWalkM1(apiKey: string, tdSym: string, startSec: number, endSec: number, maxPages: number, spentToday: number): Promise<TDWalkResult> {
  const bars: RawBar[] = [];
  let pages = 0;
  let end = endSec;
  let exhausted = false;
  const budgetLeft = HIST_TD_DAILY_BUDGET - spentToday;
  const pageCap = Math.min(maxPages, Math.max(0, budgetLeft));
  while (pages < pageCap && end > startSec) {
    const from = Math.max(startSec, end - 5000 * 60);
    const u = `https://api.twelvedata.com/time_series?apikey=${encodeURIComponent(apiKey)}&symbol=${encodeURIComponent(tdSym)}&interval=1min&outputsize=5000&timezone=UTC&start_date=${new Date(from * 1000).toISOString().slice(0, 19)}&end_date=${new Date(end * 1000).toISOString().slice(0, 19)}&format=JSON&order=ASC`;
    let json: any;
    try {
      const res = await fetch(u);
      json = await res.json();
    } catch {
      json = { status: "error" };
    }
    if (json?.status === "error" || !Array.isArray(json?.values)) { exhausted = true; break; }
    for (const v of json.values) {
      const t = Math.floor(Date.parse(`${String(v.datetime).replace(" ", "T")}Z`) / 1000);
      const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
      if (![t, o, h, l, c].every(Number.isFinite) || t <= 0 || o <= 0) continue;
      if (h < Math.max(o, c) || l > Math.min(o, c)) continue;
      bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Number(v.volume) || 0 });
    }
    pages++;
    histTdSpend(1);
    end = from - 1;
    if (json.values.length < 5000) { exhausted = true; break; } // provider's own floor
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, pages, oldest: bars.length ? bars[0].time : null, exhausted };
}

/** Dukascopy m1 walk-back (official public datafeed, years deep) — forex
 * pairs AND, since the Phase 23 re-test, metals. Parallel batches of 5 stay
 * inside the function wall-clock; the cursor resumes across runs. Phase 25:
 * a wall-clock DEADLINE (default 45s) bounds the worst case — the CDN's
 * 20s×2 retry timeouts on flaky days previously allowed a single call to
 * run for many minutes and risk the serverless execution limit; a deadline
 * overrun simply ends the step early and the cursor resumes next call. */
export async function dukaWalkM1(code: string, fromSec: number, toSec: number, maxDays: number, fileBudget: number, fileUsed: number, deadlineMs = 45000): Promise<{ bars: RawBar[]; files: number; oldest: number | null; timedOut: boolean }> {
  const dukaSym = DUKA_MAP[code] ?? DUKA_METALS[code];
  if (!dukaSym) throw new Error("NOT_ON_DUKA");
  const startedAt = Date.now();
  const bars: RawBar[] = [];
  let files = 0;
  let oldest: number | null = null;
  let timedOut = false;
  const days: Date[] = [];
  for (let day = Math.floor(toSec / 86400) * 86400; day >= fromSec && days.length < maxDays; day -= 86400) days.push(new Date(day * 1000));
  for (let i = 0; i < days.length && fileUsed + files < fileBudget; i += 5) {
    if (Date.now() - startedAt > deadlineMs) { timedOut = true; break; }
    const chunk = days.slice(i, i + 5);
    const bufs = await Promise.all(chunk.map((d) => fetchDukaDay(dukaSym, d, 14000)));
    if (oldest == null && files === 0 && bufs.every((b) => b == null) && i >= 5) break; // CDN unreachable
    for (let k = 0; k < chunk.length; k++) {
      const buf = bufs[k];
      if (!buf) continue; // no file (weekend/publication lag) — honest gap
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

// ---- backfill orchestration ------------------------------------------------

export interface BackfillRequest {
  symbol: string;          // terminal code: XAUUSD, EURUSD, ^NDX…
  tf: string;              // client timeframe key: 1m, 5m, 15m, 30m, 1h, 4h, 1d…
  months?: number;         // how deep to go (clamped by HIST_MONTHS_CAP — now the full genuine depth)
  maxPages?: number;       // TD pages this run may spend (default 10)
  maxDays?: number;        // Dukascopy day files this run may fetch (default 90)
  deadlineMs?: number;     // Dukascopy wall-clock budget per call (default 45000)
  force?: boolean;         // rewrite existing day shards
}

export interface BackfillResult {
  ok: boolean; symbol: string; tf: string; provider: string;
  written: number; skipped: number; rejected: number;
  oldest: number | null; newest: number | null;
  cursor: number | null;   // oldest time reached — pass back to resume deeper
  targetFrom: number | null; // epoch sec the current depth request reaches (progress denominator)
  done: boolean;           // true when the requested window is covered
  timedOut?: boolean;      // the wall-clock budget ended this step early (resume to continue)
  note?: string; error?: string;
}

// assetClassOf lives in hist-sessions.ts (pure + testable) — Phase 31 moved
// it there after the EURUSD→crypto misclassification (see that file).
export { assetClassOf } from "./hist-sessions";

/**
 * Run ONE backfill step for symbol+tf. Every step is idempotent (shard
 * dedupe) and resumable (cursor). Called by the admin action; interrupted
 * runs simply run again — TEST J.
 */
export async function runBackfillStep(req: BackfillRequest): Promise<BackfillResult> {
  const { symbol, tf } = req;
  // Phase 25 §3: clampBackfillMonths guards against absurd values only —
  // the cap itself now holds the FULL genuinely-available depth (240 months),
  // and per-call budgets + the resume cursor keep every request small.
  const months = clampBackfillMonths(req.months, tf);
  const now = Math.floor(Date.now() / 1000);
  const wantFrom = backfillWindowFrom(months, now);
  const stateRef = rtdb().ref(`histState/${symbol}/${tf}`);
  const state = (await stateRef.once("value")).val() || {};
  // resume: start the walk from the OLDEST bar already stored, never re-download
  const covered = state.oldest ? Math.min(state.oldest, wantFrom) : wantFrom;

  const base: BackfillResult = { ok: true, symbol, tf, provider: "", written: 0, skipped: 0, rejected: 0, oldest: state.oldest ?? null, newest: state.newest ?? null, cursor: state.oldest ?? null, targetFrom: wantFrom, done: false };

  try {
    // ---- crypto: Binance REST klines go back years — no engine needed ----
    if (assetClassOf(symbol) === "crypto") {
      return { ...base, provider: "binance", done: true, note: "crypto history is served natively by the Binance REST/WS engine (loadOlder pagination)" };
    }

    // ---- 1m: metals → TwelveData walk-back · forex → Dukascopy ----------
    if (tf === "1m") {
      // Phase 23: metals m1 ALSO rides the Dukascopy datafeed since the
      // 2026-11-20 re-test proved XAUUSD/XAGUSD serve genuine SPOT BID
      // candles (years deep, keyless). Dukascopy is primary (deep, free);
      // TwelveData stays as the keyed fallback for windows the feed skips.
      if (DUKA_METALS[symbol] || DUKA_MAP[symbol]) {
        // Phase 30: metals get a DEDICATED daily file budget — the old shared
        // config/dukaUsage counter meant any busy forex self-heal consumed the
        // whole 600/day cap and the metals walk never advanced (the Oct-22
        // wall). Same abuse-guard total, separate counters per purpose.
        const usageRef = rtdb().ref(`config/dukaUsage/${DUKA_METALS[symbol] ? "metals" : "fx"}/${new Date().toISOString().slice(0, 10)}`);
        const used = Number((await usageRef.once("value")).val() || 0);
        if (used >= 1200) return { ...base, ok: false, provider: "dukascopy", error: "daily-file-cap" };
        // Phase 26 RESUME FIX: the walk must continue BELOW the oldest stored
        // day, not from the newest again — the old `now - 2d` top made every
        // step re-download the same recent ~90 day files (all skipped at write
        // time) so repeated deep-fill runs never got past ~90 days of depth.
        const top = state.oldest != null ? Math.min(state.oldest, now - 2 * 86400) : now - 2 * 86400;
        // Phase 30b: deadline 22s — the old 50s walk + shard/fold writes blew
        // past the serverless wall clock (FUNCTION_INVOCATION_TIMEOUT, hkg1),
        // so the step died BEFORE its state write and progress never stuck.
        const walk = await dukaWalkM1(symbol, covered, top, req.maxDays ?? 240, 900, used, req.deadlineMs ?? 18000);
        const sh = await writeShards(symbol, tf, walk.bars, "dukascopy-bid", { force: req.force });
        await usageRef.set(used + walk.files);
        // Phase 30: fold the step's own minute bars into 1h/1d shards NOW —
        // deep hourly/daily chart layers then serve from shards without any
        // giant read-time 1m fold (MAX_1M_FOLD_WINDOW_SEC used to skip those
        // windows entirely, so H4/1D showed nothing old even WITH deep 1m).
        let foldedNote = "";
        try {
          if (walk.bars.length) {
            const hourBars = aggregateBars(walk.bars, 60) as RawBar[];
            const dayBars = aggregateBars(walk.bars, 1440) as RawBar[];
            const hs = await writeShards(symbol, "1h", hourBars, "dukascopy-bid-fold", { force: req.force });
            const ds = await writeShards(symbol, "1d", dayBars, "dukascopy-bid-fold", { force: req.force });
            foldedNote = ` · folds 1h+${hs.written}/1d+${ds.written}`;
          }
        } catch { /* fold is best-effort — the 1m shards are the source of truth */ }
        const newOldest = walk.oldest ?? state.oldest ?? null;
        const done = newOldest != null && newOldest <= covered;
        await stateRef.set({
          provider: "dukascopy-bid", oldest: newOldest, newest: state.newest ?? now - 2 * 86400,
          cursor: newOldest, targetFrom: wantFrom, done,
          files: (state.files ?? 0) + walk.files, written: (state.written ?? 0) + sh.written,
          rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(), error: null,
        });
        if (sh.written > 0 || done) {
          return { ...base, provider: "dukascopy-bid", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: newOldest, cursor: newOldest, done, timedOut: walk.timedOut, note: `${walk.files} day files${walk.timedOut ? " · wall-clock budget reached — resume to continue" : ""}${foldedNote}` };
        }
        if (walk.files === 0) {
          // honest surfacing: depth will not grow while the CDN is unreachable
          return { ...base, ok: false, provider: "dukascopy-bid", error: "CDN_UNREACHABLE", note: "Dukascopy returned 0 day files (429/503 rate-limit or network block) — depth resumes when the CDN answers; TwelveData fallback needs a stored key" };
        }
        // Phase 30b FALL-THROUGH FIX: files>0 but written==0 (the fetched
        // window is already stored / produced no new days) must NOT fall
        // through to TwelveData — that branch overwrote histState with
        // provider:"twelvedata" + done:true (observed live: oldest pinned at
        // 2026-10-11, done:true while targetFrom is 2006), which made every
        // later step report "already done" and the walk never resumed.
        return { ...base, provider: "dukascopy-bid", written: 0, skipped: sh.skipped, rejected: sh.rejected, oldest: newOldest, cursor: newOldest, done, timedOut: walk.timedOut, note: `${walk.files} day files fetched, ${sh.skipped} already stored — no new days in this window (resume walks deeper)${foldedNote}` };
      }
      const tdSym = HIST_TD[symbol];
      if (tdSym) {
        const apiKey = String(process.env.TWELVE_DATA_API_KEY || "") || String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
        if (!/^[a-f0-9]{32}$/i.test(apiKey)) return { ...base, ok: false, provider: "twelvedata", error: "no-key" };
        const spent = Number((await histTdDayRef().once("value")).val() || 0);
        // Phase 26 resume fix: paginate DOWN from the oldest stored bar, not
        // from `now` — otherwise every run re-buys the same recent pages.
        const walk = await tdWalkM1(apiKey, tdSym, covered, state.oldest ?? now, req.maxPages ?? 10, spent);
        const sh = await writeShards(symbol, tf, walk.bars, "twelvedata", { force: req.force });
        const oldest = walk.oldest ?? sh.days.length ? Math.min(...sh.days.map((d) => Date.parse(`${d}T00:00:00Z`) / 1000), walk.oldest ?? Infinity) : null;
        const newOldest = walk.oldest ?? state.oldest ?? null;
        await stateRef.set({
          provider: "twelvedata", oldest: newOldest, newest: state.newest ?? now,
          cursor: newOldest, targetFrom: wantFrom, done: walk.exhausted || (newOldest != null && newOldest <= covered),
          pages: (state.pages ?? 0) + walk.pages, written: (state.written ?? 0) + sh.written,
          rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(),
          error: walk.exhausted && !newOldest ? "provider refused / no deeper data" : null,
        });
        return { ...base, provider: "twelvedata", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: newOldest, newest: now, cursor: newOldest, done: walk.exhausted, note: `${walk.pages} pages spent (${Math.max(0, HIST_TD_DAILY_BUDGET - spent - walk.pages)} credits left today)` };
      }
      if (DUKA_MAP[symbol]) {
        const usageRef = rtdb().ref(`config/dukaUsage/${new Date().toISOString().slice(0, 10)}`);
        const used = Number((await usageRef.once("value")).val() || 0);
        if (used >= 1200) return { ...base, ok: false, provider: "dukascopy", error: "daily-file-cap" };
        // publication lag ≈ 1-2 days on a fresh store; Phase 26 resume fix:
        // continue BELOW the oldest stored day on every subsequent run
        const top = state.oldest != null ? Math.min(state.oldest, now - 2 * 86400) : now - 2 * 86400;
        // walk from two days ago backwards
        // Phase 30b: deadline 22s — the old 50s walk + shard/fold writes blew
        // past the serverless wall clock (FUNCTION_INVOCATION_TIMEOUT, hkg1),
        // so the step died BEFORE its state write and progress never stuck.
        const walk = await dukaWalkM1(symbol, covered, top, req.maxDays ?? 240, 900, used, req.deadlineMs ?? 18000);
        const sh = await writeShards(symbol, tf, walk.bars, "dukascopy-bid", { force: req.force });
        await usageRef.set(used + walk.files);
        // Phase 30: fold the step's own minute bars into 1h/1d shards NOW —
        // deep hourly/daily chart layers then serve from shards without any
        // giant read-time 1m fold (MAX_1M_FOLD_WINDOW_SEC used to skip those
        // windows entirely, so H4/1D showed nothing old even WITH deep 1m).
        let foldedNote = "";
        try {
          if (walk.bars.length) {
            const hourBars = aggregateBars(walk.bars, 60) as RawBar[];
            const dayBars = aggregateBars(walk.bars, 1440) as RawBar[];
            const hs = await writeShards(symbol, "1h", hourBars, "dukascopy-bid-fold", { force: req.force });
            const ds = await writeShards(symbol, "1d", dayBars, "dukascopy-bid-fold", { force: req.force });
            foldedNote = ` · folds 1h+${hs.written}/1d+${ds.written}`;
          }
        } catch { /* fold is best-effort — the 1m shards are the source of truth */ }
        const newOldest = walk.oldest ?? state.oldest ?? null;
        const done = newOldest != null && newOldest <= covered;
        await stateRef.set({
          provider: "dukascopy-bid", oldest: newOldest, newest: state.newest ?? now - 2 * 86400,
          cursor: newOldest, targetFrom: wantFrom, done,
          files: (state.files ?? 0) + walk.files, written: (state.written ?? 0) + sh.written,
          rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(), error: null,
        });
        return { ...base, provider: "dukascopy-bid", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: newOldest, cursor: newOldest, done, timedOut: walk.timedOut, note: `${walk.files} day files${walk.timedOut ? " · wall-clock budget reached — resume to continue" : ""}${foldedNote}` };
      }
      // metals with no TD key: honest refusal — stooq has no 1m
      return { ...base, ok: false, provider: "none", error: "NO_1M_SOURCE (stooq refuses 1m; metals are not on the Dukascopy feed; TwelveData key missing)" };
    }

    // ---- 5m/15m/30m/1h/1d: stooq native (metals SPOT + forex + indices) --
    const stooqSym = HIST_STOOQ[symbol];
    if (!stooqSym) return { ...base, ok: false, provider: "none", error: `no deep source for ${symbol} ${tf}` };
    const iv = HIST_STOOQ_INTERVAL[tf];
    if (!iv) {
      // 2h/4h/W/MN: aggregate from a coarser NATIVE stooq interval — genuine
      // OHLC folds, never fabricated candles
      const srcTf = tf === "2h" || tf === "4h" ? "1h" : tf === "1W" || tf === "1M" ? "1d" : null;
      if (!srcTf) return { ...base, ok: false, provider: "none", error: `no source interval for ${tf}` };
      let srcBars: RawBar[];
      try {
        srcBars = await fetchStooqBars(stooqSym, HIST_STOOQ_INTERVAL[srcTf]);
      } catch (e) {
        // Phase 31: stooq blocked → fold from the symbol's own deep shards
        // (2h/4h/1M from 1m; 1W from the 1d shards the 1m walk already folds).
        const fb = await foldBackfillStep(req);
        return { ...fb, note: `stooq ${String((e as any)?.message || e)} → ${fb.note || "shard fold"}` };
      }
      const inWin = srcBars.filter((b) => b.time >= covered);
      // Phase 24 D5: weeks anchor MONDAY and months use calendar buckets via
      // bucketStart — the naive floor fold produced Thursday-anchored weeks
      // and floating 30-day "months", offset from the live engine and Binance
      let agg: RawBar[];
      if (tf === "1W" || tf === "1M") {
        const sec = tf === "1W" ? 604800 : 2592000;
        const byBucket = new Map<number, RawBar[]>();
        for (const b of inWin) {
          const k = bucketStart(b.time, sec);
          let arr = byBucket.get(k);
          if (!arr) { arr = []; byBucket.set(k, arr); }
          arr.push(b);
        }
        agg = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([t, arr]) => ({
          time: t,
          open: arr[0].open,
          high: Math.max(...arr.map((b) => b.high)),
          low: Math.min(...arr.map((b) => b.low)),
          close: arr[arr.length - 1].close,
          volume: arr.reduce((s, b) => s + (b.volume ?? 0), 0),
        }));
      } else {
        agg = aggregateBars(inWin, Number(tf.slice(0, -1)) * 60) as RawBar[];
      }
      const sh = await writeShards(symbol, tf, agg, `stooq-${srcTf}-fold`, { force: req.force });
      await stateRef.set({ provider: `stooq-${srcTf}-fold`, oldest: agg.length ? agg[0].time : state.oldest ?? null, newest: agg.length ? agg[agg.length - 1].time : state.newest ?? null, targetFrom: wantFrom, done: true, written: (state.written ?? 0) + sh.written, rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(), error: null });
      return { ...base, provider: `stooq-${srcTf}-fold`, written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: agg.length ? agg[0].time : null, newest: agg.length ? agg[agg.length - 1].time : null, done: true };
    }
    const raw = await (async () => {
      try {
        return await fetchStooqBars(stooqSym, iv);
      } catch (e) {
        // Phase 31: stooq's intraday archive is IP-blocked from the Vercel
        // functions (STOOQ_403 live-verified for every tf probe) — fold from
        // the symbol's OWN deep shards instead of failing the step.
        const fb = await foldBackfillStep(req);
        const err = new Error(`stooq-fallback:${String((e as any)?.message || e)}`);
        (err as any).foldResult = fb;
        throw err;
      }
    })();
    const inWin = raw.filter((b) => b.time >= covered && b.time <= now);
    const sh = await writeShards(symbol, tf, inWin, "stooq-spot", { force: req.force });
    const oldest = inWin.length ? inWin[0].time : state.oldest ?? null;
    const newest = inWin.length ? inWin[inWin.length - 1].time : state.newest ?? null;
    await stateRef.set({
      provider: "stooq-spot", oldest, newest, cursor: oldest,
      targetFrom: wantFrom, done: true, written: (state.written ?? 0) + sh.written, rejected: (state.rejected ?? 0) + sh.rejected,
      updatedAt: Date.now(), error: null,
    });
    return { ...base, provider: "stooq-spot", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest, newest, cursor: oldest, done: true, note: `${raw.length} archive rows scanned` };
  } catch (e: any) {
    // Phase 31: a stooq failure that already produced a shard-fold result
    // must surface the FOLD's outcome, not the transport error.
    if (e && (e as any).foldResult) return (e as any).foldResult as BackfillResult;
    const msg = String(e?.message || e);
    await stateRef.update({ error: msg, updatedAt: Date.now() }).catch(() => {});
    return { ...base, ok: false, error: msg };
  }
}

/**
 * Phase 31 — FOLD backfill: build higher-timeframe shards from the symbol's
 * OWN lower-timeframe shards (1m → 3m/5m/15m/30m/1h/2h/4h/1d; 1d → 1W).
 * This is the fix for "W1 has history, D1/H4/H1/M30/M15/M5/M3/M1 don't":
 * stooq's intraday archive is IP-blocked from the Vercel functions
 * (STOOQ_403 live-verified), so the only genuine path to intraday depth for
 * XAUUSD/EURUSD/GBPUSD above 1m is folding the deep Dukascopy BID 1m store
 * the walk already wrote. Genuine OHLC folds of stored data — never
 * fabricated candles, never cross-provider mixing.
 *
 * Guards: a base day is folded only when it is COMPLETE (≥600 1m rows — a
 * partial day would print wrong extremes into every higher timeframe, and
 * the walk's wall-clock boundary days would poison the folds); weekend /
 * closed-session base rows are dropped first (the metals walk wrote static
 * Sat/Sun quotes); weekly buckets additionally require every passed weekday
 * (foldWeekComplete) so a hole in the 1d store can't fake a weekly bar.
 * Days already folded are skipped via meta dedupe; days tagged
 * "dukascopy-bid-fold" (the walk's own partial folds) are re-folded from the
 * authoritative 1m store. Every step is bounded (45 days or 60 weeks +
 * 15s deadline) and idempotent — safe to call repeatedly.
 */
export async function foldBackfillStep(req: BackfillRequest): Promise<BackfillResult> {
  const { symbol, tf } = req;
  const now = Math.floor(Date.now() / 1000);
  const stateRef = rtdb().ref(`histState/${symbol}/${tf}`);
  const state = (await stateRef.once("value")).val() || {};
  const base: BackfillResult = { ok: true, symbol, tf, provider: "", written: 0, skipped: 0, rejected: 0, oldest: state.oldest ?? null, newest: state.newest ?? null, cursor: state.oldest ?? null, targetFrom: null, done: false };
  try {
    const cls = assetClassOf(symbol);
    if (cls === "crypto") return { ...base, provider: "binance", done: true, note: "crypto history is served natively by the Binance REST/WS engine" };
    const deadline = Date.now() + 15000;

    if (tf === "1W" || tf === "1M") {
      // ---- weekly/monthly: fold from the symbol's own 1d shards ----------
      const tgtMeta = (await rtdb().ref(`histMeta/${symbol}/${tf}`).once("value")).val() || {};
      const snap = await rtdb().ref(`hist/${symbol}/1d`).once("value");
      const dayObj: Record<string, string> = snap.val() || {};
      const dayKeys = Object.keys(dayObj).filter((d) => typeof dayObj[d] === "string" && dayObj[d]);
      if (!dayKeys.length) return { ...base, ok: false, provider: "none", error: "no 1d shards to fold from — run the 1m backfill first (it folds 1d automatically)" };
      const dayBars: { time: number; open: number; high: number; low: number; close: number; volume?: number }[] = [];
      for (const d of dayKeys) {
        for (const row of String(dayObj[d]).split("|")) {
          const a = parseShardRow(row);
          if (a) dayBars.push({ time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] });
        }
      }
      const sec = tf === "1W" ? 604800 : 2592000;
      const byBucket = new Map<number, typeof dayBars>();
      for (const b of dayBars) {
        const k = bucketStart(b.time, sec);
        let arr = byBucket.get(k);
        if (!arr) { arr = []; byBucket.set(k, arr); }
        arr.push(b);
      }
      const agg: RawBar[] = [];
      let skippedWeeks = 0;
      for (const [bucket, arr] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
        if (tf === "1W" && !foldWeekComplete(new Set(arr.map((b) => dayKey(b.time))), bucket, now)) { skippedWeeks++; continue; }
        agg.push({
          time: bucket,
          open: arr[0].open,
          high: Math.max(...arr.map((b) => b.high)),
          low: Math.min(...arr.map((b) => b.low)),
          close: arr[arr.length - 1].close,
          volume: arr.reduce((s, b) => s + (b.volume ?? 0), 0),
        });
      }
      const sh = await writeShards(symbol, tf, agg, "1d-shard-fold", { force: !!req.force });
      const oldest = agg.length ? agg[0].time : state.oldest ?? null;
      const newest = agg.length ? agg[agg.length - 1].time : state.newest ?? null;
      await stateRef.update({
        provider: "1d-shard-fold", oldest, newest, targetFrom: backfillWindowFrom(HIST_MONTHS_CAP[tf] ?? 240, now),
        done: true, written: (state.written ?? 0) + sh.written, rejected: (state.rejected ?? 0) + sh.rejected + sh.skipped,
        updatedAt: Date.now(), error: null,
      });
      return { ...base, provider: "1d-shard-fold", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest, newest, done: true, note: `${dayBars.length} day bars → ${agg.length} ${tf} buckets${skippedWeeks ? ` · ${skippedWeeks} incomplete ${tf === "1W" ? "weeks" : "months"} skipped` : ""}` };
    }

    // ---- intraday: fold from the symbol's own 1m shards -----------------
    const factorMin = tf === "1d" ? 1440 : Number(tf.slice(0, -1)) * 60;
    if (!Number.isFinite(factorMin) || factorMin <= 0) return { ...base, ok: false, provider: "none", error: `cannot fold ${tf}` };
    const baseMeta = (await rtdb().ref(`histMeta/${symbol}/1m`).once("value")).val() || {};
    const baseDays = Object.keys(baseMeta).filter((d) => typeof baseMeta[d] === "string" && baseMeta[d]).sort();
    if (!baseDays.length) return { ...base, ok: false, provider: "none", error: "no 1m shards to fold from — run the 1m backfill first" };
    const tgtMeta = (await rtdb().ref(`histMeta/${symbol}/${tf}`).once("value")).val() || {};
    // missing days + the walk's own partial folds (re-fold from the source of
    // truth; our own "1m-shard-fold" days are already complete)
    const pending = baseDays.filter((d) => !tgtMeta[d] || tgtMeta[d] === "dukascopy-bid-fold");
    if (!pending.length) {
      await stateRef.update({ provider: "1m-shard-fold", done: true, updatedAt: Date.now(), error: null }).catch(() => {});
      return { ...base, provider: "1m-shard-fold", done: true, note: "all base days already folded" };
    }
    const chunk = pending.slice(0, 45);
    const pendingSet = new Set(chunk);
    const chunkStart = Date.parse(`${chunk[0]}T00:00:00Z`) / 1000;
    const chunkEnd = Date.parse(`${chunk[chunk.length - 1]}T00:00:00Z`) / 1000 + 86400;
    const read = await readShards(symbol, "1m", chunkStart, chunkEnd);
    // closed-session base rows never fold (metals Sat/Sun static quotes)
    let m1 = read.bars;
    if (m1.length && assetClassOf(symbol) !== "crypto") {
      m1 = dropClosedAnchors(m1, closedIntervals(symbol, chunkStart - 2 * 86400, chunkEnd + 86400)).bars;
    }
    const byDay = new Map<string, RawBar[]>();
    for (const b of m1) {
      const k = dayKey(b.time);
      if (!pendingSet.has(k)) continue; // already folded in a previous step
      let arr = byDay.get(k);
      if (!arr) { arr = []; byDay.set(k, arr); }
      arr.push(b);
    }
    const folded: RawBar[] = [];
    let skippedDays = 0;
    for (const [day, rows] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (rows.length < 600) { skippedDays++; continue; } // incomplete base day — never fold it
      if (Date.now() > deadline) { skippedDays++; continue; }
      folded.push(...(aggregateBars(rows, factorMin) as RawBar[]));
    }
    const sh = folded.length
      ? await writeShards(symbol, tf, folded, "1m-shard-fold", { force: true })
      : { written: 0, skipped: 0, days: [] as string[], rejected: 0 };
    const times = folded.map((b) => b.time);
    const oldest = times.length ? Math.min(...times) : state.oldest ?? null;
    const newest = times.length ? Math.max(...times) : state.newest ?? null;
    const done = pending.length <= 45;
    await stateRef.update({
      provider: "1m-shard-fold", oldest, newest,
      targetFrom: backfillWindowFrom(HIST_MONTHS_CAP[tf] ?? 240, now),
      done, written: (state.written ?? 0) + sh.written, rejected: (state.rejected ?? 0) + sh.rejected,
      foldCursor: pending.length ? chunk[chunk.length - 1] : null,
      updatedAt: Date.now(), error: null,
    });
    return { ...base, provider: "1m-shard-fold", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest, newest, done, note: `folded ${sh.written}/${byDay.size} days ${chunk[0]}→${chunk[chunk.length - 1]} from 1m${skippedDays ? ` · ${skippedDays} incomplete days skipped` : ""} · ${pending.length - sh.written > 0 ? "resume to continue" : "caught up"}` };
  } catch (e: any) {
    const msg = String(e?.message || e);
    await stateRef.update({ error: msg, updatedAt: Date.now() }).catch(() => {});
    return { ...base, ok: false, error: msg };
  }
}

// ---- reads -----------------------------------------------------------------

export interface RangeResult { ok: boolean; symbol: string; tf: string; bars: RawBar[]; providers: Record<string, number>; note?: string }

// READ_AGG_CHAIN / MAX_1M_FOLD_WINDOW_SEC live in hist-sessions.ts (pure, testable)

/**
 * Serve a historical window: native shards first; then aggregate up from
 * their native base when no shard exists for the requested tf (§7 —
 * higher timeframes aggregate correctly from compatible lower data).
 */
export async function readRange(symbol: string, tf: string, fromSec: number, toSec: number): Promise<RangeResult> {
  const native = await readShards(symbol, tf, fromSec, toSec);
  if (native.bars.length) {
    // Phase 28: a poisoned shard row (foreign-price wick) must not ride into
    // the chart — the fold chain would carry it into every higher timeframe.
    const repaired = repairOutlierExtremes(native.bars);
    return { ok: true, symbol, tf, bars: repaired.bars, providers: native.providers };
  }
  const chain = READ_AGG_CHAIN[tf];
  if (chain) {
    for (const agg of chain) {
      if (agg.src === "1m" && toSec - fromSec > MAX_1M_FOLD_WINDOW_SEC) continue;
      const src = await readShards(symbol, agg.src, fromSec, toSec);
      if (!src.bars.length) continue;
      const folded = aggregateBars(src.bars, agg.factorMin) as RawBar[];
      const out = repairOutlierExtremes(folded).bars;
      const providers: Record<string, number> = {};
      for (const [p, n] of Object.entries(src.providers)) providers[`${p}→${tf}-fold`] = n;
      return { ok: true, symbol, tf, bars: out, providers };
    }
  }
  return { ok: true, symbol, tf, bars: [], providers: {}, note: "no stored history in this window" };
}

// ---- coverage report -------------------------------------------------------

export interface CoverageRow {
  symbol: string; tf: string;
  earliest: number | null; latest: number | null; candleCount: number;
  providers: Record<string, number>;
  missing: { count: number; sample: number[]; longestGapSec: number };
  state: any;
}

/** Full coverage scan for one symbol over the standard tf list (the admin
 * panel + audit report both consume this). */
export async function coverageReport(symbol: string, tfs: string[]): Promise<CoverageRow[]> {
  const ac = assetClassOf(symbol);
  const rows: CoverageRow[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const tf of tfs) {
    const state = (await rtdb().ref(`histState/${symbol}/${tf}`).once("value")).val() || null;
    const snap = await rtdb().ref(`hist/${symbol}/${tf}`).once("value");
    const obj: Record<string, string> = snap.val() || {};
    let count = 0;
    let earliest: number | null = null;
    let latest: number | null = null;
    const metaSnap = await rtdb().ref(`histMeta/${symbol}/${tf}`).once("value");
    const meta: Record<string, string> = metaSnap.val() || {};
    const providers: Record<string, number> = {};
    const bars: RawBar[] = [];
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
        if (bars.length < 200000) bars.push({ time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] });
      }
    }
    const tfSec = tf === "1d" ? 86400 : tf === "1W" ? 604800 : tf === "1M" ? 2592000 : tf === "1h" || tf === "2h" || tf === "4h" ? Number(tf.slice(0, -1)) * 3600 : Number(tf.slice(0, -1)) * 60;
    const missing = earliest && latest ? missingIntervals(bars, tfSec, Math.max(earliest, now - 180 * 86400), Math.min(latest, now), ac) : { count: 0, sample: [], longestGapSec: 0 };
    rows.push({ symbol, tf, earliest, latest, candleCount: count, providers, missing, state });
  }
  return rows;
}
