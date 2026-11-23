/**
 * Phase 59 — terminal transformation regression tests (pure modules).
 * Run: node --test tests/p59-terminal.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketStart } from "../shared/feed-validation.ts";
import { aggregateBars } from "../shared/terminal.ts";
import { clampPositionPrice, createPositionFromGesture } from "../client/src/lib/drawings.ts";

test("P59 P0: bucketStart anchors 1M to the UTC calendar month", () => {
  // mid-January → Jan 1; month boundaries 28-31 days apart, never day-granularity
  const M = 2592000;
  assert.equal(bucketStart(new Date("2024-01-15T10:30:00Z").getTime() / 1000, M), new Date("2024-01-01T00:00:00Z").getTime() / 1000);
  assert.equal(bucketStart(new Date("2024-02-28T23:00:00Z").getTime() / 1000, M), new Date("2024-02-01T00:00:00Z").getTime() / 1000);
  assert.equal(bucketStart(new Date("2024-03-01T00:00:01Z").getTime() / 1000, M), new Date("2024-03-01T00:00:00Z").getTime() / 1000);
  // daily/weekly semantics unchanged
  assert.equal(bucketStart(new Date("2024-01-15T10:30:00Z").getTime() / 1000, 86400), new Date("2024-01-15T00:00:00Z").getTime() / 1000);
  const mon = new Date("2024-01-15T00:00:00Z").getTime() / 1000;
  assert.equal(bucketStart(new Date("2024-01-17T10:00:00Z").getTime() / 1000, 604800), mon);
});

test("P59 P0: aggregateBars folds W1 Monday-anchored and 1M calendar-month", () => {
  const m1 = (day: number, hour: number, price: number) => ({
    time: new Date(Date.UTC(2024, 0, day, hour, 0, 0)).getTime() / 1000,
    open: price, high: price + 1, low: price - 1, close: price, volume: 1,
  });
  // Jan 6 2024 is Saturday, Jan 8 is Monday — the old epoch floor anchored weeks to Thursday
  const weekly = aggregateBars([m1(6, 12, 10), m1(8, 1, 20), m1(9, 2, 30)], 10080);
  assert.equal(weekly.length, 2); // Sat Jan 6 lands in the week of Jan 1 (Monday)
  assert.equal(weekly[0].time, new Date(Date.UTC(2024, 0, 1)).getTime() / 1000);
  assert.equal(weekly[1].time, new Date(Date.UTC(2024, 0, 8)).getTime() / 1000);
  // monthly: Feb 28 + Mar 1 must NEVER share a bucket (old 30-day grid merged them)
  const monthly = aggregateBars([
    { time: new Date(Date.UTC(2024, 1, 28, 23, 0)).getTime() / 1000, open: 5, high: 6, low: 4, close: 5, volume: 1 },
    { time: new Date(Date.UTC(2024, 2, 1, 0, 1)).getTime() / 1000, open: 7, high: 8, low: 6, close: 7, volume: 1 },
  ], 43200);
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].time, new Date(Date.UTC(2024, 1, 1)).getTime() / 1000);
  assert.equal(monthly[1].time, new Date(Date.UTC(2024, 2, 1)).getTime() / 1000);
});

test("P59 P1: session-anchored aggregation aligns index 2h buckets to the session grid", () => {
  // Yahoo hourly index bars stamped 13:30/14:30/15:30 UTC (session open 13:30)
  const h = (hour: number, min: number, price: number) => ({
    time: new Date(Date.UTC(2024, 0, 2, hour, min, 0)).getTime() / 1000,
    open: price, high: price + 1, low: price - 1, close: price, volume: 1,
  });
  const bars = [h(13, 30, 1), h(14, 30, 2), h(15, 30, 3), h(16, 30, 4)];
  const anchor = bars[0].time % 7200; // align the grid to the session
  const h2 = aggregateBars(bars, 120, anchor);
  assert.equal(h2.length, 2); // 13:30-15:29 and 15:30-17:29 — NOT split mid-hour
  assert.equal(h2[0].high, 3); // first bucket holds 13:30+14:30 bars
  assert.equal(h2[0].time % 7200, anchor);
});

test("P59 P1: loader never re-aggregates already-weekly/monthly sources", () => {
  // mirror of history-loader.ts sourceAlreadyAggregated (kept local — that
  // module imports @/lib/api which plain node cannot resolve)
  const sourceAlreadyAggregated = (interval: string, aggMinutes: number): boolean =>
    (interval === "1w" && aggMinutes === 10080) || (interval === "1mo" && aggMinutes === 43200);
  assert.equal(sourceAlreadyAggregated("1w", 10080), true);
  assert.equal(sourceAlreadyAggregated("1mo", 43200), true);
  assert.equal(sourceAlreadyAggregated("1h", 120), false); // 2h from 1h base still folds
  assert.equal(sourceAlreadyAggregated("1d", 10080), false); // weekly from daily still folds (Monday-anchored now)
});

test("P59 P2: degenerate position creation enforces the directional gap", () => {
  // drag lands within half a tick of entry — stop/target must NOT equal entry
  const pts = createPositionFromGesture("long-position", { time: 1000, price: 100.0 }, { time: 1100, price: 100.001 }, 0.01);
  assert.notEqual(pts[1].price, pts[0].price); // stop below entry
  assert.notEqual(pts[2].price, pts[0].price); // target above entry
  assert.ok(pts[1].price < 100.0);
  assert.ok(pts[2].price >= 100.01);
});

test("P59 P2: clampPositionPrice signature (entry, price, tick) unchanged", () => {
  assert.equal(clampPositionPrice("long-position", 1, 100, 101, 0.01), 99.99);
  assert.equal(clampPositionPrice("long-position", 2, 100, 99, 0.01), 100.01);
  assert.equal(clampPositionPrice("short-position", 1, 100, 99, 0.01), 100.01);
});
