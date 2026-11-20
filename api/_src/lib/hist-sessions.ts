/**
 * Phase 23 — pure session/gap/cap helpers for the deep-history engine.
 * Standalone (no I/O, no Firebase) so `node --test` can verify the market
 * session boundaries, missing-interval scans and backfill caps directly.
 */
export type AssetClass = "metal" | "forex" | "index" | "crypto";

/** Metals session: Sun 22:00 UTC → Fri 21:00 UTC. Forex: Sun 22:00 → Fri 21:55.
 * Crypto trades 24/7. Cash indices: ~Mon-Fri 13:30-20:00 UTC (the US names
 * stooq serves). Returns true when a candle at tSec SHOULD exist. */
export function inMarketHours(tSec: number, assetClass: AssetClass): boolean {
  const d = new Date(tSec * 1000);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (assetClass === "crypto") return true;
  if (assetClass === "index") return dow >= 1 && dow <= 5 && mins >= 810 && mins < 1200;
  if (dow === 6) return false;
  if (dow === 5) return mins < (assetClass === "forex" ? 22 * 60 - 5 : 21 * 60);
  if (dow === 0) return mins >= 22 * 60;
  return true;
}

export interface MissingScan { count: number; sample: number[]; longestGapSec: number }

/** Missing-interval scan: expected-but-absent buckets inside market hours
 * (closed market ≠ missing data — weekends never count). */
export function missingIntervals(bars: { time: number }[], tfSec: number, fromSec: number, toSec: number, assetClass: AssetClass, maxReport = 12): MissingScan {
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

/**
 * Backfill caps per timeframe (months). Phase 25 §3: the intraday caps no
 * longer limit HISTORY DEPTH — Dukascopy serves forex/metals 1m BID candles
 * back to 2010 (~202 months, verified by live probes) and stooq's intraday
 * archives are comparably deep. 240 months (20 years) covers every genuine
 * provider depth. Safety now comes from per-call budgets instead: Dukascopy
 * ≤90 day files per call + a wall-clock deadline, TwelveData ≤10 pages/call,
 * a 600 files/day global cap, and the resumable cursor in histState — so a
 * single request stays small while repeated runs reach the full range.
 */
export const HIST_MONTHS_CAP: Record<string, number> = {
  "1m": 240, "5m": 240, "15m": 240, "30m": 240, "1h": 240, "2h": 240, "4h": 240,
  "1d": 240, "1W": 240, "1M": 240,
};

/** Clamp a requested backfill depth to the timeframe cap (Phase 25 §3 — the
 * clamp is a safety net against absurd values, NOT the history limit it used
 * to be). Unknown timeframes default to 12 months. */
export function clampBackfillMonths(requested: number | undefined, tf: string): number {
  const cap = HIST_MONTHS_CAP[tf] ?? 12;
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return cap;
  return Math.min(Math.floor(n), cap);
}

/** Depth (months) → epoch-seconds lower bound for a backfill walk. */
export function backfillWindowFrom(months: number, nowSec: number): number {
  return nowSec - Math.round(months * 30.44 * 86400);
}

/** Aggregation fallback chain per timeframe (Phase 23 + Phase 25): native
 * shards first, then fold from the deepest compatible NATIVE store. Phase 25
 * §6: intraday folds from 1m shards mean one deep Dukascopy 1m backfill
 * powers every higher intraday timeframe — genuine OHLC folds, no fabricated
 * candles, no cross-provider seams (all shards of one symbol share identity).
 * Pure data (no I/O) so tests can verify the fold factors directly. */
export const READ_AGG_CHAIN: Record<string, Array<{ src: string; factorMin: number }>> = {
  "3m": [{ src: "1m", factorMin: 3 }],
  "5m": [{ src: "1m", factorMin: 5 }],
  "15m": [{ src: "1m", factorMin: 15 }],
  "30m": [{ src: "1m", factorMin: 30 }],
  "1h": [{ src: "1m", factorMin: 60 }],
  "2h": [{ src: "1h", factorMin: 120 }, { src: "1m", factorMin: 120 }],
  "4h": [{ src: "1h", factorMin: 240 }, { src: "1m", factorMin: 240 }],
  "1W": [{ src: "1d", factorMin: 10080 }],
  "1M": [{ src: "1d", factorMin: 43200 }],
};

/** Guard: folding 1m shards is O(window) — bound the request window so a
 * scroll-back chunk stays cheap (the chart asks for days, never years). */
export const MAX_1M_FOLD_WINDOW_SEC = 90 * 86400;

