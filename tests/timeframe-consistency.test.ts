/**
 * Phase 19 §4 — timeframe consistency tests.
 * Run: node --test tests/timeframe-consistency.test.ts  (also picked up by npm test)
 *
 * Locks the timeframe machinery: TF table integrity, OHLC aggregation into
 * every higher timeframe (3m/2h/4h aggregated client-side from 1m/1h base
 * feeds), bucket alignment on the UTC grid, no duplicate timestamps, and
 * monotonic time ordering after aggregation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateBars, TF_SECONDS, TIMEFRAMES, BINANCE_INTERVAL, YAHOO_INTERVAL } from "../shared/terminal.ts";
import { bucketStart } from "../shared/feed-validation.ts";

// synthetic 1m bars: minute 0..119, price pattern known per minute
function m1Series(minutes: number): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const out = [];
  for (let i = 0; i < minutes; i++) {
    const o = 100 + i;
    out.push({ time: i * 60, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 + i });
  }
  return out;
}

test("TIMEFRAMES covers M1…MN1 with consistent TF_SECONDS", () => {
  assert.deepEqual(TIMEFRAMES, ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"]);
  for (const tf of TIMEFRAMES) assert.ok(TF_SECONDS[tf] > 0, `${tf} missing seconds`);
  assert.equal(TF_SECONDS["1h"], 3600);
  assert.equal(TF_SECONDS["4h"], 4 * TF_SECONDS["1h"]);
  assert.equal(TF_SECONDS["2h"], 2 * TF_SECONDS["1h"]);
});

test("BINANCE_INTERVAL / YAHOO_INTERVAL cover every timeframe", () => {
  for (const tf of TIMEFRAMES) {
    assert.ok(BINANCE_INTERVAL[tf], `binance interval missing for ${tf}`);
    assert.ok(YAHOO_INTERVAL[tf]?.range && YAHOO_INTERVAL[tf]?.interval, `yahoo interval missing for ${tf}`);
  }
});

test("aggregateBars 1m→3m: exact UTC :00/:03 buckets, OHLC envelope, no dups", () => {
  const m1 = m1Series(12); // 12 minutes → 4 × 3m bars
  const out = aggregateBars(m1 as any, 3);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((b) => b.time), [0, 180, 360, 540]);
  for (const b of out) {
    assert.equal(b.time % 180, 0, "3m bucket must sit on the 3-minute UTC grid");
    assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.high >= b.low);
  }
  // first 3m bar aggregates minutes 0-2: open=100, close=103, high=104, low=98
  assert.equal(out[0].open, 100);
  assert.equal(out[0].close, 103);
  assert.equal(out[0].high, 104);
  assert.equal(out[0].low, 98);
  assert.equal(out[0].volume, 10 + 11 + 12);
});

test("aggregateBars 1m→2h from 120 minutes: 1 bar, boundary aligned", () => {
  const out = aggregateBars(m1Series(120) as any, 120);
  assert.equal(out.length, 1);
  assert.equal(out[0].time % 7200, 0);
  assert.equal(out[0].open, 100);
  assert.equal(out[0].close, 220);
});

test("aggregateBars preserves monotonic order and never duplicates timestamps", () => {
  const out = aggregateBars(m1Series(97) as any, 4);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].time > out[i - 1].time, "aggregated bars must strictly advance");
  }
  assert.equal(new Set(out.map((b) => b.time)).size, out.length);
});

test("partial final bucket is included with the data it actually has", () => {
  const out = aggregateBars(m1Series(10) as any, 3); // 10 minutes → 3 buckets + partial 4th at :09
  assert.equal(out.length, 4);
  assert.equal(out[3].time, 540); // minute 9 belongs to the 9-11 minute bucket
  assert.equal(out[3].close, 110); // only minute 9 landed in the last bucket
  assert.equal(out[3].volume, 19);
});

test("bucketStart aligns intraday timeframes to UTC boundaries", () => {
  // 17:07:23 UTC → 1h bucket 17:00, 4h bucket 16:00, 1d bucket 00:00
  const now = Date.UTC(2026, 10, 19, 17, 7, 23) / 1000;
  assert.equal(bucketStart(now, 3600), Date.UTC(2026, 10, 19, 17, 0, 0) / 1000);
  assert.equal(bucketStart(now, 14400), Date.UTC(2026, 10, 19, 16, 0, 0) / 1000);
  assert.equal(bucketStart(now, 86400), Date.UTC(2026, 10, 19, 0, 0, 0) / 1000);
});
