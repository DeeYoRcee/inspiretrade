/**
 * P41 — Long/Short position math + favorites store (pure parts).
 * Run: node --test tests/p41-position-favorites.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __sanitizeDrawingList, isPositionTool, positionAnchors, positionCalc,
  fmtPositionPrice, type Drawing,
} from "../client/src/lib/drawings.ts";
import {
  toggleFavorite, reorderFavorites, MAX_FAVORITES,
} from "../client/src/lib/drawing-favorites.ts";

const GOLD = { digits: 2, pipSize: 0.1, contractSize: 100 };   // XAUUSD
const FX = { digits: 5, pipSize: 0.0001, contractSize: 100000 }; // EURUSD

test("isPositionTool", () => {
  assert.equal(isPositionTool("long-position"), true);
  assert.equal(isPositionTool("short-position"), true);
  assert.equal(isPositionTool("trend"), false);
});

test("positionCalc XAUUSD — 1% risk on $10k sizes 0.2 lots", () => {
  // entry 2400, stop 2395 (5.00 = 50 pips), target 2410
  const c = positionCalc(2400, 2395, 2410, GOLD, 10000, 1);
  assert.equal(c.riskDist, 5);
  assert.equal(c.rewardDist, 10);
  assert.equal(c.rr, 2);
  // $/lot for this distance = 5.00 × 100 (contract oz) = $500 → $100 / 500
  assert.ok(Math.abs(c.lots! - 0.2) < 1e-9);
  assert.ok(Math.abs(c.riskAmount! - 100) < 1e-6);
  assert.ok(Math.abs(c.rewardAmount! - 200) < 1e-6);
});

test("positionCalc EURUSD — 1% risk on $10k sizes 0.5 lots", () => {
  // entry 1.0800, stop 1.0780 (20 pips), target 1.0860 (60 pips)
  const c = positionCalc(1.08, 1.078, 1.086, FX, 10000, 1);
  assert.ok(Math.abs(c.riskDist - 0.002) < 1e-12);
  assert.ok(Math.abs(c.rr - 3) < 1e-9);
  // $/lot = 0.002 × 100000 = $200 → $100 / 200 = 0.5
  assert.ok(Math.abs(c.lots! - 0.5) < 1e-9);
  assert.ok(Math.abs(c.riskAmount! - 100) < 1e-6);
  assert.ok(Math.abs(c.rewardAmount! - 300) < 1e-6);
});

test("positionCalc — no balance/spec → monetary fields stay undefined (never fabricated)", () => {
  const c1 = positionCalc(100, 90, 120);
  assert.equal(c1.lots, undefined);
  assert.equal(c1.riskAmount, undefined);
  const c2 = positionCalc(100, 90, 120, GOLD); // spec but no balance
  assert.equal(c2.lots, undefined);
  assert.equal(c2.riskPctOfPrice, 10);
});

test("positionCalc — custom risk % scales the size", () => {
  const c = positionCalc(2400, 2395, 2410, GOLD, 10000, 2.5);
  assert.ok(Math.abs(c.lots! - 0.5) < 1e-9);
});

test("positionAnchors — five semantic handles: levels right-pinned, band edges", () => {
  const anchors = positionAnchors([
    { x: 100, y: 50 },  // entry (left edge)
    { x: 300, y: 80 },  // stop  (right edge)
    { x: 999, y: 20 },  // target (x ignored)
  ]);
  assert.equal(anchors.length, 5);
  assert.deepEqual(anchors[0], { x: 300, y: 50 }); // entry level @ right edge
  assert.deepEqual(anchors[1], { x: 300, y: 80 });
  assert.deepEqual(anchors[2], { x: 300, y: 20 });
  assert.deepEqual(anchors[3], { x: 100, y: 50 }); // left edge mid
  assert.deepEqual(anchors[4], { x: 300, y: 50 }); // right edge mid
});

test("positionAnchors — short preview falls back to raw pts", () => {
  const pts = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  assert.equal(positionAnchors(pts), pts);
});

test("fmtPositionPrice — instrument precision with grouping", () => {
  assert.equal(fmtPositionPrice(4391.2, 2), "4,391.20");
  assert.equal(fmtPositionPrice(1.08412345, 5), "1.08412");
  assert.equal(fmtPositionPrice(NaN, 2), "—");
});

test("sanitizer keeps position fields, drops garbage", () => {
  const d: Record<string, unknown> = {
    id: "p1", type: "long-position",
    points: [{ time: 1, price: 100 }, { time: 2, price: 90 }, { time: 3, price: 120 }],
    style: { color: "#38bdf8", width: 2, dash: "solid", fontSize: 12, profitColor: "#00ff00", lossColor: "nope" },
    riskPct: 2.5,
  };
  const out = __sanitizeDrawingList([d]) as Drawing[];
  assert.equal(out.length, 1);
  assert.equal(out[0].riskPct, 2.5);
  assert.equal((out[0].style as Drawing["style"]).profitColor, "#00ff00");
  assert.equal((out[0].style as Drawing["style"]).lossColor, undefined);
  // risk % is clamped into a sane range
  d.riskPct = 500;
  const out2 = __sanitizeDrawingList([d]) as Drawing[];
  assert.equal(out2[0].riskPct, 100);
});

test("favorites toggle — dedupe + cap, order preserved", () => {
  let list = toggleFavorite([], "trend");
  assert.deepEqual(list, ["trend"]);
  list = toggleFavorite(list, "trend"); // toggle off
  assert.deepEqual(list, []);
  list = ["a", "b"];
  list = toggleFavorite(list, "c"); // add keeps order
  assert.deepEqual(list, ["a", "b", "c"]);
  list = toggleFavorite(list, "a"); // toggle OFF removes
  assert.deepEqual(list, ["b", "c"]);
  const many = Array.from({ length: MAX_FAVORITES + 4 }, (_, i) => `t${i}`);
  const capped = toggleFavorite(many, "new");
  assert.equal(capped.length, MAX_FAVORITES);
  assert.equal(capped.includes("new"), true);
});

test("favorites reorder — move semantics", () => {
  assert.deepEqual(reorderFavorites(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(reorderFavorites(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  const same = ["a", "b"];
  assert.equal(reorderFavorites(same, 0, 0), same);      // no-op keeps identity
  assert.equal(reorderFavorites(same, 5, 0), same);      // out of range
});
