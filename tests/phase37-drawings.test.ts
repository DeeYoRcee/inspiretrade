/**
 * Phase 37 — Fibonacci math, Andrews pitchfork geometry, sanitize upgrades
 * and preset/level validation tests.
 * Run: node --test tests/phase37-drawings.test.ts
 *
 * Expected values are hand-computed references, not implementation output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fibLevelPrice, pitchforkLines, sanitizeFibLevels, __sanitizeDrawingList,
  TOOL_POINT_COUNT, TOOL_LABELS, hitTest, makeDrawing,
  type Drawing, type XY,
} from "../client/src/lib/drawings.ts";

const p = (x: number, y: number): XY => ({ x, y });

// ---------------------------------------------------------------------------
// §2 — Fibonacci level math (retracement & extension), hand-computed
// ---------------------------------------------------------------------------
test("P37 fib retracement: hand-computed levels p0=100 → p1=50", () => {
  // price = p0 + (p1 − p0) × ratio
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 0), 100);
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 0.236), 100 - 50 * 0.236); // 88.2
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 0.5), 75);
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 0.618), 100 - 30.9);
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 1), 50);
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 1.618), 100 - 50 * 1.618); // 19.1
});

test("P37 fib retracement reversed: measures from p1 toward p0", () => {
  // reverse: price = p1 + (p0 − p1) × ratio
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 0.236, true), 50 + 50 * 0.236); // 61.8
  assert.equal(fibLevelPrice("retracement", 100, 50, 0, 1, true), 100);
});

test("P37 fib extension: swing projected from p2", () => {
  // price = p2 + (p1 − p0) × ratio; swing 100→50 = −50, p2 = 70
  assert.equal(fibLevelPrice("extension", 100, 50, 70, 0), 70);
  assert.equal(fibLevelPrice("extension", 100, 50, 70, 1), 20);
  assert.equal(fibLevelPrice("extension", 100, 50, 70, 1.618), 70 - 50 * 1.618); // −10.9
  assert.equal(fibLevelPrice("extension", 100, 50, 70, 2.618), 70 - 50 * 2.618); // −60.9
  // reverse projects the inverted swing: +50 from p2
  assert.equal(fibLevelPrice("extension", 100, 50, 70, 1.618, true), 70 + 50 * 1.618); // 150.9
});

// ---------------------------------------------------------------------------
// §1 — Andrews pitchfork geometry
// ---------------------------------------------------------------------------
test("P37 pitchfork: median through midpoint, prongs parallel, extended to edge", () => {
  // P0=(10,10), P1=(30,0), P2=(30,20) → mid=(30,10), dir=(20,0), edge=100
  const L = pitchforkLines(p(10, 10), p(30, 0), p(30, 20), 100);
  assert.deepEqual(L.median, { from: p(10, 10), to: p(100, 10) });
  assert.deepEqual(L.upper, { from: p(30, 0), to: p(100, 0) });
  assert.deepEqual(L.lower, { from: p(30, 20), to: p(100, 20) });
});

test("P37 pitchfork: sloped direction and left-opening edge", () => {
  // dir = mid − P0 = (20, −25); median from P0: t=(100−10)/20=4.5 → y=40−112.5=−72.5
  const L = pitchforkLines(p(10, 40), p(30, 0), p(30, 30), 100);
  assert.deepEqual(L.median.to, p(100, -72.5));
  // upper prong from P1=(30,0): t=3.5 → y=0−87.5=−87.5; lower from P2=(30,30): y=30−87.5=−57.5
  assert.deepEqual(L.upper.to, p(100, -87.5));
  assert.deepEqual(L.lower.to, p(100, -57.5));
  // opening left: edge 0 → prongs extend that way
  const L2 = pitchforkLines(p(50, 10), p(20, 0), p(20, 20), 0);
  assert.deepEqual(L2.median.from, p(50, 10));
  assert.equal(L2.median.to.x, 0);
});

test("P37 pitchfork: registered (3 points, P labels) and hit-testable", () => {
  assert.equal(TOOL_POINT_COUNT.pitchfork, 3);
  assert.deepEqual(TOOL_LABELS.pitchfork, ["P0", "P1", "P2"]);
  const d: Drawing = makeDrawing("pitchfork", [
    { time: 1000, price: 10 }, { time: 3000, price: 30 }, { time: 5000, price: 20 },
  ]);
  const sanitized = __sanitizeDrawingList([d]);
  assert.equal(sanitized.length, 1, "pitchfork survives sanitize (arity 3)");
});

// ---------------------------------------------------------------------------
// §2/§5 — level & style sanitization
// ---------------------------------------------------------------------------
test("P37 sanitizeFibLevels: custom levels kept, junk dropped", () => {
  const out = sanitizeFibLevels([
    { ratio: 0.382, show: true, color: "#ff0000", width: 2, dash: "dashed" },
    { ratio: "0.886", show: false },                     // numeric string ok
    { ratio: 999 },                                      // out of range → dropped
    { ratio: NaN },                                      // dropped
    null, "x",                                           // dropped
    { ratio: 0.5, show: true, color: "not-hex", width: 99, dash: "zigzag" }, // color/dash dropped, width clamped
  ]);
  assert.equal(out?.length, 3);
  assert.deepEqual(out?.[0], { ratio: 0.382, show: true, color: "#ff0000", width: 2, dash: "dashed" });
  assert.deepEqual(out?.[1], { ratio: 0.886, show: false });
  assert.deepEqual(out?.[2], { ratio: 0.5, show: true, width: 6 }, "bad color/dash ignored, width clamped like DrawingStyle");
  assert.equal(sanitizeFibLevels(undefined), undefined);
  assert.equal(sanitizeFibLevels([]), undefined);
});

test("P37 sanitize roundtrip: fib custom levels + showPrices/reverse survive", () => {
  const d: Drawing = {
    ...makeDrawing("fib-retracement", [{ time: 1, price: 100 }, { time: 2, price: 50 }]),
    levels: [{ ratio: 0.886, show: true, color: "#22d3ee", width: 3, dash: "dotted" }, { ratio: 7, show: false }],
    style: { ...makeDrawing("fib-retracement", []).style, showPrices: true, reverse: true },
  };
  const out = __sanitizeDrawingList([d])[0];
  assert.equal(out.levels?.length, 2, "custom levels preserved");
  assert.deepEqual(out.levels?.[0], { ratio: 0.886, show: true, color: "#22d3ee", width: 3, dash: "dotted" });
  assert.equal(out.style.showPrices, true);
  assert.equal(out.style.reverse, true);
});

test("P37 sanitize drops malformed fib levels from persistence", () => {
  const d: Drawing = {
    ...makeDrawing("fib-retracement", [{ time: 1, price: 1 }, { time: 2, price: 2 }]),
    levels: [{ ratio: "oops", show: true }, { ratio: 0.5, show: true }] as never,
  };
  const out = __sanitizeDrawingList([d])[0];
  assert.deepEqual(out.levels, [{ ratio: 0.5, show: true }]);
});

// ---------------------------------------------------------------------------
// hit-test: pitchfork tines are selectable, space between them is not
// ---------------------------------------------------------------------------
test("P37 hit-test: pitchfork tines selectable", () => {
  const d: Drawing = makeDrawing("pitchfork", [
    { time: 10, price: 10 }, { time: 30, price: -20 }, { time: 30, price: 40 },
  ]);
  const toCanvas = (dr: Drawing) => dr.points.map((q) => ({ x: q.time, y: q.price }));
  // horizontal tines: median y=10, upper y=−20, lower y=40 (5px hit band each)
  assert.ok(hitTest(p(60, 10), [d], toCanvas, 500, 500) != null, "median tine hit");
  assert.ok(hitTest(p(60, -20), [d], toCanvas, 500, 500) != null, "upper tine hit");
  assert.ok(hitTest(p(60, 40), [d], toCanvas, 500, 500) != null, "lower tine hit");
  assert.ok(hitTest(p(60, 24), [d], toCanvas, 500, 500) == null, "between tines → miss");
});
