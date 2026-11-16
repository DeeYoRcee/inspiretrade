/**
 * Chart library tests — indicator math + drawing geometry.
 * Run: node --test tests/chart-libs.test.ts (also picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sma, ema, rsi, macd, bollinger, atr, vwap, stochastic, type BarLike,
} from "../client/src/lib/indicators.ts";
import {
  distToSegmentSq, rayToEdge, channelOffset, pointInRect, hitTest, makeDrawing,
  TOOL_POINT_COUNT, FIB_RETRACEMENT_LEVELS, textBounds,
  type Drawing, type XY,
} from "../client/src/lib/drawings.ts";

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

test("sma: rolling mean with warm-up nulls", () => {
  const v = [1, 2, 3, 4, 5];
  const out = sma(v, 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2);
  assert.equal(out[4], 4);
});

test("ema: seeds with SMA then recurses", () => {
  const v = [1, 2, 3, 4];
  const out = ema(v, 3);
  assert.equal(out[0], null);
  assert.equal(out[2], 2);          // SMA seed
  const k = 2 / 4;
  assert.equal(Math.abs(out[3] - (4 * k + 2 * (1 - k))) < 1e-12, true);
});

test("rsi: monotonic gains → 100, monotonic losses → 0, mixed within (0,100)", () => {
  const up = [1, 2, 3, 4, 5, 6];
  const rUp = rsi(up, 3);
  assert.equal(rUp[3], 100);
  const down = [6, 5, 4, 3, 2, 1];
  assert.equal(rsi(down, 3)[3], 0);
  const mixed = [1, 3, 2, 4, 3, 5];
  const r = rsi(mixed, 3);
  for (let i = 3; i < r.length; i++) {
    assert.ok(r[i]! > 0 && r[i]! < 100);
  }
  assert.deepEqual(rsi(up, 3).slice(0, 3), [null, null, null]);
});

test("macd: line = emaFast − emaSlow; signal lags; hist = macd − signal", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 6) * 5);
  const r = macd(closes, 12, 26, 9);
  assert.equal(r.macd[25] != null, true);
  assert.equal(r.macd[24], null); // slow EMA warm-up
  for (let i = 0; i < closes.length; i++) {
    if (r.signal[i] != null) assert.equal(Math.abs((r.macd[i]! - r.signal[i]!) - r.hist[i]!) < 1e-10, true);
  }
  // signal can never precede the macd line
  for (let i = 0; i < closes.length; i++) {
    if (r.signal[i] != null) assert.equal(r.macd[i] != null, true);
  }
});

test("bollinger: upper = basis + mult·sd, lower = basis − mult·sd", () => {
  const v = [10, 12, 11, 13, 12, 14, 13, 15];
  const r = bollinger(v, 5, 2);
  assert.equal(r.basis[4], 11.6);
  const seg = v.slice(0, 5);
  const mean = seg.reduce((a, b) => a + b, 0) / 5;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - mean) ** 2, 0) / 5);
  assert.equal(Math.abs(r.upper[4]! - (mean + 2 * sd)) < 1e-12, true);
  assert.equal(Math.abs(r.lower[4]! - (mean - 2 * sd)) < 1e-12, true);
});

test("atr: equals TR for constant ranges, Wilder smoothing afterwards", () => {
  const bars: BarLike[] = [];
  for (let i = 0; i < 20; i++) bars.push({ time: i * 60, open: 10, high: 12, low: 8, close: 11 });
  const out = atr(bars, 14);
  assert.equal(out[13], null);
  assert.equal(Math.abs(out[14]! - 4) < 1e-9, true); // TR = 4 every bar
  assert.equal(Math.abs(out[15]! - 4) < 1e-9, true);
});

test("vwap: session reset at UTC midnight, zero-volume bars carry last value", () => {
  const bars: BarLike[] = [
    { time: 86_300, open: 1, high: 2, low: 1, close: 2, volume: 10 },   // day 0
    { time: 86_400 + 60, open: 1, high: 2, low: 1, close: 2, volume: 30 }, // day 1 → reset
    { time: 86_400 + 120, open: 1, high: 2, low: 1, close: 2, volume: 0 }, // no volume → carry
  ];
  const { vwap: out } = vwap(bars);
  // typical price = (high+low+close)/3 = 5/3 for every bar here
  assert.equal(Math.abs(out[0]! - 5 / 3) < 1e-12, true);
  assert.equal(Math.abs(out[1]! - 5 / 3) < 1e-12, true);        // reset but same typical
  assert.equal(out[2], out[1]);                                  // zero-volume carry
});

test("stochastic: k in [0,100], d = sma(k) with warm-up", () => {
  const bars: BarLike[] = Array.from({ length: 30 }, (_, i) => ({
    time: i * 60, open: 1, high: i + 2, low: i, close: i + 1,
  }));
  const r = stochastic(bars, 14, 3);
  for (let i = 13; i < 30; i++) assert.ok(r.k[i]! >= 0 && r.k[i]! <= 100);
  // monotonic rising bars: hh = i+2, ll = i−13, close = i+1 → (i+1−(i−13))/(i+2−(i−13)) = 14/15
  assert.equal(Math.abs(r.k[29]! - (14 / 15) * 100) < 1e-9, true);
  assert.equal(r.d[14] != null, false); // d needs 3 k values: valid from index 15
  assert.equal(r.d[15] != null, true);
});

// ---------------------------------------------------------------------------
// drawings geometry
// ---------------------------------------------------------------------------

test("distToSegmentSq: exact geometry", () => {
  const d = distToSegmentSq({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(d, 25);
  // beyond the segment end clamps to the endpoint
  const d2 = distToSegmentSq({ x: 14, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(d2, 16);
  // zero-length segment behaves as a point
  const d3 = distToSegmentSq({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
  assert.equal(d3, 25);
});

test("rayToEdge: extends the direction until the canvas edge", () => {
  const r = rayToEdge({ x: 0, y: 0 }, { x: 10, y: 0 }, 100, 100);
  assert.equal(r.b.x, 100);
  assert.equal(r.b.y, 0);
  // 45° ray hits the corner
  const d = rayToEdge({ x: 0, y: 0 }, { x: 1, y: 1 }, 100, 100);
  assert.equal(Math.round(d.b.x), 100);
  assert.equal(Math.round(d.b.y), 100);
  // zero-length ray stays put
  const z = rayToEdge({ x: 1, y: 1 }, { x: 1, y: 1 }, 100, 100);
  assert.equal(z.b.x, 1);
});

test("channelOffset: parallel line through the third anchor's projection", () => {
  const a: XY = { x: 0, y: 0 };
  const b: XY = { x: 100, y: 0 };
  const c: XY = { x: 50, y: 30 };
  const off = channelOffset(a, b, c);
  assert.equal(off.from.y, 30);
  assert.equal(off.to.y, 30);
  assert.equal(off.from.x, 0);
  assert.equal(off.to.x, 100);
});

test("hitTest: handles win over bodies; each type hittable", () => {
  const trend = makeDrawing("trend", [{ time: 0, price: 0 }, { time: 10, price: 10 }]);
  const toCanvas = (d: Drawing): XY[] => d.points.map((p) => ({ x: p.time * 10, y: 100 - p.price * 10 }));
  // body midpoint (50,50) hits trend
  assert.equal(hitTest({ x: 50, y: 50 }, [trend], toCanvas, 800, 400)?.index, 0);
  // endpoint (0,100) hits the HANDLE (x=0,y=100 within 8px)
  const hit = hitTest({ x: 3, y: 97 }, [trend], toCanvas, 800, 400);
  assert.equal(hit?.handle, 0);
  // far away → miss
  assert.equal(hitTest({ x: 500, y: 30 }, [trend], toCanvas, 800, 400), null);
  // top-most wins on overlap
  const second = makeDrawing("hline", [{ time: 0, price: 5 }]);
  const hit2 = hitTest({ x: 50, y: 50 }, [trend, second], toCanvas, 800, 400);
  assert.equal(hit2?.index, 1);
});

test("hitTest: hline/vline/rect/text/fib types", () => {
  const toCanvas = (d: Drawing): XY[] => d.points.map((p) => ({ x: p.time * 10, y: 200 - p.price * 10 }));
  const hline = makeDrawing("hline", [{ time: 0, price: 10 }]);       // y=100
  assert.equal(hitTest({ x: 400, y: 102 }, [hline], toCanvas, 800, 400)?.index, 0);
  assert.equal(hitTest({ x: 400, y: 130 }, [hline], toCanvas, 800, 400), null);
  const vline = makeDrawing("vline", [{ time: 20, price: 0 }]);       // x=200
  assert.equal(hitTest({ x: 202, y: 300 }, [vline], toCanvas, 800, 400)?.index, 0);
  const rect = makeDrawing("rect", [{ time: 0, price: 10 }, { time: 20, price: 20 }]);
  assert.equal(hitTest({ x: 100, y: 50 }, [rect], toCanvas, 800, 400)?.index, 0); // inside
  assert.equal(hitTest({ x: 100, y: 50 }, [rect], toCanvas, 800, 400)?.handle, undefined);
  const text = makeDrawing("text", [{ time: 5, price: 5 }], "hello");
  const tb = textBounds("hello", 12, { x: 50, y: 150 });
  assert.equal(hitTest({ x: tb.x + 5, y: tb.y + tb.h / 2 }, [text], toCanvas, 800, 400)?.index, 0);
  // locked drawings are skipped
  const locked = { ...hline, locked: true };
  assert.equal(hitTest({ x: 400, y: 102 }, [locked], toCanvas, 800, 400), null);
});

test("fib levels + tool point counts are consistent", () => {
  assert.deepEqual(FIB_RETRACEMENT_LEVELS, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  assert.equal(TOOL_POINT_COUNT["fib-extension"], 3);
  assert.equal(TOOL_POINT_COUNT.channel, 3);
  assert.equal(TOOL_POINT_COUNT.hline, 1);
  assert.equal(TOOL_POINT_COUNT["fib-retracement"], 2);
  assert.equal(TOOL_POINT_COUNT.text, 1);
});
