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

/** Backfill caps per timeframe (months) — honest provider expectations. */
export const HIST_MONTHS_CAP: Record<string, number> = {
  "1m": 6, "5m": 12, "15m": 24, "30m": 24, "1h": 24, "2h": 24, "4h": 24,
  "1d": 240, "1W": 240, "1M": 240,
};

