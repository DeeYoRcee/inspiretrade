/**
 * P75 — profile frames catalog + custom-case pool expansion (pure logic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAMES, FRAME_IDS, getFrame } from "../shared/frames.ts";
import { ALL_FRAGMENTS, expandCasePool } from "../shared/fragments.ts";

test("frames: catalog is complete and unique", () => {
  assert.equal(FRAMES.length, 8);
  assert.equal(new Set(FRAME_IDS).size, FRAMES.length, "frame ids must be unique");
  for (const f of FRAMES) {
    assert.ok(f.id.length >= 3 && f.id.length <= 40);
    assert.ok(f.name.length >= 2);
    assert.ok(f.ring.includes("gradient") || f.ring.includes("conic"), `${f.id} must carry a CSS gradient`);
    assert.ok(f.desc.length >= 10);
  }
  // the seven regular directions + the exclusive CEO frame
  for (const id of ["classic", "premium", "elite", "royal", "diamond", "cyber", "legendary", "ceo"]) {
    assert.ok(FRAME_IDS.includes(id), `missing frame ${id}`);
  }
});

test("frames: exactly one exclusive frame and it is the CEO", () => {
  const exclusive = FRAMES.filter((f) => f.exclusive);
  assert.equal(exclusive.length, 1);
  assert.equal(exclusive[0].id, "ceo");
});

test("frames: getFrame resolves known ids and rejects junk", () => {
  assert.equal(getFrame("royal")?.name, "Royal");
  assert.equal(getFrame("ceo")?.exclusive, true);
  assert.equal(getFrame("not-a-frame"), null);
  assert.equal(getFrame(null), null);
  assert.equal(getFrame(undefined), null);
  assert.equal(getFrame(""), null);
});

test("pool expansion: weight×qty is the exact roll share", () => {
  const pool = expandCasePool([
    { id: "trade-1", weight: 1, qty: 9 },   // "25k$ 9 kerak" — nine copies
    { id: "trade-9", weight: 1, qty: 1 },
  ]);
  assert.equal(pool.length, 10);
  const nine = pool.filter((f) => f.id === "trade-1").length;
  assert.equal(nine, 9);
  // normalized share: 9/10 regardless of the copy list ordering
  assert.ok(Math.abs(nine / pool.length - 0.9) < 1e-9);
});

test("pool expansion: legacy rows without qty behave like qty 1", () => {
  const pool = expandCasePool([
    { id: "discipline", weight: 35 },
    { id: "patience", weight: 35 },
  ]);
  assert.equal(pool.length, 2);
  assert.equal(pool[0].id, "discipline");
  assert.ok(Math.abs(pool[0].dropPercent - 35) < 1e-9);
});

test("pool expansion: invalid rows are dropped, qty clamped 1..100", () => {
  const pool = expandCasePool([
    { id: "ghost-fragment", weight: 10 },     // unknown id
    { id: "discipline", weight: 0 },          // bad weight
    { id: "patience", weight: -5 },           // bad weight
    { id: "psychology", weight: 5, qty: 500 }, // clamp to 100
    { id: "consistency", weight: 5, qty: 0 },  // clamp to 1
  ]);
  assert.equal(pool.filter((f) => f.id === "psychology").length, 100);
  assert.equal(pool.filter((f) => f.id === "consistency").length, 1);
  assert.equal(pool.filter((f) => f.id === "ghost-fragment").length, 0);
  assert.equal(pool.filter((f) => f.id === "discipline").length, 0);
});

test("pool expansion: every expanded fragment is a canonical definition", () => {
  const pool = expandCasePool(ALL_FRAGMENTS.slice(0, 5).map((f) => ({ id: f.id, weight: 1, qty: 2 })));
  assert.equal(pool.length, 10);
  for (const f of pool) assert.ok(ALL_FRAGMENTS.some((base) => base.id === f.id));
});
