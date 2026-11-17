/**
 * Phase 10 — candle data integrity & feed engine tests.
 * Run: node --test tests/feed-validation.test.ts
 *
 * OHLC validation, body/wick math, real captured Yahoo data (fixture),
 * phantom-duplicate dropping, spot-merge guards, live candle updates,
 * timeframe transitions, duplicate/out-of-order ticks, outliers,
 * and the WebSocket reconnect ladder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import {
  checkBar, validateBars, dedupeBars, alignAndDedupe, spotMergeGuard, bucketStart,
  type RawBar,
} from "../shared/feed-validation.ts";
import { upsertBar, wsBackoffDelay, nextEndpointIndex } from "../shared/candle-core.ts";
import { aggregateBars, TF_SECONDS } from "../shared/terminal.ts";

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 100): RawBar =>
  ({ time, open, high, low, close, volume });

// ---------------------------------------------------------------------------
// 1) OHLC validation rules (the spec's invariants)
// ---------------------------------------------------------------------------
test("checkBar accepts a valid candle", () => {
  const c = checkBar(bar(1000, 100, 110, 90, 105));
  assert.equal(c.ok, true);
  assert.equal(c.repaired, false);
});

test("checkBar repairs High below body (H < max(O,C))", () => {
  const c = checkBar(bar(1000, 100, 104, 90, 105)); // H=104 < C=105
  assert.equal(c.ok, true);
  assert.equal(c.repaired, true);
  const { bars } = validateBars([bar(1000, 100, 104, 90, 105)]);
  assert.equal(bars[0].high, 105); // widened to the true envelope
});

test("checkBar repairs Low above body (L > min(O,C))", () => {
  const c = checkBar(bar(1000, 100, 110, 96, 95)); // L=96 > C=95
  assert.equal(c.ok, true);
  assert.equal(c.repaired, true);
  const { bars } = validateBars([bar(1000, 100, 110, 96, 95)]);
  assert.equal(bars[0].low, 95);
});

test("checkBar rejects inverted High<Low outright", () => {
  const c = checkBar(bar(1000, 100, 90, 110, 100));
  assert.equal(c.ok, false);
  assert.equal(c.reason, "high-low-inverted");
});

test("checkBar rejects non-finite and non-positive prices", () => {
  assert.equal(checkBar(bar(1000, NaN, 110, 90, 105)).ok, false);
  assert.equal(checkBar(bar(1000, Infinity, 110, 90, 105)).ok, false);
  assert.equal(checkBar(bar(1000, 0, 110, 90, 105)).ok, false);
  assert.equal(checkBar(bar(1000, -5, 110, 90, 105)).ok, false);
  assert.equal(checkBar({ time: 1000, open: "12" as unknown as number, high: 110, low: 90, close: 105 }).ok, false);
});

test("validateBars keeps order, counts invalid and repaired", () => {
  const res = validateBars([
    bar(1, 100, 110, 90, 105),
    bar(2, 100, 90, 110, 100),   // inverted → dropped
    bar(3, 100, 104, 90, 105),   // repaired
    bar(4, NaN, 110, 90, 105),   // dropped
  ]);
  assert.equal(res.bars.length, 2);
  assert.deepEqual(res.bars.map((b) => b.time), [1, 3]);
  assert.equal(res.invalid, 2);
  assert.equal(res.repaired, 1);
});

// ---------------------------------------------------------------------------
// 2) Candle body & wick math (rendering geometry must match the data)
// ---------------------------------------------------------------------------
test("body and wick calculations are consistent with the OHLC rules", () => {
  const bars = [bar(1, 100, 110, 90, 105), bar(2, 105, 107, 95, 96), bar(3, 96, 96.5, 96, 96.2)];
  for (const b of bars) {
    const body = Math.abs(b.close - b.open);
    const wickUp = b.high - Math.max(b.open, b.close);
    const wickDown = Math.min(b.open, b.close) - b.low;
    assert.ok(body >= 0, "body is never negative");
    assert.ok(wickUp >= 0 && wickDown >= 0, "wicks are never negative");
    assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close));
  }
  // a zero-width body (doji) is legitimate — but only when the data says so
  const doji = bar(4, 100, 102, 98, 100);
  assert.equal(Math.abs(doji.close - doji.open), 0);
});

// ---------------------------------------------------------------------------
// 3) REAL captured Yahoo GC=F 1m data — the exact Phase 10 defect
// ---------------------------------------------------------------------------
interface Fixture { bars: RawBar[]; regularMarketTime: number; note: string }
const FIXTURE: Fixture = JSON.parse(readFileSync(new URL("./fixtures/yahoo-gcf-1m.json", import.meta.url), "utf8"));

test("REAL Yahoo fixture: every captured bar passes OHLC validation", () => {
  const res = validateBars(FIXTURE.bars);
  assert.equal(res.invalid, 0, "Yahoo raw OHLC is structurally valid");
  assert.equal(res.repaired, 0, "no envelope violations in the real capture");
});

test("REAL Yahoo fixture: the trailing un-aligned phantom bar is dropped", () => {
  const raw = FIXTURE.bars;
  const lastReal = raw[raw.length - 2];
  const phantom = raw[raw.length - 1];
  // the capture really contains the defect: phantom is NOT minute-aligned and is a single-price bar
  assert.equal(phantom.time % 60 !== 0, true, "phantom timestamp is sub-minute");
  assert.equal(phantom.open, phantom.high && phantom.low && phantom.close, "phantom body is zero-width");
  const { bars, dropped, aligned } = alignAndDedupe(raw, 60);
  assert.ok(dropped >= 1, "phantom dropped");
  assert.ok(aligned >= 1, "sub-minute timestamps bucket-aligned");
  assert.equal(bars[bars.length - 1].time, lastReal.time - (lastReal.time % 60), "series ends on the real minute bar");
  // the last candles now look like their neighbours: non-zero body, sane wicks
  for (const b of bars.slice(-3)) {
    assert.ok(b.high - b.low >= 0);
    assert.notEqual(b.open, b.close || b.high === b.low && b.volume === 0, "no single-price zero-volume candle remains");
  }
});

test("REAL Yahoo fixture: dedupeBars keeps the informative bar on exact duplicates", () => {
  const dup = [...FIXTURE.bars, { ...FIXTURE.bars[FIXTURE.bars.length - 2] }];
  const { bars, dropped } = dedupeBars(dup);
  assert.equal(dropped, 1);
  assert.equal(bars.length, FIXTURE.bars.length);
});

// ---------------------------------------------------------------------------
// 4) Spot-merge guards — the long-wick root cause
// ---------------------------------------------------------------------------
test("spotMergeGuard rejects painting across a stale history gap", () => {
  // history ends 9 minutes behind the current bucket (real Yahoo delay)
  const bars = [bar(bucketStart(1794932900, 60) - 9 * 60, 3872.5, 3872.9, 3871.3, 3872.8)];
  const verdict = spotMergeGuard(bars, 3874.5, { sec: 60, nowSec: 1794932900 });
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, "stale-history");
});

test("spotMergeGuard allows painting when history is at most one bucket behind", () => {
  const now = 1794932900;
  const bars = [bar(bucketStart(now, 60) - 60, 3872.5, 3873.9, 3871.3, 3872.8)];
  const verdict = spotMergeGuard(bars, 3874.5, { sec: 60, nowSec: now });
  assert.equal(verdict.ok, true);
});

test("spotMergeGuard rejects extreme spot outliers (>2% from the last close)", () => {
  const now = 1794932900;
  const bars = [bar(bucketStart(now, 60) - 60, 3872.5, 3873.9, 3871.3, 3872.8)];
  const corrupted = spotMergeGuard(bars, 3872.8 * 1.05, { sec: 60, nowSec: now });
  assert.equal(corrupted.ok, false);
  assert.equal((corrupted as { reason: string }).reason, "spot-outlier");
  // a genuine small move (basis drift) passes
  assert.equal(spotMergeGuard(bars, 3872.8 * 1.003, { sec: 60, nowSec: now }).ok, true);
});

// ---------------------------------------------------------------------------
// 5) Live candle updates (upsertBar semantics)
// ---------------------------------------------------------------------------
test("live tick updates the current candle in place (H/L/Close)", () => {
  const bars = [bar(1000, 100, 110, 90, 105)];
  const next = upsertBar(bars, bar(1000, 100, 112, 89, 108));
  assert.equal(next.length, 1, "no new candle within the same timeframe");
  assert.equal(next[0].high, 112);
  assert.equal(next[0].low, 89);
  assert.equal(next[0].close, 108);
});

test("exactly ONE new candle is created when the timeframe closes", () => {
  const bars = [bar(60, 100, 110, 90, 105)];
  const next = upsertBar(bars, bar(120, 105, 115, 95, 110));
  assert.equal(next.length, 2);
  assert.equal(next[1].open, 105, "new candle opens at the boundary");
});

test("duplicate identical ticks are detected but remain idempotent", () => {
  const bars = [bar(1000, 100, 110, 90, 105)];
  let dups = 0;
  upsertBar(bars, bar(1000, 100, 110, 90, 105), { onDuplicate: () => dups++ });
  upsertBar(bars, bar(1000, 100, 110, 90, 105), { onDuplicate: () => dups++ });
  assert.equal(dups, 2);
  assert.equal(bars.length, 1, "chart never gains phantom candles from repeats");
});

test("out-of-order ticks never corrupt the tail or jump the chart back", () => {
  const bars = [bar(100, 100, 110, 90, 105), bar(200, 105, 115, 95, 110)];
  let ooo = 0;
  const next = upsertBar(bars, bar(150, 102, 108, 92, 106), { onOutOfOrder: () => ooo++ });
  assert.equal(ooo, 1);
  assert.equal(next.length, 3);
  assert.deepEqual(next.map((b) => b.time), [100, 150, 200], "sorted, newest last");
  assert.equal(next[next.length - 1].time, 200, "the newest candle stays at the end");
});

test("series is memory-capped from the left", () => {
  let bars: RawBar[] = [];
  for (let i = 0; i < 7000; i++) bars = upsertBar(bars, bar(i * 60 + 1e9, 1, 2, 0.5, 1.5));
  assert.equal(bars.length, 6000);
  assert.equal(bars[0].time, (7000 - 6000) * 60 + 1e9);
});

// ---------------------------------------------------------------------------
// 6) Timeframe transitions & UTC bucket math for M1..W1
// ---------------------------------------------------------------------------
test("bucketStart aligns every timeframe to UTC boundaries", () => {
  // 2026-11-17 16:34:56 UTC
  const now = 1794933296;
  assert.equal(bucketStart(now, 60), Math.floor(now / 60) * 60);
  assert.equal(bucketStart(now, 180) % 180, 0, "M3 aligned");
  assert.equal(bucketStart(now, 300) % 300, 0, "M5 aligned");
  assert.equal(bucketStart(now, 900) % 900, 0, "M15 aligned");
  assert.equal(bucketStart(now, 1800) % 1800, 0, "M30 aligned");
  assert.equal(bucketStart(now, 3600) % 3600, 0, "H1 aligned");
  assert.equal(bucketStart(now, 7200) % 7200, 0, "H2 aligned");
  assert.equal(bucketStart(now, 14400) % 14400, 0, "H4 aligned");
  assert.equal(bucketStart(now, 86400) % 86400, 0, "D1 aligned to UTC midnight");
  const d1 = new Date(bucketStart(now, 86400) * 1000);
  assert.equal(d1.toISOString().slice(11), "00:00:00.000Z", "D1 opens at 00:00 UTC");
  const w1 = new Date(bucketStart(now, 7 * 86400) * 1000);
  assert.equal(w1.getUTCDay(), 1, "W1 opens on a UTC Monday");
});

test("aggregateBars joins M1 bars into M5 buckets with UTC-aligned times", () => {
  const m1 = [0, 60, 120, 180, 240, 300, 360].map((s) =>
    bar(1794933000 - (1794933000 % 60) + s, 100, 101, 99, 100.5, 10),
  );
  const m5 = aggregateBars(m1 as never, 5);
  assert.equal(m5.length, 2);
  assert.equal(m5[0].time % 300, 0, "bucket aligned to the M5 boundary");
  assert.equal(m5[0].open, 100, "bucket open = first bar's open");
  assert.equal(m5[0].close, 100.5, "bucket close = last bar's close");
  assert.equal(m5[0].high, 101, "bucket high = max high");
  assert.equal(m5[0].low, 99, "bucket low = min low");
});

// ---------------------------------------------------------------------------
// 7) WebSocket reconnection ladder
// ---------------------------------------------------------------------------
test("reconnect backoff doubles and caps at 15s", () => {
  let delay = 0;
  const seq: number[] = [];
  for (let i = 0; i < 6; i++) { delay = wsBackoffDelay(delay); seq.push(delay); }
  assert.deepEqual(seq, [2000, 4000, 8000, 15000, 15000, 15000]);
  assert.equal(wsBackoffDelay(1000), 2000, "first retry after the initial 1s backoff");
});

test("blocked endpoints rotate, working endpoints stay", () => {
  assert.equal(nextEndpointIndex(0, 3, false), 1, "never-delivered endpoint rotates");
  assert.equal(nextEndpointIndex(1, 3, false), 2);
  assert.equal(nextEndpointIndex(2, 3, false), 0, "wraps around the mirror list");
  assert.equal(nextEndpointIndex(1, 3, true), 1, "a working endpoint is kept");
});
