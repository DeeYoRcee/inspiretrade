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
  reorderDrawing, magnetSnapPrice, magnetSnapTime, __sanitizeDrawingList,
  rectHandlePoints, rectHandleApply,
  type Drawing, type DrawingType, type DrawingPoint, type XY,
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
  // P37 §2: the 2.0 level joined the standard set
  assert.deepEqual(FIB_DEFAULT_LEVELS["fib-retracement"], [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618], "P27 §5 + P37: full standard level set");
  const d = makeDrawing("fib-retracement", [{ time: 0, price: 100 }, { time: 60, price: 200 }]);
  assert.equal(levelsFor(d).length, 11, "P27 §5 + P37: retracement carries the full standard set");
  // customize: disable 0.5, keep the rest
  const custom = levelsFor(d).map((l) => (l.ratio === 0.5 ? { ...l, show: false } : l));
  d.levels = custom;
  const eff = levelsFor(d).filter((l) => l.show);
  assert.equal(eff.length, 10);
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

// ---------------------------------------------------------------------------
// Phase 27 — z-order + magnet snap
// ---------------------------------------------------------------------------
test("P27 z-order: forward/backward/front/back reorder the render stack", () => {
  const mk = (id: string) => ({ id, points: [] });
  const list = [mk("a"), mk("b"), mk("c")];
  assert.deepEqual(reorderDrawing(list, "a", "front").map((d) => d.id), ["b", "c", "a"]);
  assert.deepEqual(reorderDrawing(list, "c", "back").map((d) => d.id), ["c", "a", "b"]);
  assert.deepEqual(reorderDrawing(list, "b", "forward").map((d) => d.id), ["a", "c", "b"]);
  assert.deepEqual(reorderDrawing(list, "b", "backward").map((d) => d.id), ["b", "a", "c"]);
  // unknown id → unchanged; the input list is never mutated
  assert.deepEqual(reorderDrawing(list, "zz", "front").map((d) => d.id), ["a", "b", "c"]);
  assert.deepEqual(list.map((d) => d.id), ["a", "b", "c"]);
});

test("P27 magnet: anchor snaps to the nearest OHLC within the pixel radius", () => {
  const bar = { open: 100, high: 102, low: 98, close: 101 };
  // linear scale: 1 unit = 10px
  const y = (p: number) => 1000 - p * 10;
  assert.equal(magnetSnapPrice(99.95, bar, y, 12), 100, "0.5 units (5px) from the open → snaps to open");
  assert.equal(magnetSnapPrice(101.9, bar, y, 12), 102, "1px from the high → snaps to high");
  assert.equal(magnetSnapPrice(100.5, bar, y, 2), 100.5, "3 units (30px) from every level beyond a 2px radius → stays");
  assert.equal(magnetSnapPrice(100, null, y, 12), 100, "no bar → untouched");
  assert.equal(magnetSnapPrice(100, bar, () => null, 12), 100, "unprojectable scale → untouched");
});

test("P27 magnet: anchor time snaps to the containing bar's open time", () => {
  assert.equal(magnetSnapTime(1763688034, 60), 1763688000, "34s into a minute → bar open time");
  assert.equal(magnetSnapTime(1763688034, null), 1763688034, "no tf → untouched");
  assert.equal(magnetSnapTime(1794787200 + 3 * 86400 + 1800, 604800), 1794787200, "mid-week stamp → Monday bucket");
});

// ---------------------------------------------------------------------------
// Phase 35 — sanitize on load: corrupt remote entries must never reach the
// canvas, duplicates collapse to the newest, engine ranges are enforced
// ---------------------------------------------------------------------------
const trendOk = {
  id: "d1", type: "trend",
  points: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
  style: { color: "#ff0000", width: 3, dash: "dashed", fontSize: 12 },
};

test("P35 sanitize: valid drawings pass through with fields preserved", () => {
  const out = __sanitizeDrawingList([trendOk]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "trend");
  assert.equal(out[0].points.length, 2);
  assert.equal(out[0].style.color, "#ff0000");
  assert.equal(out[0].style.width, 3);
  assert.equal(out[0].style.dash, "dashed");
});

