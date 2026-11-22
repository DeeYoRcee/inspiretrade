/**
 * Phase 36 — new indicator math (Momentum, StdDev, BB Width, source prices),
 * catalog sanitization and library metadata tests.
 * Run: node --test tests/phase36-indicators.test.ts
 *
 * Expected values are hand-computed references (or independent cross-checks
 * against other pure functions), not the implementation's own output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bollinger, bollingerWidth, momentum, stdev, sourceSeries, sma, type BarLike,
} from "../client/src/lib/indicators.ts";
import {
  INDICATOR_CATALOG, INDICATOR_CATEGORY_ORDER, sanitizeIndicatorList, sanitizeParams,
  sanitizeStyle, withAlpha, type IndicatorConfig,
} from "../client/src/lib/indicators-config.ts";

// close: 3, 5, 8, 2, 9 — hand-reference for MOM(period 2):
// [null, null, 8-5=3, 2-8=-6? → uses closes[i]-closes[i-2]: idx2: 8-5? no: closes[2]-closes[0]=5, idx3: 2-5=-3, idx4: 9-8=1]
const CLOSES = [3, 5, 8, 2, 9];

test("P36 momentum: hand-computed reference (period 2)", () => {
  const out = momentum(CLOSES, 2);
  assert.deepEqual(out, [null, null, 5, -3, 1], "MOM[i] = close[i] − close[i−2]");
});

test("P36 momentum: period ≥ length → all null", () => {
  assert.deepEqual(momentum([1, 2, 3], 3), [null, null, null]);
});

test("P36 stdev: hand-computed rolling population stddev (period 3)", () => {
  const v = [2, 4, 6, 12];
  const out = stdev(v, 3);
  // window [2,4,6]: mean 4, var ((−2)²+0²+2²)/3 = 8/3 → sd 1.632993…
  assert.equal(out[2], Math.sqrt(8 / 3));
  // window [4,6,12]: mean 22/3, var ((4−22/3)²+(6−22/3)²+(12−22/3)²)/3
  const m = 22 / 3;
  const expect = Math.sqrt((((4 - m) ** 2 + (6 - m) ** 2 + (12 - m) ** 2) / 3));
  assert.equal(out[3], expect);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
});

test("P36 bbw: cross-checked against bollinger (independent reference)", () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 7 + i * 0.2);
  const r = bollinger(v, 20, 2);
  const w = bollingerWidth(v, 20, 2);
  for (let i = 19; i < v.length; i++) {
    const expect = ((r.upper[i]! - r.lower[i]!) / r.basis[i]!) * 100;
    assert.equal(w[i], expect, `BBW[${i}] equals (upper−lower)/basis×100`);
  }
  for (let i = 0; i < 19; i++) assert.equal(w[i], null, "warm-up is null");
});

test("P36 sourceSeries: hl2/hlc3/ohlc4/close hand-check", () => {
  const bars: BarLike[] = [{ time: 1, open: 10, high: 20, low: 6, close: 14 }];
  assert.equal(sourceSeries(bars, "close")[0], 14);
  assert.equal(sourceSeries(bars, "open")[0], 10);
  assert.equal(sourceSeries(bars, "high")[0], 20);
  assert.equal(sourceSeries(bars, "low")[0], 6);
  assert.equal(sourceSeries(bars, "hl2")[0], 13);        // (20+6)/2
  assert.equal(sourceSeries(bars, "hlc3")[0], 40 / 3);   // (20+6+14)/3
  assert.equal(sourceSeries(bars, "ohlc4")[0], 12.5);    // (10+20+6+14)/4
  assert.equal(sourceSeries(bars, "garbage")[0], 14, "unknown source falls back to close");
});

test("P36 source param flows through SMA dispatch-compatible math", () => {
  const bars: BarLike[] = [
    { time: 1, open: 10, high: 12, low: 8, close: 11 },
    { time: 2, open: 20, high: 22, low: 18, close: 21 },
  ];
  const smaOpen = sma(sourceSeries(bars, "open"), 2);
  assert.equal(smaOpen[1], 15); // (10+20)/2
});

test("P36 catalog: the full Phase 36 spec list exists with categories", () => {
  const spec: Array<[string, string]> = [
    ["sma", "trend"], ["ema", "trend"], ["wma", "trend"], ["bb", "trend"], ["psar", "trend"],
    ["ichimoku", "trend"], ["supertrend", "trend"], ["vwap", "trend"],
    ["rsi", "momentum"], ["macd", "momentum"], ["stoch", "momentum"], ["cci", "momentum"],
    ["momentum", "momentum"], ["willr", "momentum"], ["roc", "momentum"],
    ["atr", "volatility"], ["bbw", "volatility"], ["stddev", "volatility"], ["keltner", "volatility"],
    ["volume", "volume"], ["obv", "volume"], ["mfi", "volume"],
  ];
  for (const [type, category] of spec) {
    const meta = INDICATOR_CATALOG[type as keyof typeof INDICATOR_CATALOG];
    assert.ok(meta, `${type} missing from catalog`);
    assert.equal(meta.category, category, `${type} category`);
    assert.ok(meta.description.length > 20, `${type} has a description`);
  }
  assert.deepEqual(INDICATOR_CATEGORY_ORDER, ["trend", "momentum", "volatility", "volume"]);
});

test("P36 catalog: source select param validated by sanitizeParams", () => {
  const out = sanitizeParams("ema", { period: 30, source: "hlc3", color: "#112233" });
  assert.equal(out.source, "hlc3");
  const bad = sanitizeParams("ema", { source: "median" });
  assert.equal(bad.source, "close", "invalid source → default");
  const clamped = sanitizeParams("ema", { period: 999 });
  assert.equal(clamped.period, 500);
});

test("P36 sanitizeIndicatorList: unknown types dropped, params clamped, dup ids collapsed", () => {
  const raw = [
    { id: "a", type: "rsi", visible: true, params: { period: 9999 } },
    { id: "a", type: "macd", params: { fast: 12, slow: 26, signal: 9 } }, // duplicate id → first wins
    { id: "b", type: "not-an-indicator", params: {} },
    null,
    { id: "c", type: "bbw", params: { period: 2, mult: 99 } },
    { id: "d", type: "sma", params: { period: 10, source: "hl2" }, style: { width: 99, dash: "zigzag", opacity: 4 } },
  ];
  const out = sanitizeIndicatorList(raw);
  assert.equal(out.length, 3);
  assert.equal(out[0].type, "rsi");
  assert.equal(out[0].params.period, 100, "period clamped to catalog max");
  assert.equal(out[1].type, "bbw", "duplicate id 'a' dropped — macd never survives");
  assert.equal(out[1].params.mult, 6, "mult clamped");
  assert.equal(out[1].params.period, 2);
  assert.equal(out[2].type, "sma");
  assert.equal(out[2].params.source, "hl2");
  assert.deepEqual(out[2].style, { width: 4, opacity: 1 }, "style normalized, bad dash dropped");
  assert.deepEqual(sanitizeIndicatorList("junk"), []);
});

test("P36 sanitizeIndicatorList: defaults fill empty params, visible defaults true", () => {
  const out = sanitizeIndicatorList([{ id: "x", type: "roc" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].visible, true);
  assert.equal(out[0].params.period, 9, "catalog defaults applied");
});

test("P36 sanitizeStyle + withAlpha: line style plumbing", () => {
  assert.deepEqual(sanitizeStyle({ width: 2.6, dash: "dashed", opacity: 0.5 }), { width: 3, dash: "dashed", opacity: 0.5 });
  assert.equal(sanitizeStyle(null), undefined);
  assert.equal(sanitizeStyle({}), undefined, "empty style → undefined");
  assert.equal(withAlpha("#a78bfa", 0.5), "#a78bfa80");
  assert.equal(withAlpha("#a78bfa"), "#a78bfa", "no opacity → unchanged");
  assert.equal(withAlpha("#a78bfa", 1), "#a78bfa", "opacity 1 → unchanged");
  assert.equal(withAlpha("rgb(1,2,3)", 0.5), "rgb(1,2,3)", "non-hex untouched");
});

test("P36 alignment: momentum/stdev/bbw are 1:1 with input length", () => {
  const v = Array.from({ length: 137 }, (_, i) => 50 + Math.cos(i / 5) * 10);
  assert.equal(momentum(v, 14).length, 137);
  assert.equal(stdev(v, 20).length, 137);
  assert.equal(bollingerWidth(v, 20, 2).length, 137);
});

test("P36 config: multiple instances keep independent ids and params", () => {
  const a: IndicatorConfig = { id: "i1", type: "ema", visible: true, params: { period: 9, source: "close", color: "#fff000" } };
  const b: IndicatorConfig = { id: "i2", type: "ema", visible: true, params: { period: 21, source: "close", color: "#fff000" } };
  const list = sanitizeIndicatorList([a, b]);
  assert.equal(list.length, 2, "same type twice is allowed — ids differ");
  assert.notEqual(list[0].params.period, list[1].params.period);
});
