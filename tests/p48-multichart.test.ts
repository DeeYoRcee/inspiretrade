/**
 * PHASE 48 — multi-chart layout math + workspace preset sanitization tests.
 * Run: node --test tests/p48-multichart.test.ts (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUTS, LAYOUT_ORDER, dividers, gridStyle, normWeights, resizePair,
  pointerPct, pointerPctY,
} from "../client/src/lib/chart-layouts.ts";
import { sanitizePreset } from "../client/src/lib/workspace-schema.ts";

test("layouts declare the required panel counts and grid shapes", () => {
  for (const id of LAYOUT_ORDER) {
    const def = LAYOUTS[id];
    assert.equal(def.cells.length, def.panels, `${id}: one cell per panel`);
    for (const cell of def.cells) {
      assert.ok(cell.c < def.cols && cell.r < def.rows, `${id}: cell inside the grid`);
    }
  }
  assert.equal(LAYOUTS["1"].panels, 1);
  assert.equal(LAYOUTS["2h"].cols, 2);
  assert.equal(LAYOUTS["2v"].rows, 2);
  assert.equal(LAYOUTS["3"].cells[0].rs, 2, "three-chart: left panel spans both rows");
  assert.equal(LAYOUTS["4"].panels, 4);
  assert.equal(LAYOUTS["6"].cols, 3);
});

test("gridStyle produces fr templates from weights", () => {
  const style = gridStyle(LAYOUTS["4"], [3, 1], [2, 1]);
  assert.equal(style.gridTemplateColumns, "3fr 1fr");
  assert.equal(style.gridTemplateRows, "2fr 1fr");
  // missing/invalid weights fall back to equal split
  const eq = gridStyle(LAYOUTS["2h"], [NaN, 0, 999], undefined);
  assert.equal(eq.gridTemplateColumns, "1fr 1fr");
});

test("dividers: 2h has one vertical, 2v one horizontal, 1 none", () => {
  assert.equal(dividers(LAYOUTS["1"], [1], [1]).length, 0);
  const v = dividers(LAYOUTS["2h"], [1, 1], [1]);
  assert.equal(v.length, 1);
  assert.equal(v[0].id.startsWith("c"), true);
  assert.ok(Math.abs(v[0].left - 50) < 1e-6, "centered at 50% for equal weights");
  assert.ok(Math.abs(v[0].height - 100) < 1e-6);
  const h = dividers(LAYOUTS["2v"], [1], [1, 1]);
  assert.equal(h.length, 1);
  assert.ok(Math.abs(h[0].top - 50) < 1e-6);
});

test("dividers: 3-layout places the row divider only in the right column", () => {
  const segs = dividers(LAYOUTS["3"], [1, 1], [1, 1]);
  const horiz = segs.filter((s) => s.id.startsWith("r"));
  assert.equal(horiz.length, 1);
  assert.ok(Math.abs(horiz[0].left - 50) < 1e-6, "starts at the column boundary");
  assert.ok(Math.abs(horiz[0].width - 50) < 1e-6, "spans only the right column");
});

test("dividers: 4 gets one vertical and one horizontal spanning the grid", () => {
  const segs = dividers(LAYOUTS["4"], [1, 1], [1, 1]);
  assert.equal(segs.filter((s) => s.id.startsWith("c")).length, 1);
  assert.equal(segs.filter((s) => s.id.startsWith("r")).length, 1);
  const v = segs.find((s) => s.id.startsWith("c"))!;
  assert.ok(Math.abs(v.height - 100) < 1e-6);
  const h = segs.find((s) => s.id.startsWith("r"))!;
  assert.ok(Math.abs(h.width - 100) < 1e-6);
});

test("resizePair moves the boundary and clamps to sane bounds", () => {
  const w = resizePair([1, 1], 0, 0, 100, 75);
  assert.ok(Math.abs(w[1] * 3 - w[0]) < 1e-6, "75/25 split");
  const clamped = resizePair([1, 1], 0, 0, 100, 99.9);
  assert.ok(Math.abs(clamped[0] / clamped[1] - 9) < 1e-6, "clamped to 90% max");
  assert.deepEqual(resizePair([1, 1], 5, 0, 100, 50), [1, 1], "bad index is a no-op");
});

test("normWeights repairs broken weight arrays", () => {
  assert.deepEqual(normWeights(undefined, 3), [1, 1, 1]);
  assert.deepEqual(normWeights([2, -1], 2), [2, 1]);
});

test("pointer percent helpers", () => {
  const rect = { left: 100, width: 400, top: 0, height: 200 };
  assert.equal(pointerPct(rect as any, 300), 50);
  assert.equal(pointerPctY(rect as any, 150), 75);
});

test("workspace presets: sanitize repairs and rejects", () => {
  const good = sanitizePreset({
    id: "w1", name: "  Gold set  ", layout: "4",
    panels: [
      { symbol: "xauusd", timeframe: "5m" },
      { symbol: "EURUSD", timeframe: "bogus" },
      { symbol: "", timeframe: "1h" },
    ],
  });
  assert.ok(good);
  assert.equal(good.name, "Gold set");
  assert.equal(good.panels.length, 2, "empty-symbol panels dropped");
  assert.equal(good.panels[0].symbol, "XAUUSD");
  assert.equal(good.panels[1].timeframe, "1h", "bad timeframe falls back");
  assert.equal(sanitizePreset({ id: "w2", name: "x", layout: "9", panels: [] }), null, "no panels → rejected");
  assert.equal(sanitizePreset({ id: "w3", name: "x", layout: "1", panels: [{ symbol: "BTCUSD", timeframe: "1h" }] }).layout, "1");
  assert.equal(sanitizePreset({ id: "w4", name: "x", layout: "bogus", panels: [{ symbol: "BTCUSD", timeframe: "1h" }] }).layout, "1", "unknown layout → single");
});
