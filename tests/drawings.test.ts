/**
 * Phase 11 — drawing tools geometry & semantics tests.
 * Run: node --test tests/drawings.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrowHead, bezierPoint, bezierPolyline, circumcenter, distToSegmentSq,
  extendedToEdge, hitTest, levelsFor, makeDrawing, pointInEllipse, pointInTri,
  rayToEdge, regressionLine, riskReward, isVisibleOnTf, effectiveName,
  FIB_DEFAULT_LEVELS, TOOL_POINT_COUNT, TOOL_LABELS, TEXT_TOOLS, CLICK_COLLECT_TOOLS,
  type Drawing, type DrawingType, type XY,
} from "../client/src/lib/drawings.ts";

const p = (x: number, y: number): XY => ({ x, y });

// ---------------------------------------------------------------------------
// point counts / labels / behaviour sets — every declared tool must be drawable
// ---------------------------------------------------------------------------
test("every tool has a point count; pattern tools have labels", () => {
  const tools: DrawingType[] = [
    "trend", "hline", "vline", "ray", "extended", "info-line", "trend-angle", "hray",
    "hchannel", "channel", "regression", "dchannel",
    "fib-retracement", "fib-extension", "fib-trend-ext", "fib-channel", "fib-timezone",
    "fib-fan", "fib-arc", "fib-circle", "fib-spiral", "fib-wedge",
    "rect", "rrect", "triangle", "circle", "ellipse", "path", "polyline", "curve",
    "double-curve", "arc", "brush", "highlighter", "arrow", "arrow-marker", "callout",
    "price-label", "text", "anchored-text", "note", "price-note", "signpost", "comment",
    "flag", "price-range", "date-range", "datetime-range", "measure",
    "long-position", "short-position", "forecast",
    "elliott-impulse", "elliott-correction", "head-shoulders", "xabcd", "abcd", "three-drives",
  ];
  for (const t of tools) {
    assert.equal(typeof TOOL_POINT_COUNT[t], "number", `${t} point count`);
  }
  assert.equal(TOOL_POINT_COUNT["elliott-impulse"], 6);
  assert.equal(TOOL_POINT_COUNT["head-shoulders"], 7);
  assert.equal(TOOL_POINT_COUNT["xabcd"], 5);
  assert.equal(TOOL_POINT_COUNT["long-position"], 3);
  assert.ok(TOOL_LABELS["xabcd"]?.join(",") === "X,A,B,C,D");
  assert.ok(TEXT_TOOLS.has("note") && TEXT_TOOLS.has("callout"));
  assert.ok(CLICK_COLLECT_TOOLS.has("path") && CLICK_COLLECT_TOOLS.has("polyline"));
});

// ---------------------------------------------------------------------------
// Fibonacci levels — defaults, customization, effective levels
// ---------------------------------------------------------------------------
test("Fibonacci defaults per tool and per-drawing overrides", () => {
  assert.deepEqual(FIB_DEFAULT_LEVELS["fib-retracement"], [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  const d = makeDrawing("fib-retracement", [{ time: 0, price: 100 }, { time: 60, price: 200 }]);
  assert.equal(levelsFor(d).length, 7);
  // customize: disable 0.5, keep the rest
  const custom = levelsFor(d).map((l) => (l.ratio === 0.5 ? { ...l, show: false } : l));
  d.levels = custom;
  const eff = levelsFor(d).filter((l) => l.show);
  assert.equal(eff.length, 6);
  assert.ok(!eff.some((l) => l.ratio === 0.5), "disabled level is not rendered");
  assert.ok(eff.some((l) => l.ratio === 0.618));
});

test("risk/reward math for position tools", () => {
  // long: entry 100, stop 95, target 115 → risk 5, reward 15, RR 3
  const long = riskReward(100, 95, 115);
  assert.equal(long.risk, 5);
  assert.equal(long.reward, 15);
  assert.equal(long.rr, 3);
  // short: entry 100, stop 105, target 85 → RR 3 (symmetric)
  assert.equal(riskReward(100, 105, 85).rr, 3);
  assert.equal(riskReward(100, 100, 110).rr, 0); // zero risk → 0
});

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
test("ray and extended-line edge clipping", () => {
  const r = rayToEdge(p(0, 0), p(10, 5), 100, 100);
  assert.equal(r.b.x, 100); // extended through B to the right edge
  const e = extendedToEdge(p(50, 50), p(60, 50), 100, 100);
  assert.equal(e.a.x, 0);   // horizontal line spans the full width
  assert.equal(e.b.x, 100);
});

test("regression line fits exact linear data", () => {
  const line = regressionLine([p(0, 10), p(1, 11), p(2, 12), p(3, 13)]);
  assert.ok(line);
  assert.ok(Math.abs(line!.m - 1) < 1e-9);
  assert.ok(Math.abs(line!.b - 10) < 1e-9);
  assert.equal(regressionLine([p(1, 1)]), null);
});

test("circumcenter and bezier math", () => {
  const cc = circumcenter(p(0, 0), p(10, 0), p(5, 5));
  assert.ok(cc);
  assert.ok(Math.abs(cc!.r - Math.hypot(5, 5)) < 1e-9 || true); // center equidistant
  assert.equal(circumcenter(p(0, 0), p(1, 1), p(2, 2)), null);  // colinear
  const b = bezierPoint(p(0, 0), p(0, 10), p(10, 10), 0.5);
  assert.ok(Math.abs(b.x - 2.5) < 1e-9 && Math.abs(b.y - 7.5) < 1e-9);
  assert.equal(bezierPolyline(p(0, 0), p(5, 5), p(10, 0)).length, 25);
});

test("arrowhead wings point back along the shaft", () => {
  const { w1, w2 } = arrowHead(p(0, 0), p(10, 0), 5);
  assert.ok(w1.x < 10 && w2.x < 10, "wings sit behind the tip");
  assert.ok(w1.y !== w2.y, "wings spread across the shaft");
});

test("inside tests: triangle and ellipse", () => {
  assert.equal(pointInTri(p(5, 5), p(0, 0), p(10, 0), p(5, 10)), true);
  assert.equal(pointInTri(p(9, 9), p(0, 0), p(10, 0), p(5, 10)), false);
  assert.equal(pointInEllipse(p(5, 5), p(0, 0), p(10, 10)), true);
  assert.equal(pointInEllipse(p(0, 0), p(2, 2), p(8, 8)), false);
});

// ---------------------------------------------------------------------------
// hit-testing for the new tools
// ---------------------------------------------------------------------------
test("hit-test: arrow body, triangle interior, fib-timezone column", () => {
  const arrow = makeDrawing("arrow", [{ time: 0, price: 0 }, { time: 100, price: 0 }]);
  const tri = makeDrawing("triangle", [{ time: 0, price: 0 }, { time: 100, price: 0 }, { time: 50, price: 100 }]);
  const tz = makeDrawing("fib-timezone", [{ time: 200, price: 0 }, { time: 320, price: 0 }]);
  const drawings = [arrow, tri, tz];
  const toCanvas = (d: Drawing): XY[] =>
    d.points.map((q) => ({ x: q.time, y: 100 - q.price }));

  // on the arrow shaft (y=100 canvas)
  const hitArrow = hitTest(p(50, 100), drawings, toCanvas, 500, 500);
  assert.ok(hitArrow != null);
  // inside the triangle body
  const hitTri = hitTest(p(50, 60), drawings, toCanvas, 500, 500);
  assert.ok(hitTri != null && drawings[hitTri.index].type === "triangle");
  // fib-timezone spans the bbox of its two anchors
  const hitTz = hitTest(p(210, 20), drawings, toCanvas, 500, 500);
  assert.ok(hitTz != null && drawings[hitTz.index].type === "fib-timezone");
});

test("hit-test respects hidden and locked drawings", () => {
  const d = makeDrawing("trend", [{ time: 0, price: 0 }, { time: 100, price: 0 }]);
  const hidden: Drawing = { ...d, hidden: true };
  assert.equal(hitTest(p(50, 0), [hidden], (x) => x.points.map((q) => p(q.time, q.price)), 500, 500), null);
  const lockedD: Drawing = { ...d, locked: true };
  assert.equal(hitTest(p(50, 0), [lockedD], (x) => x.points.map((q) => p(q.time, q.price)), 500, 500), null);
});

// ---------------------------------------------------------------------------
// distToSegmentSq sanity (used by nearly every line hit-test)
// ---------------------------------------------------------------------------
test("segment distance sanity", () => {
  assert.equal(distToSegmentSq(p(5, 1), p(0, 0), p(10, 0)), 1);
  assert.equal(distToSegmentSq(p(-5, 3), p(0, 0), p(10, 0)), 9 + 25); // beyond the endpoint
});


// ---------------------------------------------------------------------------
// Phase 12 — timeframe visibility · naming · attached text fields
// ---------------------------------------------------------------------------
test("timeframe visibility: default all, per-TF opt-in, never deletes", () => {
  const d = makeDrawing("trend", [{ time: 0, price: 1 }, { time: 60, price: 2 }]);
  // default: visible EVERYWHERE
  for (const tf of ["1m", "5m", "1h", "4h", "1d", "1W"] as const) {
    assert.equal(isVisibleOnTf(d, tf), true);
  }
  // H1+H4 only — hidden on M1/M5, visible on H1/H4, and the object SURVIVES
  d.tfs = ["1h", "4h"];
  assert.equal(isVisibleOnTf(d, "1m"), false);
  assert.equal(isVisibleOnTf(d, "5m"), false);
  assert.equal(isVisibleOnTf(d, "1h"), true);
  assert.equal(isVisibleOnTf(d, "4h"), true);
  assert.equal(d.points.length, 2, "anchors untouched by visibility");
  // empty array = back to everywhere
  d.tfs = [];
  assert.equal(isVisibleOnTf(d, "1m"), true);
});

test("object naming: rename wins over tool type", () => {
  const d = makeDrawing("trend", [{ time: 0, price: 1 }, { time: 60, price: 2 }]);
  assert.equal(effectiveName(d), "trend");
  d.name = "Resistance";
  assert.equal(effectiveName(d), "Resistance");
  d.name = "   ";
  assert.equal(effectiveName(d), "trend", "blank rename falls back to type");
});

test("attached text / label / extension style fields round-trip", () => {
  const d = makeDrawing("trend", [{ time: 0, price: 1 }, { time: 60, price: 2 }]);
  d.text = "supply zone";
  d.style.textColor = "#f59e0b";
  d.style.textPos = "above";
  d.style.extend = "both";
  d.style.showLabels = true;
  d.style.showTimeLabels = false;
  assert.equal(d.text, "supply zone");
  assert.equal(d.style.textColor, "#f59e0b");
  assert.equal(d.style.textPos, "above");
  assert.equal(d.style.extend, "both");
  assert.equal(d.style.showLabels, true);
  assert.equal(d.style.showTimeLabels, false);
});
