/**
 * Phase 67 — pure core for the server-managed spot recorder and the honest
 * feed diagnostics. Standalone (no imports) so the API bundle (api/_src/*),
 * the client bundler (@shared/spot-recorder-core) and `node --test` all load
 * it directly.
 *
 * The recorder folds gold-api spot samples into the shared RTDB minute store
 * WITHOUT a browser session. Semantics mirror the client recorder
 * (client/src/lib/spot-tail.ts recordSpotTick/mergeSpotCandles) exactly, so
 * server and client observations of the same minute merge deterministically.
 */

/** One recorded spot minute (m1). s = number of observed samples. */
export interface SpotCandle {
  t: number; // minute bucket start (UNIX seconds, minute-aligned)
  o: number;
  h: number;
  l: number;
  c: number;
  s: number;
}

// ---------------------------------------------------------------------------
// Provider-stamped minute buckets. gold-api stamps every price with
// `updatedAt`; the recorder must use THAT clock (the client/server clock can
// drift, and a wrong bucket would misalign the M1 grid). A stamp more than
// MAX_STAMP_SKEW_SEC away from the local clock is untrustworthy (a frozen
// weekend stamp or a broken provider clock) → fall back to the local clock;
// the session gate rejects closed-market samples anyway.
// ---------------------------------------------------------------------------

/** A provider stamp this far from the local clock is not trusted for bucketing. */
export const MAX_STAMP_SKEW_SEC = 120;

/**
 * Minute bucket for an observed sample: the PROVIDER stamp when it is sane
 * (within MAX_STAMP_SKEW_SEC of the local clock), else the local clock.
 * Returns null when the sample must be REJECTED as out-of-order: a stamp
 * that would bucket BEFORE the candle already being built would corrupt the
 * series retroactively — the honest move is to drop the late sample, not to
 * rewrite a finished minute.
 */
export function providerMinuteBucket(minute: SpotCandle | null | undefined, nowSec: number, providerAtSec: number | null | undefined): number | null {
  const localBucket = Math.floor(nowSec / 60) * 60;
  let bucket = localBucket;
  if (providerAtSec && Number.isFinite(providerAtSec) && providerAtSec > 0) {
    // a stamp slightly ahead of the local clock (≤ 5s clock skew) is fine —
    // clamp it so the bucket never lands in the "future"
    const skewed = Math.abs(nowSec - providerAtSec) <= MAX_STAMP_SKEW_SEC;
    bucket = skewed ? Math.floor(Math.min(providerAtSec, nowSec + 5) / 60) * 60 : localBucket;
  }
  if (minute && bucket < minute.t) return null; // late sample for a finished minute — drop
  return bucket;
}

/**
 * Pure fold for the recorder — one observed sample into the stored minute
 * candle, deterministic under concurrent writers: the stored open stays
 * (earliest observation), the incoming close wins (latest), high/low take
 * the envelope, samples count up (capped at 60 — one minute cannot hold more
 * than 60 one-second samples; the cap keeps a replaying write from inflating
 * the "tick volume" disclosure).
 */
export function foldSample(cur: SpotCandle | null | undefined, price: number, bucket: number, samples = 1): SpotCandle {
  const p = price;
  if (cur && Number.isFinite(cur.t) && cur.t === bucket) {
    return {
      t: bucket,
      o: cur.o,
      c: p,
      h: Math.max(cur.h, p),
      l: Math.min(cur.l, p),
      s: Math.min(60, (cur.s || 0) + Math.max(1, samples)),
    };
  }
  return { t: bucket, o: p, h: p, l: p, c: p, s: Math.min(60, Math.max(1, samples)) };
}

// ---------------------------------------------------------------------------
// Honest feed-health classification. The badge must never label delayed data
// as real-time: the provider's own stamp age decides.
// ---------------------------------------------------------------------------

export type SpotHealth = "live" | "delayed" | "stale" | "error";

/**
 * LIVE    ≤ 15s — the gold-api stamp is fresh; the chart moves at genuine
 *         spot cadence.
 * DELAYED ≤ 90s — the provider publishes but lags up to ~1.5 min (measured
 *         gold-api behavior: 25–35s typical, bursts to ~90s).
 * STALE   beyond that — the price on screen is genuinely old.
 * ERROR   the poller is failing (≥ 3 consecutive failures) — no fresh data
 *         can be expected until it recovers.
 */
export const SPOT_LIVE_MAX_DELAY_SEC = 15;
export const SPOT_STALE_MIN_DELAY_SEC = 90;

export function healthFromDelay(delaySec: number | null | undefined, fails: number): SpotHealth {
  if (Number.isFinite(fails) && fails >= 3) return "error";
  const d = typeof delaySec === "number" && Number.isFinite(delaySec) ? delaySec : null;
  if (d == null) return "live"; // provider gave no stamp — cannot classify as delayed
  if (d <= SPOT_LIVE_MAX_DELAY_SEC) return "live";
  if (d <= SPOT_STALE_MIN_DELAY_SEC) return "delayed";
  return "stale";
}

// ---------------------------------------------------------------------------
// Historical/live price-basis offset, MEASURED not guessed. The deep history
// (Dukascopy BID 1m shards) and the live tail (gold-api spot) are different
// price sides of the same metal. Where the two overlap in time, the mean
// difference is the honest boundary number — surfaced in diagnostics, NEVER
// used to silently rewrite provider prices.
// ---------------------------------------------------------------------------

export interface OffsetSample { spotClose: number; bidClose: number }

/** Minimum genuine overlaps before an offset number is reported at all. */
export const MIN_OVERLAP_SAMPLES = 8;

export function computeBidSpotOffset(samples: OffsetSample[]): { mean: number; median: number; stdev: number; n: number } | null {
  const deltas = samples
    .map((s) => s.spotClose - s.bidClose)
    .filter((d) => Number.isFinite(d) && Math.abs(d) < 500); // sane band — outlier guards ran upstream
  if (deltas.length < MIN_OVERLAP_SAMPLES) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const variance = deltas.reduce((s, x) => s + (x - mean) * (x - mean), 0) / deltas.length;
  return { mean, median, stdev: Math.sqrt(variance), n: deltas.length };
}
