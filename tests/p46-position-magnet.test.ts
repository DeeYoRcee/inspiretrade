/**
 * P46 — TradingView-grade Long/Short Position tools + Magnet Mode tests.
 * Pure-logic coverage: tick rounding, directional clamps, gesture-derived
 * positions, magnet thresholds/migration. Run: node --test tests/p46-position-magnet.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  snapToTick, clampPositionPrice, createPositionFromGesture,
  MAGNET_PX, magnetSnapPrice, magnetSnapTime, magnetModeOf,
  type DrawingPoint,
} from "../client/src/lib/drawings.ts";

// ---------------------------------------------------------------------------
// P46 §1.4 — tick rounding (real instrument increments)
// ---------------------------------------------------------------------------
test("snapToTick rounds to the instrument tick (XAUUSD/EURUSD/NAS100)", () => {
  assert.equal(snapToTick(2345.678, 0.01), 2345.68); // XAUUSD tick 0.01
  assert.equal(snapToTick(1.234567, 0.00001), 1.23457); // EURUSD tick 0.00001
  assert.equal(snapToTick(18541.3, 0.25), 18541.25); // NAS100 tick 0.25
  assert.equal(snapToTick(18541.4, 0.25), 18541.5);
});

test("snapToTick without metadata never invents a step", () => {
  assert.equal(snapToTick(123.456, undefined), 123.456);
  assert.equal(snapToTick(123.456, 0), 123.456);
  assert.equal(snapToTick(123.456, -1), 123.456);
});

// ---------------------------------------------------------------------------
// P46 §1.1 — directional integrity: drags can never invert the position
// ---------------------------------------------------------------------------
test("clampPositionPrice — long stop stays below entry (gap = one tick)", () => {
  assert.equal(clampPositionPrice("long-position", 1, 100, 110, 0.01), 99.99);
  assert.equal(clampPositionPrice("long-position", 1, 100, 99.5, 0.01), 99.5); // free below
  assert.equal(clampPositionPrice("long-position", 1, 100, 100, 0), 100); // no tick → meets entry
});

test("clampPositionPrice — long target stays above entry; short mirrored; entry free", () => {
  assert.equal(clampPositionPrice("long-position", 2, 100, 90, 0.01), 100.01);
  assert.equal(clampPositionPrice("short-position", 1, 100, 90, 0.01), 100.01); // short stop ABOVE
  assert.equal(clampPositionPrice("short-position", 2, 100, 110, 0.01), 99.99); // short target BELOW
  assert.equal(clampPositionPrice("long-position", 0, 100, 250, 0.01), 250); // handle 0 = entry, free
});

// ---------------------------------------------------------------------------
// P46 §1.1 — one-gesture creation: drag side picks stop/target, other mirrors
// ---------------------------------------------------------------------------
const pt = (time: number, price: number): DrawingPoint => ({ time, price });

test("createPositionFromGesture — LONG drag UP: cursor = target, stop mirrors at 1:1", () => {
  const [entry, stop, target] = createPositionFromGesture("long-position", pt(1000, 100), pt(1100, 110));
  assert.deepEqual(entry, pt(1000, 100));
  assert.deepEqual(target, pt(1100, 110));
  assert.deepEqual(stop, pt(1100, 90));
});

test("createPositionFromGesture — LONG drag DOWN: cursor = stop, target mirrors", () => {
  const [entry, stop, target] = createPositionFromGesture("long-position", pt(1000, 100), pt(1100, 95));
  assert.deepEqual(stop, pt(1100, 95));
  assert.deepEqual(target, pt(1100, 105));
});

test("createPositionFromGesture — SHORT mirrors both sides", () => {
  const [entry, stop, target] = createPositionFromGesture("short-position", pt(1000, 100), pt(1100, 110));
  assert.deepEqual(stop, pt(1100, 110)); // short stop ABOVE entry
  assert.deepEqual(target, pt(1100, 90)); // short target BELOW
  const [, stop2, target2] = createPositionFromGesture("short-position", pt(1000, 100), pt(1100, 95));
  assert.deepEqual(stop2, pt(1100, 105)); // short stop mirrors ABOVE entry
  assert.deepEqual(target2, pt(1100, 95)); // drag down = target BELOW
});

test("createPositionFromGesture rounds every level to the instrument tick", () => {
  const [entry, stop, target] = createPositionFromGesture("long-position", pt(1000, 100.004), pt(1100, 101.237), 0.01);
  assert.equal(entry.price, 100);
  assert.equal(target.price, 101.24);
  assert.equal(stop.price, 98.77); // |101.237−100.004| = 1.233 mirrored → 98.771 → 98.77
});

// ---------------------------------------------------------------------------
// P46 §2 — magnet thresholds + real-data-only snapping
// ---------------------------------------------------------------------------
const BAR = { open: 1000, high: 1015, low: 985, close: 1008 };
const yOf = (p: number) => p; // 1px per $ — easy distance math

test("magnet thresholds: normal 12px does NOT reach, strong 36px does", () => {
  assert.equal(MAGNET_PX.normal, 12);
  assert.equal(MAGNET_PX.strong, 36);
  // cursor at 1030 — the high (1015) is 15px away
  assert.equal(magnetSnapPrice(1030, BAR, yOf, MAGNET_PX.normal), 1030); // normal: no snap
  assert.equal(magnetSnapPrice(1030, BAR, yOf, MAGNET_PX.strong), 1015); // strong: snaps to High
});

test("magnet snaps to Open/High/Low/Close within the threshold", () => {
  assert.equal(magnetSnapPrice(1014.2, BAR, yOf, 12), 1015); // High
  assert.equal(magnetSnapPrice(985.9, BAR, yOf, 12), 985); // Low
  assert.equal(magnetSnapPrice(1000.4, BAR, yOf, 12), 1000); // Open
  assert.equal(magnetSnapPrice(1008.3, BAR, yOf, 12), 1008); // Close
});

test("magnet NEVER snaps without a real bar (no fabricated OHLC)", () => {
  assert.equal(magnetSnapPrice(1030, null, yOf, 36), 1030);
  assert.equal(magnetSnapPrice(1030, undefined, yOf, 36), 1030);
});

test("magnetSnapTime anchors weekly drawings to Monday 00:00 UTC", () => {
  // Thursday 2026-01-01 00:00 UTC = 1767225600 → week floor + Monday anchor
  const snapped = magnetSnapTime(1767225600, 604800);
  assert.equal((snapped - 345600) % 604800, 0);
  const d = new Date(snapped * 1000);
  assert.equal(d.getUTCDay(), 1); // Monday
});

// ---------------------------------------------------------------------------
// P46 §2.1 — legacy settings migration (magnet boolean → 3-state)
// ---------------------------------------------------------------------------
test("magnetModeOf migrates the legacy boolean and keeps valid modes", () => {
  assert.equal(magnetModeOf({ magnet: true }), 1);
  assert.equal(magnetModeOf({ magnet: false }), 0);
  assert.equal(magnetModeOf({ magnet: true, magnetMode: 2 }), 2);
  assert.equal(magnetModeOf({ magnetMode: 0 }), 0);
  assert.equal(magnetModeOf({ magnetMode: 7, magnet: true }), 1); // junk mode → legacy
  assert.equal(magnetModeOf({}), 0);
});
