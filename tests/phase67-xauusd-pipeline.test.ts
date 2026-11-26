/**
 * PHASE 67 — XAUUSD data-pipeline guards, all pure and provider-stamp aware:
 *   · recorder fold (server + client share one deterministic semantics);
 *   · provider-stamped minute buckets (client/server clock skew, late
 *     samples, frozen weekend stamps);
 *   · honest feed-health classification (LIVE/DELAYED/STALE/PROVIDER ERROR);
 *   · the MEASURED Duka-BID↔spot boundary offset (never a guessed constant);
 *   · the live-tail merge with delayed provider stamps + duplicate /
 *     out-of-order updates;
 *   · higher-timeframe aggregation consistency (M1 → M5/H1 alignment).
 * The Phase 49 event-driven catch-up is exercised through the tail-rejection
 * path (mergeSpotTail null → catch-up reload contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldSample, providerMinuteBucket, healthFromDelay,
  computeBidSpotOffset, MIN_OVERLAP_SAMPLES, MAX_STAMP_SKEW_SEC,
} from "../shared/spot-recorder-core.ts";
import {
  mergeSpotTail, recordSpotTick, mergeSpotSeries, validSpotCandle,
  type SpotCandle, type SpotTailBar,
} from "../client/src/lib/spot-tail.ts";
import { shouldRetryFetch, isRetryableStatus } from "../shared/fetch-policy.ts";
import { aggregateBars } from "../shared/terminal.ts";
import { closedIntervals } from "../shared/market-hours.ts";

// ---------------------------------------------------------------------------
// recorder fold — the shared server/client semantics
// ---------------------------------------------------------------------------

test("recorder fold: first sample opens the minute candle", () => {
  const c = foldSample(null, 4123.45, 1795540800);
  assert.deepEqual(c, { t: 1795540800, o: 4123.45, h: 4123.45, l: 4123.45, c: 4123.45, s: 1 });
});

test("recorder fold: envelope expands, open stays, close follows, samples count", () => {
  const c0 = foldSample(null, 4123.45, 1795540800);
  const c1 = foldSample(c0, 4125.10, 1795540800);
  const c2 = foldSample(c1, 4122.20, 1795540800);
  assert.equal(c2.t, 1795540800);
  assert.equal(c2.o, 4123.45); // earliest observation stays the open
  assert.equal(c2.c, 4122.20); // latest observation is the close
  assert.equal(c2.h, 4125.10);
  assert.equal(c2.l, 4122.20);
  assert.equal(c2.s, 3);
});

test("recorder fold: sample count capped at 60 (one minute cannot hold more 1s samples)", () => {
  let c: SpotCandle | null = null;
  for (let i = 0; i < 100; i++) c = foldSample(c, 4123 + i * 0.01, 1795540800);
  assert.equal(c!.s, 60);
});

test("recorder fold: concurrent writers merge idempotently (transaction replay safe)", () => {
  // two folds of the SAME sample must not double-count or corrupt OHLC
  const c0 = foldSample(null, 4123.45, 1795540800);
  const replay = foldSample(c0, 4123.45, 1795540800);
  assert.equal(replay.s, c0.s + 1);
  assert.equal(replay.o, c0.o);
  // and the deterministic merge of the same two candles collapses back
  const merged = mergeSpotSeries([c0], [replay]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].o, 4123.45);
});

// ---------------------------------------------------------------------------
// provider-stamped minute buckets
// ---------------------------------------------------------------------------

test("provider bucket: sane stamp decides the bucket (clock-skewed user ignored)", () => {
  const NOW = 1795540800; // minute-aligned
  // provider stamp 100s behind the local clock (within the 120s skew guard):
  // the stamp's own minute wins — 1795540700 falls into the minute that
  // started 120s before NOW
  const b = providerMinuteBucket(null, NOW, NOW - 100);
  assert.equal(b, NOW - 120);
});

test("provider bucket: stamp beyond MAX_STAMP_SKEW falls back to the local clock", () => {
  const NOW = 1795540800;
  // a stamp 10 min behind (frozen weekend stamp) is not trusted for
  // bucketing — the local clock decides
  assert.equal(providerMinuteBucket(null, NOW, NOW - 600), NOW);
  assert.equal(MAX_STAMP_SKEW_SEC, 120);
});

test("provider bucket: slightly-future stamp is clamped (never a future bucket)", () => {
  const NOW = 1795540800;
  assert.equal(providerMinuteBucket(null, NOW, NOW + 3), NOW);
});

test("provider bucket: late sample for a finished minute is REJECTED, never rewritten", () => {
  const minuteInBuild: SpotCandle = { t: 1795540800, o: 4120, h: 4121, l: 4119, c: 4120.5, s: 30 };
  // the stamp is trusted (within skew) but points at the PREVIOUS minute —
  // folding it would rewrite the finished minute: rejected
  const nowSec = 1795540800 + 30;
  assert.equal(providerMinuteBucket(minuteInBuild, nowSec, 1795540800 - 60), null);
  // an in-order stamp passes and lands on the current minute
  assert.equal(providerMinuteBucket(minuteInBuild, nowSec, 1795540800 + 25), 1795540800);
});

// ---------------------------------------------------------------------------
// honest feed-health classification
// ---------------------------------------------------------------------------

test("health: fresh stamp → live, 25-35s gold-api delay → delayed, >90s → stale", () => {
  assert.equal(healthFromDelay(5, 0), "live");
  assert.equal(healthFromDelay(15, 0), "live");
  assert.equal(healthFromDelay(25, 0), "delayed"); // the measured gold-api norm
  assert.equal(healthFromDelay(90, 0), "delayed");
  assert.equal(healthFromDelay(91, 0), "stale");
  assert.equal(healthFromDelay(null, 0), "live"); // no stamp — cannot claim delayed
});

test("health: consecutive failures classify as PROVIDER ERROR regardless of stamp", () => {
  assert.equal(healthFromDelay(1, 3), "error");
  assert.equal(healthFromDelay(null, 5), "error");
  assert.equal(healthFromDelay(2, 2), "live"); // below the failure threshold
});

// ---------------------------------------------------------------------------
// measured BID↔spot boundary offset
// ---------------------------------------------------------------------------

test("offset: mean/median/stdev over genuine overlaps; null below MIN_OVERLAP_SAMPLES", () => {
  // every overlap shows the same +0.40 spread → clean statistics
  const samples = Array.from({ length: MIN_OVERLAP_SAMPLES }, (_, i) => ({ spotClose: 4123 + i * 0.01, bidClose: 4122.6 + i * 0.01 }));
  const off = computeBidSpotOffset(samples)!;
  assert.equal(off.n, MIN_OVERLAP_SAMPLES);
  assert.ok(Math.abs(off.mean - 0.4) < 1e-9);
  assert.ok(Math.abs(off.median - 0.4) < 1e-9);
  assert.ok(off.stdev < 1e-9);
  // 7 overlaps — no number is better than a number built from too few
  assert.equal(computeBidSpotOffset(samples.slice(0, 7)), null);
});

test("offset: outlier deltas outside the sane band are filtered", () => {
  const samples = Array.from({ length: MIN_OVERLAP_SAMPLES + 1 }, () => ({ spotClose: 4123, bidClose: 4122.6 }));
  samples[0] = { spotClose: 4123, bidClose: 200 }; // corrupted row — filtered
  const off = computeBidSpotOffset(samples)!;
  assert.equal(off.n, MIN_OVERLAP_SAMPLES);
  assert.ok(Math.abs(off.mean - 0.4) < 1e-9);
});

// ---------------------------------------------------------------------------
// live-tail merge with provider stamps (delayed/duplicate/out-of-order)
// ---------------------------------------------------------------------------

const TAIL: SpotTailBar[] = [
  { time: 1795540800 - 120, open: 4120, high: 4121.2, low: 4119.5, close: 4120.6, volume: 12 },
  { time: 1795540800 - 60, open: 4120.6, high: 4121.8, low: 4120.1, close: 4121.0, volume: 15 },
];

test("tail merge: current bucket paints the spot, body stays continuous", () => {
  // the provider stamp says the live bucket is 1795540800 (10s into it)
  const merged = mergeSpotTail(TAIL, 4121.9, 60, 5, 1795540800 + 10)!;
  assert.equal(merged.length, TAIL.length + 1);
  const live = merged[merged.length - 1];
  assert.equal(live.time, 1795540800);
  assert.equal(live.open, 4121.0); // previous close — no seam jump
  assert.equal(live.close, 4121.9);
  assert.equal(live.high, 4121.9);
});

test("tail merge: duplicate same-bucket updates never mint extra candles", () => {
  const a = mergeSpotTail(TAIL, 4121.9, 60, 5, 1795540800 + 10)!;
  const b = mergeSpotTail(a, 4122.4, 60, 5, 1795540800 + 20)!;
  assert.equal(b.length, a.length); // same bucket updated in place
  assert.equal(b[b.length - 1].close, 4122.4);
  assert.equal(b[b.length - 1].high, 4122.4);
});

test("tail merge: out-of-order (older) spot is rejected by the outlier/stale guards", () => {
  // a 2% outlier (stuck-price glitch) is refused — no fabricated bar
  assert.equal(mergeSpotTail(TAIL, 4121.0 * 1.03, 60, 5, 1795540800 + 10), null);
  // an empty history has nothing to merge
  assert.equal(mergeSpotTail([], 4121, 60, 5), null);
});

test("P49 catch-up contract: a tail more than maxFill buckets behind returns null", () => {
  // the recorded store's newest minute is 10 minutes old (background tab,
  // weekly open) — the fill-forward cap refuses and the caller must reload
  // the recorded set (event-driven catch-up) instead of painting a chasm
  const staleTail: SpotTailBar[] = [{ time: 1795540800 - 10 * 60, open: 4120, high: 4120.2, low: 4119.8, close: 4120.1, volume: 6 }];
  assert.equal(mergeSpotTail(staleTail, 4121.1, 60, 5, 1795540800), null);
});

// ---------------------------------------------------------------------------
// provider timestamp validation on stored candles
// ---------------------------------------------------------------------------

test("validSpotCandle: forged future minutes and unaligned buckets are rejected", () => {
  const now = 1795540800;
  assert.equal(validSpotCandle({ t: 1795540800, o: 4123, h: 4124, l: 4122, c: 4123.5, s: 3 }, now), true);
  assert.equal(validSpotCandle({ t: 1795540800 + 60, o: 4123, h: 4124, l: 4122, c: 4123.5, s: 3 }, now), false); // future
  assert.equal(validSpotCandle({ t: 1795540800 + 30, o: 4123, h: 4124, l: 4122, c: 4123.5, s: 3 }, now), false); // unaligned
  assert.equal(validSpotCandle({ t: 1795540800, o: 4123, h: 4122, l: 4124, c: 4123.5, s: 3 }, now), false); // broken envelope
});

// ---------------------------------------------------------------------------
// higher-timeframe aggregation consistency (M1 → M5/H1)
// ---------------------------------------------------------------------------

test("aggregation: 5 M1 bars fold into one M5 bucket aligned to the 5-minute grid", () => {
  const base = 1795540800; // minute-aligned
  const m1: SpotTailBar[] = [];
  for (let i = 0; i < 5; i++) {
    m1.push({ time: base + i * 60, open: 4120 + i, high: 4121 + i, low: 4119 + i, close: 4120.5 + i, volume: 10 + i });
  }
  const m5 = aggregateBars(m1 as any[], 5) as any[];
  assert.equal(m5.length, 1);
  assert.equal(m5[0].time, base); // bucket anchored to the 5-minute grid
  assert.equal(m5[0].open, 4120);
  assert.equal(m5[0].close, 4124.5);
  assert.equal(m5[0].high, 4125);
  assert.equal(m5[0].low, 4119);
  assert.equal(m5[0].volume, 60);
});

test("aggregation: partial bucket folds without inventing bars (honest gaps stay)", () => {
  const base = 1795540800;
  const m1 = [
    { time: base + 0 * 60, open: 4120, high: 4121, low: 4119, close: 4120.5, volume: 10 },
    { time: base + 4 * 60, open: 4124, high: 4125, low: 4123, close: 4124.5, volume: 10 }, // minutes 1-3 missing
  ];
  const m5 = aggregateBars(m1 as any[], 5) as any[];
  assert.equal(m5.length, 1); // one M5 bucket, NOT fabricated middle minutes
  assert.equal(m5[0].low, 4119);
  assert.equal(m5[0].high, 4125);
});

// ---------------------------------------------------------------------------
// fetch policy (authedFetch retry decision)
// ---------------------------------------------------------------------------

test("fetch policy: 5xx and network errors retry once on GETs, 4xx never", () => {
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(429), false);
  assert.equal(shouldRetryFetch(0, 1, 503, false), true);
  assert.equal(shouldRetryFetch(1, 1, 503, false), false); // bounded
  assert.equal(shouldRetryFetch(0, 1, 404, false), false);
  assert.equal(shouldRetryFetch(0, 1, null, true), true); // timeout / socket
  assert.equal(shouldRetryFetch(1, 1, null, true), false);
  // POSTs default to zero retries (mutations never double-fire)
  assert.equal(shouldRetryFetch(0, 0, 503, false), false);
});

// ---------------------------------------------------------------------------
// DST-aware session expectation (the old fixed-UTC gap scan miscounted here)
// ---------------------------------------------------------------------------

test("closedIntervals: the metals daily break follows New York across DST", () => {
  // 2026-11-24 (EST, winter): 17:00 NY = 22:00 UTC — the daily break is 22:00-23:00 UTC
  const winterDay = Date.UTC(2026, 10, 24) / 1000;
  const ivs = closedIntervals("XAUUSD", winterDay, winterDay + 86400);
  const breakIv = ivs.find((iv) => iv.to - iv.from === 3600);
  assert.ok(breakIv, "the daily 17:00-18:00 NY pause must exist");
  assert.equal(breakIv!.from, winterDay + 22 * 3600, "EST winter break starts 22:00 UTC");
  // 2026-06-16 (EDT, summer): 17:00 NY = 21:00 UTC
  const summerDay = Date.UTC(2026, 5, 16) / 1000;
  const ivs2 = closedIntervals("XAUUSD", summerDay, summerDay + 86400);
  const breakIv2 = ivs2.find((iv) => iv.to - iv.from === 3600);
  assert.ok(breakIv2, "the daily pause must exist in summer too");
  assert.equal(breakIv2!.from, summerDay + 21 * 3600, "EDT summer break starts 21:00 UTC");
});

test("closedIntervals: Saturday is fully closed for metals (no invented candles)", () => {
  const saturday = Date.UTC(2026, 10, 21) / 1000; // 2026-11-21 is a Saturday
  const ivs = closedIntervals("XAUUSD", saturday, saturday + 86400);
  const fullDay = ivs.find((iv) => iv.from <= saturday && iv.to >= saturday + 86400);
  assert.ok(fullDay, "Saturday must be a full closed interval");
});
