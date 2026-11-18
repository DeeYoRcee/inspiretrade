/**
 * Phase 15 — live spot tail merger tests.
 * Exercises client/src/lib/spot-tail.ts: the browser paints the gold-api
 * spot onto the delayed history tail every second. Covers same-bucket
 * painting, flat fill-forward bridging, outlier rejection and the stale cap.
 * Run: node --test tests/spot-tail.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeSpotCandles, mergeSpotSeries, mergeSpotTail, recordSpotTick, validSpotCandle,
  type SpotCandle, type SpotTailBar,
} from "../client/src/lib/spot-tail.ts";
import { aggregateBars, type Bar } from "../shared/terminal.ts";

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

// ---- Phase 16: self-recorded spot candles ----------------------------------

const minute = (t: number, o: number, h: number, l: number, c: number, s = 10): SpotCandle => ({ t, o, h, l, c, s });

test("recordSpotTick folds ticks into real minute candles", () => {
  const now = 1794982800; // minute-aligned
  let m = recordSpotTick(null, 100, now);
  assert.deepEqual(m, { t: now, o: 100, h: 100, l: 100, c: 100, s: 1 });
  m = recordSpotTick(m, 101.5, now + 1);
  m = recordSpotTick(m, 99.5, now + 2);
  m = recordSpotTick(m, 100.8, now + 3);
  assert.deepEqual(m, { t: now, o: 100, h: 101.5, l: 99.5, c: 100.8, s: 4 });
  // minute rollover → fresh candle at the real price
  const m2 = recordSpotTick(m, 101, now + 60);
  assert.deepEqual(m2, { t: now + 60, o: 101, h: 101, l: 101, c: 101, s: 1 });
});

test("mergeSpotCandles: open from earlier writer, close from later, envelope both", () => {
  const a = minute(1000, 100, 102, 99, 101, 20);
  const b = minute(1000, 100.5, 103, 98, 102.5, 25);
  const m = mergeSpotCandles(a, b);
  assert.equal(m.o, 100);       // a is the earlier observation of the same minute
  assert.equal(m.c, 102.5);     // b carries the newest close
  assert.equal(m.h, 103);
  assert.equal(m.l, 98);
  assert.equal(m.s, 25);
});

test("mergeSpotSeries unions two recorded series sorted and deduped", () => {
  const base = [minute(60, 1, 1, 1, 1), minute(120, 2, 2, 2, 2)];
  const inc = [minute(120, 2, 2.5, 1.8, 2.2), minute(180, 3, 3, 3, 3)];
  const out = mergeSpotSeries(base, inc);
  assert.deepEqual(out.map((c) => c.t), [60, 120, 180]);
  assert.equal(out[1].h, 2.5);
  assert.equal(out[1].c, 2.2);
});

test("validSpotCandle rejects forged or malformed candles", () => {
  const now = 1794982800;
  assert.ok(validSpotCandle(minute(now - 60, 100, 101, 99, 100.5), now));
  // future timestamp (forged history)
  assert.equal(validSpotCandle(minute(now + 60, 100, 101, 99, 100.5), now), false);
  // older than 8 days
  assert.equal(validSpotCandle(minute(now - 9 * 86400, 100, 101, 99, 100.5), now), false);
  // high below close (broken envelope)
  assert.equal(validSpotCandle(minute(now - 60, 100, 99, 98, 100.5), now), false);
  // low above open
  assert.equal(validSpotCandle(minute(now - 60, 100, 102, 101, 100.5), now), false);
  // not minute-aligned
  assert.equal(validSpotCandle(minute(now - 30, 100, 101, 99, 100.5), now), false);
  // impossible sample count
  assert.equal(validSpotCandle(minute(now - 60, 100, 101, 99, 100.5, 0), now), false);
  assert.equal(validSpotCandle(minute(now - 60, 100, 101, 99, 100.5, 61), now), false);
});

test("aggregation chain M1→M5→M15→H1 is mathematically consistent (§7C)", () => {
  // 240 real 1m candles with an intraday price path
  const m1: Bar[] = [];
  let px = 3700;
  for (let i = 0; i < 240; i++) {
    const o = px;
    const c = px + Math.sin(i / 7) * 3;
    m1.push({ time: 1794931200 + i * 60, open: o, high: Math.max(o, c) + 0.7, low: Math.min(o, c) - 0.7, close: c, volume: 40 + (i % 9) });
    px = c;
  }
  // factorMinutes is ABSOLUTE (target timeframe in minutes) — aggregating
  // M5→M15 uses 15, not "3 more buckets"
  const m5 = aggregateBars(m1, 5);
  const m15a = aggregateBars(m5, 15);  // M15 built from M5
  const m15b = aggregateBars(m1, 15);  // M15 built directly from M1
  assert.deepEqual(m15a, m15b);
  const h1a = aggregateBars(m15a, 60); // H1 from M15
  const h1b = aggregateBars(m1, 60);   // H1 directly from M1
  assert.deepEqual(h1a, h1b);
  // OHLC envelope invariants hold at every level
  for (const series of [m5, m15b, h1b]) {
    for (const b of series) {
      assert.ok(b.high >= Math.max(b.open, b.close), `high < body at ${b.time}`);
      assert.ok(b.low <= Math.min(b.open, b.close), `low > body at ${b.time}`);
    }
  }
  // bucket starts are aligned
  for (const b of h1b) assert.equal(b.time % 3600, 0);
});

test("mergeSpotTail with maxFill=5 leaves honest gaps beyond 5 missing buckets", () => {
  const sec = 60;
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / sec) * sec;
  const bars = [bar(bucket - 10 * sec, 200)];
  assert.equal(mergeSpotTail(bars, 200.5, sec, 5), null); // 9 missing buckets > maxFill
  const bars2 = [bar(bucket - 3 * sec, 200)];
  const out = mergeSpotTail(bars2, 200.5, sec, 5);
  assert.ok(out && out.length === 4); // 2 fills + live
});
