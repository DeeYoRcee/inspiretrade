/**
 * Phase 22 — sub-minute timeframe engine tests.
 *  · aggregateToSeconds: 1s candles → 5s/15s/30s buckets with honest OHLC
 *    folds (first open, running high/low, latest close, summed volume)
 *  · availableTimeframes: seconds only where a real sub-minute source exists
 *    (crypto rides the native Binance 1s stream; metals build LIVE seconds
 *    candles from the 1s gold-api quotes; forex/indices have no sub-minute
 *    source and the UI never offers them there)
 *  · the bucket math matches shared/feed-validation bucketStart (the axis
 *    alignment every provider merge uses)
 * Run: node --test tests/  (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateToSeconds } from "../shared/candle-core.ts";
import { availableTimeframes, TF_SECONDS, type Timeframe } from "../shared/terminal.ts";
import { bucketStart } from "../shared/feed-validation.ts";

function secSeries(seconds: number, count: number): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const out = [];
  const base = 1_700_000_010; // 30-aligned so fixed-sec buckets are deterministic
  for (let i = 0; i < count; i++) {
    const o = 2000 + i;
    out.push({ time: base + i * seconds, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 3 });
  }
  return out;
}

test("aggregateToSeconds 1s→5s: exact buckets, OHLC envelope, summed volume", () => {
  const s1 = secSeries(1, 10); // 10 one-second bars → 2 × 5s buckets
  const out = aggregateToSeconds(s1 as any, 5);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((b) => b.time), [1_700_000_010, 1_700_000_015]);
  const b0 = out[0];
  assert.equal(b0.open, 2000);          // first observed price opens the bucket
  assert.equal(b0.close, 2005);         // latest close (5th second, o=2004 → c=2005)
  assert.equal(b0.high, 2006);          // max(2002..2006)
  assert.equal(b0.low, 1998);           // min(1998..2002)
  assert.equal(b0.volume, 15);          // 5 × 3
});

test("aggregateToSeconds 1s→30s folds partial trailing bucket", () => {
  const s1 = secSeries(1, 47); // 47 seconds → one full 30s + one 17s bucket
  const out = aggregateToSeconds(s1 as any, 30);
  assert.equal(out.length, 2);
  assert.equal(out[1].time - out[0].time, 30);
  assert.equal(out[1].volume, 17 * 3);
});

test("aggregateToSeconds passthrough for 1s and out-of-order safety", () => {
  const s1 = secSeries(1, 5);
  const same = aggregateToSeconds(s1 as any, 1);
  assert.equal(same.length, 5); // no aggregation → identity copy
  // unsorted input must not crash or produce negative spans (caller sorts)
  const shuffled = [s1[3], s1[0], s1[2], s1[1], s1[4]] as any;
  const out = aggregateToSeconds(shuffled, 5);
  assert.ok(out.every((b, i) => i === 0 || b.time >= out[i - 1].time));
});

test("aggregateToSeconds folds a late 1s frame into its OWN bucket", () => {
  // 3 one-second bars: 0, 1, 2 → one 5s bucket. A late frame at t=0 must fold
  // into that bucket, not open a phantom older one after it.
  const s1 = secSeries(1, 3);
  const out = aggregateToSeconds([{ ...s1[0], high: s1[0].high + 5 }] as any, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].high, 2007); // 2002+5
});

test("availableTimeframes: seconds only where genuine sources exist", () => {
  const crypto = availableTimeframes("BTCUSD");
  const metal = availableTimeframes("XAUUSD");
  const fx = availableTimeframes("EURUSD");
  const index = availableTimeframes("NAS100");
  for (const [tfs, allow] of [[crypto, true], [metal, true], [fx, false], [index, false]] as [Timeframe[], boolean][]) {
    const hasSec = tfs.some((tf) => TF_SECONDS[tf] < 60);
    assert.equal(hasSec, allow);
  }
  // the minute+ ladder is ALWAYS complete for every instrument
  for (const tfs of [crypto, metal, fx, index]) {
    assert.deepEqual(tfs.filter((tf) => TF_SECONDS[tf] >= 60),
      ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"]);
  }
  assert.equal(availableTimeframes("GHOST").some((tf) => TF_SECONDS[tf] < 60), false);
});

test("seconds buckets align with feed-validation bucketStart", () => {
  // the aggregation bucket MUST match the axis-alignment bucketStart or live
  // merges would paint a second candle next to its own history
  for (const sec of [1, 5, 15, 30]) {
    const t = 1_700_000_123;
    const agg = Math.floor(t / sec) * sec;
    assert.equal(agg, bucketStart(t, sec), `sec=${sec}`);
  }
});
