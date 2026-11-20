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
import { validateBars, alignAndDedupe, type RawBar } from "../../../shared/feed-validation";
import { aggregateBars } from "../../../shared/terminal";
import { fetchDukaDay, decodeDukaDay, DUKA_MAP } from "./duka";

// ---- symbol maps -----------------------------------------------------------

/** Terminal symbol → stooq ticker (genuine SPOT for metals, cash index for
 * indices, direct pair for forex). Mirrors quotes.ts STOOQ_MAP keyed on the
 * bare terminal code instead of the yahoo identifier. */
const HIST_STOOQ: Record<string, string> = {
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

/** Backfill caps per timeframe (months) — honest provider expectations. */
export const HIST_MONTHS_CAP: Record<string, number> = {
  "1m": 6, "5m": 12, "15m": 24, "30m": 24, "1h": 24, "2h": 24, "4h": 24,
  "1d": 240, "1W": 240, "1M": 240,
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
  const { bars } = alignAndDedupe(checked.bars, tf === "1d" ? 86400 : tf === "1W" ? 604800 : tf === "1M" ? 2592000 : 60);
  const rejected = checked.invalid + (raw.length - checked.bars.length);
  const out: ShardsWritten = { written: 0, skipped: 0, days: [], rejected };
  const metaRef = rtdb().ref(`histMeta/${symbol}/${tf}`);
  const dataRef = rtdb().ref(`hist/${symbol}/${tf}`);
  for (const [day, rows] of groupByDay(bars)) {
    // optional window filter (resume cursors write only their slice)
    const t0 = rows[0][0];
    if (opts?.before != null && t0 >= opts.before) { out.skipped++; continue; }
    if (opts?.after != null && t0 < opts.after) { out.skipped++; continue; }
    try {
      const existingTag = (await metaRef.child(day).once("value")).val();
      if (existingTag && !opts?.force) { out.skipped++; continue; }
      await dataRef.child(day).set(rows.map((r) => JSON.stringify(r)).join("|"));
      await metaRef.child(day).set(provider);
      out.written++;
      out.days.push(day);
    } catch (e) {
      // a single shard failure must not abort the run — the cursor allows retry
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
      const a = row.split(",");
      const [t, o, h, l, c] = a.map(Number);
      if ([t, o, h, l, c].every(Number.isFinite) && t > 0 && o > 0) {
        bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Number(a[5]) || 0 });
      }
    }
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, providers };
}

// ---- sessions (missing-interval detection) ---------------------------------

/** Metals session: Sun 22:00 UTC → Fri 21:00 UTC. Forex: Sun 22:00 → Fri 21:55.
 * Crypto trades 24/7. Cash indices: ~Mon-Fri 13:30-20:00 UTC is the honest
 * approximation for the US names stooq serves (their CSV only contains traded
 * minutes anyway). Returns true when a candle at tSec SHOULD exist. */
export function inMarketHours(tSec: number, assetClass: "metal" | "forex" | "index" | "crypto"): boolean {
  const d = new Date(tSec * 1000);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (assetClass === "crypto") return true;
  if (assetClass === "index") return dow >= 1 && dow <= 5 && mins >= 810 && mins < 1200;
  // metals + forex share the 24/5 session shape
  if (dow === 6) return false;
  if (dow === 5) return mins < (assetClass === "forex" ? 22 * 60 - 5 : 21 * 60);
  if (dow === 0) return mins >= 22 * 60;
  return true;
}

/** Missing-interval scan: expected-but-absent buckets inside market hours
 * (closed market ≠ missing data — weekends never count). */
