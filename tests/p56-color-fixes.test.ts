/**
 * P56 fix round — drawing color pipeline regression tests.
 * Run: node --test tests/p56-color-fixes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUndefinedRtdb } from "../client/src/lib/drawings.ts";
import fs from "node:fs";

test("P56: stripUndefinedRtdb removes explicit undefined keys (RTDB payload safety)", () => {
  const drawing = {
    id: "d1", type: "trend", points: [{ time: 1, price: 1 }],
    style: { color: "#ff0000", width: 2, dash: "solid", fontSize: 12, fill: undefined, profitColor: undefined },
    riskPct: undefined,
  };
  const clean = stripUndefinedRtdb(drawing) as typeof drawing;
  assert.equal("fill" in clean.style, false);
  assert.equal("profitColor" in clean.style, false);
  assert.equal("riskPct" in clean, false);
  assert.equal(clean.style.color, "#ff0000"); // real values untouched
  // nested arrays/objects survive
  const nested = stripUndefinedRtdb({ a: { b: [{ c: undefined, d: 1 }] } });
  assert.deepEqual(nested, { a: { b: [{ d: 1 }] } });
});

test("P56: ColorPicker hex contract — source keeps the strict 3/6-digit normalizer", () => {
  const src = fs.readFileSync("client/src/components/terminal/chart/ColorPicker.tsx", "utf8");
  assert.match(src, /HEX_RE = .*6}.*3}/); // 6-or-3 digit contract preserved
  assert.match(src, /const native = .*#2962ff/); // crash-proof native input fallback
  assert.match(src, /const safe = typeof value === "string" && value \? value : "#2962ff"/);
});