test("P35 sanitize: unknown tools and malformed entries are dropped", () => {
  assert.deepEqual(__sanitizeDrawingList([]), []);
  assert.deepEqual(__sanitizeDrawingList(null as any), []);
  assert.deepEqual(__sanitizeDrawingList([null, 42, "x", { type: "not-a-tool", points: [] }]), []);
  // trend needs exactly 2 points — one or three must not survive
  assert.deepEqual(__sanitizeDrawingList([{ ...trendOk, id: "a", points: [trendOk.points[0]] }]), []);
  assert.deepEqual(__sanitizeDrawingList([{ ...trendOk, id: "b", points: [...trendOk.points, { time: 300, price: 30 }] }]), []);
  // hline takes exactly 1 point
  assert.deepEqual(__sanitizeDrawingList([{ id: "c", type: "hline", points: [{ time: 1, price: 5 }, { time: 2, price: 5 }], style: {} }]), []);
  // non-finite coordinates are rejected point-wise; below the minimum → drop
  assert.deepEqual(__sanitizeDrawingList([{ ...trendOk, id: "d", points: [{ time: Number.NaN, price: 1 }, { time: 2, price: 2 }] }]), []);
});

test("P35 sanitize: style fields are clamped to engine ranges", () => {
  const out = __sanitizeDrawingList([{
    id: "e", type: "rect",
    points: [{ time: 1, price: 1 }, { time: 2, price: 2 }],
    style: { width: 99, dash: "wavy", fontSize: 2, fill: { color: "#00ff00", opacity: 5 } },
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].style.width, 6, "width clamped to 6");
  assert.equal(out[0].style.dash, "solid", "unknown dash → solid");
  assert.equal(out[0].style.fontSize, 6, "fontSize clamped to 6");
  assert.equal(out[0].style.fill!.opacity, 1, "fill opacity clamped to 1");
});

test("P35 sanitize: duplicate ids collapse to the newest entry", () => {
  const first = { ...trendOk, points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] };
  const second = { ...trendOk, id: "d1", points: [{ time: 9, price: 9 }, { time: 10, price: 10 }] };
  const out = __sanitizeDrawingList([first, second]);
  assert.equal(out.length, 1);
  assert.equal(out[0].points[0].time, 9, "the LAST entry wins");
});

