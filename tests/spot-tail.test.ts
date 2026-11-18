/**
 * Phase 15 — live spot tail merger tests.
 * Exercises client/src/lib/spot-tail.ts: the browser paints the gold-api
 * spot onto the delayed history tail every second. Covers same-bucket
 * painting, flat fill-forward bridging, outlier rejection and the stale cap.
 * Run: node --test tests/spot-tail.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSpotTail, type SpotTailBar } from "../client/src/lib/spot-tail.ts";

const bar = (time: number, close: number): SpotTailBar => ({ time, open: close, high: close, low: close, close, volume: 1 });

test("same bucket: spot paints the current bar in place", () => {
  const sec = 60;
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / sec) * sec;
  const bars = [bar(bucket - sec, 100), bar(bucket, 100)];
  const out = mergeSpotTail(bars, 100.5, sec);
  assert.ok(out);
  assert.equal(out.length, 2);
  assert.equal(out[1].close, 100.5);
  assert.equal(out[1].high, 100.5);
  // original cached array untouched (identity-safe)
  assert.equal(bars[1].close, 100);
});

test("stale tail: flat fill-forward bridges to the live bucket", () => {
  const sec = 60;
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / sec) * sec;
  const bars = [bar(bucket - 3 * sec, 200)];
  const out = mergeSpotTail(bars, 200.8, sec);
  assert.ok(out);
  // 2 flat fills + 1 live bucket
  assert.equal(out.length, 4);
  assert.equal(out[1].time, bars[0].time + sec);
  assert.equal(out[1].close, 200); // flat continuation — no invented movement
  assert.equal(out[1].volume, 0);
  assert.equal(out[2].close, 200);
  assert.equal(out[3].time, bucket);
  assert.equal(out[3].close, 200.8);
  assert.equal(out[3].open, 200); // body continuous, no seam jump
});

test("outlier spot (>2% off last close) is rejected", () => {
  const sec = 60;
  const bars = [bar(Math.floor(Date.now() / 1000), 100)];
  assert.equal(mergeSpotTail(bars, 103, sec), null); // +3%
  assert.equal(mergeSpotTail(bars, 97, sec), null); // -3%
  assert.ok(mergeSpotTail(bars, 101.5, sec)); // +1.5% passes
});

test("hopelessly stale history (>90 buckets) is left untouched", () => {
  const sec = 60;
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / sec) * sec;
  const bars = [bar(bucket - 95 * sec, 50)];
  assert.equal(mergeSpotTail(bars, 50.1, sec), null);
});

test("empty history is rejected", () => {
  assert.equal(mergeSpotTail([], 100, 60), null);
});