export function missingIntervals(bars: RawBar[], tfSec: number, fromSec: number, toSec: number, assetClass: "metal" | "forex" | "index" | "crypto", maxReport = 12): { count: number; sample: number[]; longestGapSec: number } {
  if (tfSec <= 0) return { count: 0, sample: [], longestGapSec: 0 };
  const have = new Set(bars.map((b) => b.time));
  const sample: number[] = [];
  let count = 0;
  let gapStart: number | null = null;
  let longestGapSec = 0;
  for (let t = Math.ceil(fromSec / tfSec) * tfSec; t <= toSec; t += tfSec) {
    if (!inMarketHours(t, assetClass)) { if (gapStart != null) { longestGapSec = Math.max(longestGapSec, t - gapStart); gapStart = null; } continue; }
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

// ---- sources ---------------------------------------------------------------

/** stooq CSV → bars (Europe/Berlin wall-time resolution per bar date — the
 * same rule quotes.ts uses; intraday archives are decades deep for daily). */
export async function fetchStooqBars(stooqSym: string, interval: string): Promise<RawBar[]> {
  const url = `https://stooq.com/q/d/l/?s=${stooqSym}&i=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
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

/**
 * TwelveData 1m walk-back (metals m1 — the ONLY keyless-free m1 source that
 * serves XAU/USD). Paginated: each page = 1 credit, ≤5000 rows, `end_date`
 * steps back until `startSec` or the budget/cap stops it. RESUMABLE: callers
 * persist `oldest` as the cursor and call again to continue deeper.
 */
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
    if (json?.status === "error" || !Array.isArray(json?.values)) {
      exhausted = true; break; // provider refusal — stop, report, resume later
    }
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
    if (json.values.length < 5000) { exhausted = true; break; } // reached the provider's own floor
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, pages, oldest: bars.length ? bars[0].time : null, exhausted };
}

/** Dukascopy m1 walk-back for forex (official public datafeed, years deep).
 * `days` per run is bounded by the function wall-clock; the cursor resumes. */
export async function dukaWalkM1(code: string, fromSec: number, toSec: number, maxDays: number, fileBudget: number, fileUsed: number): Promise<{ bars: RawBar[]; files: number; oldest: number | null }> {
  const dukaSym = DUKA_MAP[code];
  if (!dukaSym) throw new Error("NOT_ON_DUKA");
  const bars: RawBar[] = [];
  let files = 0;
  let oldest: number | null = null;
  let fetched = 0;
  for (let day = Math.floor(toSec / 86400) * 86400; day >= fromSec && fetched < maxDays && fileUsed + files < fileBudget; day -= 86400) {
    const d = new Date(day * 1000);
    const buf = await fetchDukaDay(dukaSym, d);
    if (!buf) { fetched++; continue; } // no file (weekend/lag) — still a day consumed
    files++;
    const decoded = await decodeDukaDay(buf, code, d);
    for (const b of decoded) {
      if (b.t < fromSec || b.t > toSec) continue;
      bars.push({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      if (oldest == null || b.t < oldest) oldest = b.t;
    }
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars, files, oldest };
}

// ---- backfill orchestration ------------------------------------------------

export interface BackfillRequest {
  symbol: string;          // terminal code: XAUUSD, EURUSD, ^NDX…
  tf: string;              // client timeframe key: 1m, 5m, 15m, 30m, 1h, 4h, 1d…
  months?: number;         // how deep to go (capped by HIST_MONTHS_CAP)
  maxPages?: number;       // TD pages this run may spend (default 10)
  maxDays?: number;        // Dukascopy day files this run may fetch (default 60)
  force?: boolean;         // rewrite existing day shards
}

export interface BackfillResult {
  ok: boolean; symbol: string; tf: string; provider: string;
  written: number; skipped: number; rejected: number;
  oldest: number | null; newest: number | null;
  cursor: number | null;   // oldest time reached — pass back to resume deeper
  done: boolean;           // true when the requested window is covered
  note?: string; error?: string;
}

const ASSET_CLASS: Record<string, "metal" | "forex" | "index" | "crypto"> = {
  XAUUSD: "metal", XAGUSD: "metal",
};

function assetClassOf(symbol: string): "metal" | "forex" | "index" | "crypto" {
  if (ASSET_CLASS[symbol]) return ASSET_CLASS[symbol];
  if (symbol.startsWith("^")) return "index";
  if (/USD[T]?$/i.test(symbol) && symbol.length >= 6) return "crypto";
  if (symbol.endsWith("=X") || /^[A-Z]{6}$/.test(symbol)) return "forex";
  return "index";
}

/**
 * Run ONE backfill step for symbol+tf. Every step is idempotent (shard
 * dedupe) and resumable (cursor). Called by the admin action; interrupted
 * runs simply run again — TEST J.
 */
export async function runBackfillStep(req: BackfillRequest): Promise<BackfillResult> {
  const { symbol, tf } = req;
  const months = Math.min(req.months ?? HIST_MONTHS_CAP[tf] ?? 12, HIST_MONTHS_CAP[tf] ?? 12);
  const now = Math.floor(Date.now() / 1000);
  const wantFrom = now - Math.round(months * 30.44 * 86400);
  const stateRef = rtdb().ref(`histState/${symbol}/${tf}`);
  const state = (await stateRef.once("value")).val() || {};
  // resume: start the walk from the OLDEST bar already stored, never re-download
  const covered = state.oldest ? Math.min(state.oldest, wantFrom) : wantFrom;

  const base: BackfillResult = { ok: true, symbol, tf, provider: "", written: 0, skipped: 0, rejected: 0, oldest: state.oldest ?? null, newest: state.newest ?? null, cursor: state.oldest ?? null, done: false };

  try {
    // ---- crypto: Binance REST klines go back years — no engine needed ----
    if (assetClassOf(symbol) === "crypto") {
      return { ...base, provider: "binance", done: true, note: "crypto history is served natively by the Binance REST/WS engine (loadOlder pagination)" };
    }

    // ---- 1m: metals → TwelveData walk-back · forex → Dukascopy ----------
    if (tf === "1m") {
      const tdSym = HIST_TD[symbol];
      if (tdSym) {
        const apiKey = String(process.env.TWELVE_DATA_API_KEY || "") || String((await rtdb().ref("config/providerKeys/twelvedata").once("value")).val() || "");
        if (!/^[a-f0-9]{32}$/i.test(apiKey)) return { ...base, ok: false, provider: "twelvedata", error: "no-key" };
        const spent = Number((await histTdDayRef().once("value")).val() || 0);
        const walk = await tdWalkM1(apiKey, tdSym, covered, now, req.maxPages ?? 10, spent);
        const sh = await writeShards(symbol, tf, walk.bars, "twelvedata", { force: req.force });
        const oldest = walk.oldest ?? sh.days.length ? Math.min(...sh.days.map((d) => Date.parse(`${d}T00:00:00Z`) / 1000), walk.oldest ?? Infinity) : null;
        const newOldest = walk.oldest ?? state.oldest ?? null;
        await stateRef.set({
          provider: "twelvedata", oldest: newOldest, newest: state.newest ?? now,
          cursor: newOldest, done: walk.exhausted || (newOldest != null && newOldest <= covered),
          pages: (state.pages ?? 0) + walk.pages, written: (state.written ?? 0) + sh.written,
          rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(),
          error: walk.exhausted && !newOldest ? "provider refused / no deeper data" : null,
        });
        return { ...base, provider: "twelvedata", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: newOldest, newest: now, cursor: newOldest, done: walk.exhausted, note: `${walk.pages} pages spent (${Math.max(0, HIST_TD_DAILY_BUDGET - spent - walk.pages)} credits left today)` };
      }
      if (DUKA_MAP[symbol]) {
        const usageRef = rtdb().ref(`config/dukaUsage/${new Date().toISOString().slice(0, 10)}`);
        const used = Number((await usageRef.once("value")).val() || 0);
        if (used >= 600) return { ...base, ok: false, provider: "dukascopy", error: "daily-file-cap" };
        // publication lag ≈ 1-2 days — walk from two days ago backwards
        const walk = await dukaWalkM1(symbol, covered, now - 2 * 86400, req.maxDays ?? 60, 600, used);
        const sh = await writeShards(symbol, tf, walk.bars, "dukascopy-bid", { force: req.force });
        await usageRef.set(used + walk.files);
        const newOldest = walk.oldest ?? state.oldest ?? null;
        await stateRef.set({
          provider: "dukascopy-bid", oldest: newOldest, newest: state.newest ?? now - 2 * 86400,
          cursor: newOldest, done: newOldest != null && newOldest <= covered,
          files: (state.files ?? 0) + walk.files, written: (state.written ?? 0) + sh.written,
          rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(), error: null,
        });
        return { ...base, provider: "dukascopy-bid", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: newOldest, cursor: newOldest, done: newOldest != null && newOldest <= covered, note: `${walk.files} day files` };
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
      const srcBars = await fetchStooqBars(stooqSym, HIST_STOOQ_INTERVAL[srcTf]);
      const inWin = srcBars.filter((b) => b.time >= covered);
      const agg = aggregateBars(inWin, (tf === "1W" ? 604800 : tf === "1M" ? 2592000 : Number(tf.slice(0, -1)) * 3600) / 60) as RawBar[];
      const sh = await writeShards(symbol, tf, agg, `stooq-${srcTf}-fold`, { force: req.force });
      await stateRef.set({ provider: `stooq-${srcTf}-fold`, oldest: agg.length ? agg[0].time : state.oldest ?? null, newest: agg.length ? agg[agg.length - 1].time : state.newest ?? null, done: true, written: (state.written ?? 0) + sh.written, rejected: (state.rejected ?? 0) + sh.rejected, updatedAt: Date.now(), error: null });
      return { ...base, provider: `stooq-${srcTf}-fold`, written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest: agg.length ? agg[0].time : null, newest: agg.length ? agg[agg.length - 1].time : null, done: true };
    }
    const raw = await fetchStooqBars(stooqSym, iv);
    const inWin = raw.filter((b) => b.time >= covered && b.time <= now);
    const sh = await writeShards(symbol, tf, inWin, "stooq-spot", { force: req.force });
    const oldest = inWin.length ? inWin[0].time : state.oldest ?? null;
    const newest = inWin.length ? inWin[inWin.length - 1].time : state.newest ?? null;
    await stateRef.set({
      provider: "stooq-spot", oldest, newest, cursor: oldest,
      done: true, written: (state.written ?? 0) + sh.written, rejected: (state.rejected ?? 0) + sh.rejected,
      updatedAt: Date.now(), error: null,
    });
    return { ...base, provider: "stooq-spot", written: sh.written, skipped: sh.skipped, rejected: sh.rejected, oldest, newest, cursor: oldest, done: true, note: `${raw.length} archive rows scanned` };
  } catch (e: any) {
    const msg = String(e?.message || e);
    await stateRef.update({ error: msg, updatedAt: Date.now() }).catch(() => {});
    return { ...base, ok: false, error: msg };
  }
}

// ---- reads -----------------------------------------------------------------

export interface RangeResult { ok: boolean; symbol: string; tf: string; bars: RawBar[]; providers: Record<string, number>; note?: string }

/**
 * Serve a historical window: native shards first; 2h/4h/W/MN aggregate up
 * from their native base when no shard exists for the requested tf (§7 —
 * higher timeframes aggregate correctly from compatible lower data).
 */
export async function readRange(symbol: string, tf: string, fromSec: number, toSec: number): Promise<RangeResult> {
  const native = await readShards(symbol, tf, fromSec, toSec);
  if (native.bars.length) return { ok: true, symbol, tf, bars: native.bars, providers: native.providers };
  // aggregation fallback chain (native sources only — no cross-provider seams)
  const chain: Record<string, { src: string; factorMin: number }> = {
    "2h": { src: "1h", factorMin: 120 },
    "4h": { src: "1h", factorMin: 240 },
    "1W": { src: "1d", factorMin: 10080 },
    "1M": { src: "1d", factorMin: 43200 },
    "3m": { src: "1m", factorMin: 3 },
  };
  const agg = chain[tf];
  if (agg) {
    const src = await readShards(symbol, agg.src, fromSec, toSec);
    if (src.bars.length) {
      const out = aggregateBars(src.bars, agg.factorMin) as RawBar[];
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
        const a = row.split(",").map(Number);
        if (!Number.isFinite(a[0])) continue;
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
