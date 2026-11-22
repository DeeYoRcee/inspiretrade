/**
 * PHASE 47 — Trading Alerts core tests (pure math, no Firebase).
 * Covers: price/dailyHL evaluators, the trigger gate (once / once-per-bar /
 * once-per-bar-close / repeat+cooldown / pause / expiration), REAL indicator
 * evaluations (RSI, MACD, EMA cross, Bollinger, ATR), drawing-based levels
 * (hline, trend interpolation, fib via fibLevelPrice, position levels),
 * cross-detection semantics and record sanitization.
 * Run: node --test tests/p47-alerts.test.ts (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePriceAlert, evaluateIndicatorAlert, evaluateDrawingAlert,
  drawingLevel, triggerGate, sanitizeAlert, blankAlert, alertDrawingMissing,
  type TradingAlert,
} from "../client/src/lib/alerts-core.ts";
import type { Drawing } from "../client/src/lib/drawings.ts";
import { ema as emaOf, macd as macdOf } from "../client/src/lib/indicators.ts";

const mkAlert = (over: Partial<TradingAlert>): TradingAlert => ({
  id: "t1", symbol: "XAUUSD", timeframe: "5m", kind: "price", paused: false,
  createdAt: 0, direction: "above", price: 3000, frequency: "repeat", cooldownMin: 60,
  ...over,
});

// ---- price evaluators --------------------------------------------------------

test("price alert fires above/below the target (server contract fields)", () => {
  const above = mkAlert({ direction: "above", price: 3000 });
  assert.equal(evaluatePriceAlert(above, 2999).hit, false);
  assert.equal(evaluatePriceAlert(above, 3000).hit, true);
  const below = mkAlert({ direction: "below", price: 2800 });
  assert.equal(evaluatePriceAlert(below, 2801).hit, false);
  assert.equal(evaluatePriceAlert(below, 2800).hit, true);
});

test("dailyHL uses the same direction contract", () => {
  const a = mkAlert({ kind: "dailyHL", direction: "above", price: 2950 });
  assert.equal(evaluatePriceAlert(a, 2949).hit, false);
  assert.equal(evaluatePriceAlert(a, 2950.1).hit, true);
});

// ---- trigger gate ------------------------------------------------------------

test("gate: repeat mode respects the cooldown", () => {
  const a = mkAlert({ frequency: "repeat", cooldownMin: 60, lastTriggeredAt: 1_000_000 });
  assert.equal(triggerGate({ a, now: 1_000_000 + 59 * 60000 }).allowed, false, "inside cooldown");
  assert.equal(triggerGate({ a, now: 1_000_000 + 61 * 60000 }).allowed, true, "after cooldown");
});

test("gate: once fires exactly once", () => {
  const fresh = mkAlert({ frequency: "once" });
  assert.equal(triggerGate({ a: fresh }).allowed, true);
  // after the fire the engine writes lastTriggeredAt — the same record no
  // longer passes the gate (client AND server read this state)
  const fired = mkAlert({ frequency: "once", lastTriggeredAt: Date.now() });
  assert.equal(triggerGate({ a: fired }).allowed, false);
});

test("gate: once-per-bar dedups by bar open time", () => {
  const a = mkAlert({ frequency: "oncePerBar", lastBarTime: 1700 });
  assert.equal(triggerGate({ a, barTime: 1700 }).allowed, false);
  assert.equal(triggerGate({ a, barTime: 1800 }).allowed, true);
});

test("gate: once-per-bar-close only fires on a CLOSED bar", () => {
  const a = mkAlert({ frequency: "oncePerBarClose", lastBarTime: 1700 });
  assert.equal(triggerGate({ a, barTime: 1800, barClose: false }).allowed, false);
  assert.equal(triggerGate({ a, barTime: 1800, barClose: true }).allowed, true);
});

test("gate: paused, done and expired alerts never fire", () => {
  assert.equal(triggerGate({ a: mkAlert({ paused: true }) }).allowed, false);
  assert.equal(triggerGate({ a: mkAlert({ done: true }) }).allowed, false);
  const expired = mkAlert({ expiresAt: 5 });
  assert.equal(triggerGate({ a: expired, now: 10 }).allowed, false);
  assert.equal(triggerGate({ a: expired, now: 4 }).allowed, true);
});

// ---- indicator evaluators (REAL math on synthetic OHLC) ----------------------

function series(n: number, fn: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i);
    return { time: i * 60, open: close, high: close + 1, low: close - 1, close, volume: 10 };
  });
}

test("RSI overbought fires only past the threshold (real RSI math)", () => {
  // monotonic rally drives RSI to 100
  const rally = series(30, (i) => 100 + i);
  const a = mkAlert({ kind: "indicator", indicator: { ind: "rsi", dir: "above", value: 70, period: 14 } });
  assert.equal(evaluateIndicatorAlert(a, rally)?.hit, true);
  assert.match(evaluateIndicatorAlert(a, rally)!.detail, /RSI\(14\)/);
  // oversold threshold never hit on a rally
  const oversold = mkAlert({ kind: "indicator", indicator: { ind: "rsi", dir: "below", value: 30, period: 14 } });
  assert.equal(evaluateIndicatorAlert(oversold, rally)?.hit, false);
});

test("MACD bullish crossover requires a sign flip of the histogram", () => {
  // build a swing, then cut the series EXACTLY at the histogram flip so the
  // last two values straddle the crossover (the evaluator fires on flips)
  const swing = series(90, (i) => (i < 45 ? 300 - i * 3 : 165 + (i - 45) * 4));
  const { macd, signal } = macdOf(swing.map((b) => b.close), 12, 26, 9);
  let flip = -1;
  for (let i = 1; i < swing.length; i++) {
    const d0 = (macd[i - 1] ?? 0) - (signal[i - 1] ?? 0);
    const d1 = (macd[i] ?? 0) - (signal[i] ?? 0);
    if (d0 <= 0 && d1 > 0) flip = i;
  }
  assert.ok(flip > 0, "the swing must produce a bullish flip");
  const bull = mkAlert({ kind: "indicator", indicator: { ind: "macd", dir: "bullish" } });
  const bear = mkAlert({ kind: "indicator", indicator: { ind: "macd", dir: "bearish" } });
  assert.equal(evaluateIndicatorAlert(bull, swing.slice(0, flip + 1))?.hit, true, "flip at the tail → fires");
  assert.equal(evaluateIndicatorAlert(bull, swing.slice(0, flip))?.hit, false, "before the flip → silent");
  assert.equal(evaluateIndicatorAlert(bear, swing.slice(0, flip + 1))?.hit, false);
});

test("EMA golden cross fires when fast crosses above slow", () => {
  const swing = series(80, (i) => (i < 40 ? 500 - i * 2 : 420 + (i - 40) * 3));
  const fast = emaOf(swing.map((b) => b.close), 5);
  const slow = emaOf(swing.map((b) => b.close), 20);
  let flip = -1;
  for (let i = 1; i < swing.length; i++) {
    const d0 = (fast[i - 1] ?? 0) - (slow[i - 1] ?? 0);
    const d1 = (fast[i] ?? 0) - (slow[i] ?? 0);
    if (d0 <= 0 && d1 > 0) flip = i;
  }
  assert.ok(flip > 0, "the swing must produce a golden cross");
  const a = mkAlert({ kind: "indicator", indicator: { ind: "emaCross", dir: "golden", period: 5, period2: 20 } });
  const death = mkAlert({ kind: "indicator", indicator: { ind: "emaCross", dir: "death", period: 5, period2: 20 } });
  assert.equal(evaluateIndicatorAlert(a, swing.slice(0, flip + 1))?.hit, true, "cross at the tail → fires");
  assert.equal(evaluateIndicatorAlert(a, swing.slice(0, flip))?.hit, false);
  assert.equal(evaluateIndicatorAlert(death, swing.slice(0, flip + 1))?.hit, false);
});

test("Bollinger band touch uses the real upper/lower envelope", () => {
  const flat = series(30, () => 100);
  const spike = flat.concat(series(1, () => 130));
  const upper = mkAlert({ kind: "indicator", indicator: { ind: "bb", dir: "upper", period: 20, value: 2 } });
  assert.equal(evaluateIndicatorAlert(upper, spike)?.hit, true);
  const lower = mkAlert({ kind: "indicator", indicator: { ind: "bb", dir: "lower", period: 20, value: 2 } });
  assert.equal(evaluateIndicatorAlert(lower, spike)?.hit, false);
});

test("ATR threshold fires on volatile series", () => {
  const volatile = series(30, (i) => (i % 2 === 0 ? 100 + (i * 7) % 29 : 100 - (i * 5) % 23));
  const big = mkAlert({ kind: "indicator", indicator: { ind: "atr", dir: "above", value: 5, period: 14 } });
  const small = mkAlert({ kind: "indicator", indicator: { ind: "atr", dir: "below", value: 0.0001, period: 14 } });
  assert.equal(evaluateIndicatorAlert(big, volatile)?.hit, true);
  assert.equal(evaluateIndicatorAlert(small, volatile)?.hit, false);
});

// ---- drawing-based alerts ----------------------------------------------------

const drawing = (over: Partial<Drawing>): Drawing => ({
  id: "d1", type: "hline", points: [{ time: 0, price: 3100 }], style: {},
  ...over,
} as Drawing);

test("hline level = the anchor price", () => {
  const d = drawing({});
  assert.equal(drawingLevel(d, { drawingId: "d1", target: "level", dir: "crossAbove" }, 0), 3100);
});

test("trend line level interpolates linearly along the two anchors", () => {
  const d = drawing({ type: "trend", points: [{ time: 0, price: 100 }, { time: 100, price: 200 }] });
  const cond = { drawingId: "d1", target: "level", dir: "crossAbove" } as const;
  assert.equal(drawingLevel(d, cond, 0), 100);
  assert.equal(drawingLevel(d, cond, 50), 150);
  assert.equal(drawingLevel(d, cond, 100), 200);
});

test("position levels map to Entry/SL/TP anchors", () => {
  const d = drawing({
    type: "long-position",
    points: [{ time: 0, price: 3000 }, { time: 0, price: 2950 }, { time: 0, price: 3100 }],
  });
  const base = { drawingId: "d1", dir: "crossAbove" } as const;
  assert.equal(drawingLevel(d, { ...base, target: "entry" }, 0), 3000);
  assert.equal(drawingLevel(d, { ...base, target: "sl" }, 0), 2950);
  assert.equal(drawingLevel(d, { ...base, target: "tp" }, 0), 3100);
});

test("fib level price uses the tool's real ratio math", () => {
  const d = drawing({ type: "fib-retracement", points: [{ time: 0, price: 100 }, { time: 10, price: 200 }], levels: [{ ratio: 0.618, show: true }] });
  const lvl = drawingLevel(d, { drawingId: "d1", target: "fib", fibIndex: 0, dir: "crossAbove" }, 0);
  // retracement measured p0→p1: 100 + (200-100)*0.618
  assert.ok(Math.abs((lvl ?? 0) - 161.8) < 1e-6, `got ${lvl}`);
});

test("drawing cross detection: first evaluation arms, then needs a real cross", () => {
  const d = drawing({});
  const a = mkAlert({ kind: "drawing", drawing: { drawingId: "d1", target: "level", dir: "crossAbove" } });
  const level = 3100;
  // first evaluation: price already above → armed, NOT fired
  assert.equal(evaluateDrawingAlert(a, d, 3200, null, 0)?.hit, false);
  // below → above: fires
  assert.equal(evaluateDrawingAlert(a, d, 3150, 3050, 0)?.hit, true);
  // already above → stays above: no new cross
  assert.equal(evaluateDrawingAlert(a, d, 3200, 3150, 0)?.hit, false);
  const belowA = mkAlert({ kind: "drawing", drawing: { drawingId: "d1", target: "level", dir: "crossBelow" } });
  assert.equal(evaluateDrawingAlert(belowA, d, 3050, 3200, 0)?.hit, true);
  assert.equal(evaluateDrawingAlert(belowA, d, 3000, 3050, 0)?.hit, false);
  void level;
});

test("a deleted drawing marks its alert missing (auto-pause path)", () => {
  const a = mkAlert({ kind: "drawing", drawing: { drawingId: "d1", target: "level", dir: "crossAbove" } });
  assert.equal(alertDrawingMissing(a, []), true);
  assert.equal(alertDrawingMissing(a, [drawing({})]), false);
  const priceAlert = mkAlert({});
  assert.equal(alertDrawingMissing(priceAlert, []), false, "price alerts never depend on drawings");
});

// ---- sanitization ------------------------------------------------------------

test("sanitizeAlert clamps and rejects broken records", () => {
  const good = sanitizeAlert(mkAlert({ cooldownMin: -5 }));
  assert.equal(good?.cooldownMin, 1, "cooldown clamped to >= 1");
  assert.equal(sanitizeAlert(mkAlert({ price: 0 })), null, "price alerts need a target");
  assert.equal(sanitizeAlert(mkAlert({ id: "" })), null);
  const dropped = sanitizeAlert(mkAlert({ createdAtLabel: "x" }));
  assert.ok(dropped && !("createdAtLabel" in dropped), "label stripped before storage");
  // a freshly blanked alert has price 0 — it must NOT be storable until a
  // target is set (the creation dialog enforces the same rule)
  const blank = blankAlert("BTCUSD", "1h");
  assert.equal(sanitizeAlert(blank), null, "blank needs a target price");
  assert.equal(sanitizeAlert({ ...blank, price: 3000 })?.symbol, "BTCUSD");
});