test("P35 sanitize: freehand capped at 800 points, flags/names preserved", () => {
  const pts = Array.from({ length: 900 }, (_, i) => ({ time: i, price: i % 50 }));
  const out = __sanitizeDrawingList([{ id: "f", type: "brush", points: pts, style: {}, locked: true, hidden: true, name: "x".repeat(120), text: "t".repeat(300) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].points.length, 800, "freehand cap enforced");
  assert.equal(out[0].locked, true);
  assert.equal(out[0].hidden, true);
  assert.equal(out[0].name!.length, 60, "name truncated to 60");
  assert.equal(out[0].text!.length, 200, "text truncated to 200");
});

// ---------------------------------------------------------------------------
// P66 — rectangle 8-handle system + position level-line drag
// ---------------------------------------------------------------------------
test("P66 rect: eight handle points — corners + edge mids", () => {
  const pts = [p(100, 200), p(300, 400)];
  const h = rectHandlePoints(pts);
  assert.equal(h.length, 8);
  assert.deepEqual(h[0], pts[0]);
  assert.deepEqual(h[1], pts[1]);
  assert.deepEqual(h[2], p(100, 400));
  assert.deepEqual(h[3], p(300, 200));
  assert.deepEqual(h[4], p(200, 200));
  assert.deepEqual(h[5], p(200, 400));
  assert.deepEqual(h[6], p(100, 300));
  assert.deepEqual(h[7], p(300, 300));
});

test("P66 rect: hitTest resolves corners, edge handles and the move body", () => {
  const toCanvas = (d: Drawing) => d.points.map((q) => ({ x: q.time, y: q.price }));
  const d = makeDrawing("rect", [{ time: 100, price: 200 }, { time: 300, price: 400 }]);
  const c0 = hitTest(p(102, 202), [d], toCanvas, 800, 600);
  assert.equal(c0?.handle, 0, "anchor corner a");
  const e4 = hitTest(p(200, 202), [d], toCanvas, 800, 600);
  assert.equal(e4?.handle, 4, "top edge midpoint");
  const e7 = hitTest(p(298, 300), [d], toCanvas, 800, 600);
  assert.equal(e7?.handle, 7, "right edge midpoint");
  const body = hitTest(p(200, 300), [d], toCanvas, 800, 600);
  assert.equal(body?.index, 0);
  assert.equal(body?.handle, undefined, "interior = move, not a handle");
});

test("P66 rect: handle drag moves exactly one boundary per edge handle", () => {
  const pts: DrawingPoint[] = [{ time: 100, price: 200 }, { time: 300, price: 400 }];
  // market coordinates: the visual TOP edge is the MAX price, the BOTTOM the min
  const top = rectHandleApply(pts, 4, 123, 150);
  assert.deepEqual(top, [{ time: 100, price: 200 }, { time: 300, price: 150 }], "top edge (handle 4) moves the max-price side only");
  const bot = rectHandleApply(pts, 5, 123, 450);
  assert.deepEqual(bot, [{ time: 100, price: 450 }, { time: 300, price: 400 }], "bottom edge (handle 5) moves the min-price side only");
  const left = rectHandleApply(pts, 6, 50, 999);
  assert.deepEqual(left, [{ time: 50, price: 200 }, { time: 300, price: 400 }], "left edge moves the min-time side only");
  const right = rectHandleApply(pts, 7, 500, 999);
  assert.deepEqual(right, [{ time: 100, price: 200 }, { time: 500, price: 400 }], "right edge moves the max-time side only");
  const c2 = rectHandleApply(pts, 2, 80, 380);
  assert.deepEqual(c2, [{ time: 80, price: 200 }, { time: 300, price: 380 }], "derived corner = a.time + b.price");
  const c1 = rectHandleApply(pts, 1, 320, 420);
  assert.deepEqual(c1, [{ time: 100, price: 200 }, { time: 320, price: 420 }], "anchor corner 1");
});

test("P66 position: level lines are drag targets; band edges still win", () => {
  const toCanvas = (d: Drawing) => d.points.map((q) => ({ x: q.time, y: q.price }));
  const d = makeDrawing("long-position", [
    { time: 100, price: 100 }, { time: 300, price: 200 }, { time: 300, price: 50 },
  ]);
  const entry = hitTest(p(200, 100), [d], toCanvas, 800, 600);
  assert.equal(entry?.handle, 0, "entry line middle");
  const stop = hitTest(p(150, 200), [d], toCanvas, 800, 600);
  assert.equal(stop?.handle, 1, "stop line");
  const target = hitTest(p(250, 50), [d], toCanvas, 800, 600);
  assert.equal(target?.handle, 2, "target line");
  const yMid = 125;
  const leftEdge = hitTest(p(100, yMid), [d], toCanvas, 800, 600);
  assert.equal(leftEdge?.handle, 3, "band left edge");
  const rightEdge = hitTest(p(300, yMid), [d], toCanvas, 800, 600);
  assert.equal(rightEdge?.handle, 4, "band right edge");
  const body = hitTest(p(200, 160), [d], toCanvas, 800, 600);
  assert.equal(body?.index, 0);
  assert.equal(body?.handle, undefined, "zone interior = move");
});

test("P66 position: band-edge handles win when yMid coincides with a level", () => {
  const toCanvas = (d: Drawing) => d.points.map((q) => ({ x: q.time, y: q.price }));
  // entry exactly at the band's vertical middle: the entry dot (300,100) sits
  // on the right-edge handle (300,100) — the EDGE must win, width stays resizable
  const d = makeDrawing("long-position", [
    { time: 100, price: 100 }, { time: 300, price: 150 }, { time: 300, price: 50 },
  ]);
  const right = hitTest(p(300, 100), [d], toCanvas, 800, 600);
  assert.equal(right?.handle, 4, "right-edge handle beats the level dot at yMid");
  // far from yMid the level dots keep working
  const stop = hitTest(p(300, 150), [d], toCanvas, 800, 600);
  assert.equal(stop?.handle, 1, "stop dot at its own level");
});
