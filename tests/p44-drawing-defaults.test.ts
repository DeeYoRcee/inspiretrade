/**
 * P44 §5 — per-tool drawing defaults: pure merge/sanitize/default-extract
 * logic (persistence lives in chart-persistence.ts and is exercised by the
 * app; this module must stay dependency-free).
 * Run: node --test tests/p44-drawing-defaults.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newDefaultFromStyle, sanitizeDefaultsMap, styleForTool,
} from "../client/src/lib/drawing-defaults.ts";
import type { DrawingStyle } from "../client/src/lib/drawings.ts";

const fallback = (): Partial<DrawingStyle> => ({ color: "#38bdf8", width: 2, dash: "solid", fontSize: 12 });

test("styleForTool — no entry falls back to the global defaults", () => {
  const style = styleForTool({}, "trend", fallback());
  assert.equal(style.color, "#38bdf8");
  assert.equal(style.width, 2);
  assert.equal(style.dash, "solid");
});

test("styleForTool — the tool default overlays the global fallback", () => {
  const style = styleForTool({ trend: { color: "#f23645", width: 3 } }, "trend", fallback());
  assert.equal(style.color, "#f23645");
  assert.equal(style.width, 3);
  assert.equal(style.dash, "solid"); // untouched fallback field survives
});

test("styleForTool — cursor (null tool) never picks up a tool default", () => {
  const style = styleForTool({ trend: { color: "#f23645" } }, null, fallback());
  assert.equal(style.color, "#38bdf8");
});

test("styleForTool — other tools are unaffected by one tool's default", () => {
  const map = { trend: { color: "#f23645" } };
  assert.equal(styleForTool(map, "rect", fallback()).color, "#38bdf8");
  assert.equal(styleForTool(map, "fib-retracement", fallback()).color, "#38bdf8");
});

test("newDefaultFromStyle — keeps style fields, never invents content", () => {
  const d = newDefaultFromStyle({ ...fallback(), textColor: "#ffffff", textBg: "#0f172a", textAlign: "left" } as DrawingStyle);
  assert.equal(d.color, "#38bdf8");
  assert.equal(d.textColor, "#ffffff");
  assert.equal(d.textBg, "#0f172a");
  assert.ok(!("text" in d));
});

test("newDefaultFromStyle — fill object passes through", () => {
  const d = newDefaultFromStyle({ ...fallback(), fill: { color: "#f23645", opacity: 0.2 } } as DrawingStyle);
  assert.deepEqual(d.fill, { color: "#f23645", opacity: 0.2 });
});

test("sanitizeDefaultsMap — junk entries, savedAt and bad types are dropped", () => {
  const clean = sanitizeDefaultsMap({
    trend: { color: "#f23645", width: 2 },
    savedAt: 12345,
    bad: "not-an-object",
    junk: [1, 2, 3],
    empty: {},
    weird: { color: 42, unknown: "x" },      // number color → invalid
    partial: { color: "#22c55e", width: "2" }, // string width → invalid, color kept
    fillOk: { fill: { color: "#22c55e", opacity: 0.2 }, color: "#22c55e" },
    fillBad: { fill: "solid" },
  });
  assert.deepEqual(clean.trend, { color: "#f23645", width: 2 });
  assert.equal(clean.savedAt, undefined);
  assert.equal(clean.bad, undefined);
  assert.equal(clean.junk, undefined);
  assert.equal(clean.empty, undefined);
  assert.equal(clean.weird, undefined);
  assert.deepEqual(clean.partial, { color: "#22c55e" });
  assert.deepEqual(clean.fillOk, { color: "#22c55e", fill: { color: "#22c55e", opacity: 0.2 } });
  assert.equal(clean.fillBad, undefined);
});

test("sanitizeDefaultsMap — non-object raw values produce an empty map", () => {
  assert.deepEqual(sanitizeDefaultsMap(null), {});
  assert.deepEqual(sanitizeDefaultsMap("x"), {});
  assert.deepEqual(sanitizeDefaultsMap(42), {});
  assert.deepEqual(sanitizeDefaultsMap([1]), {});
});
