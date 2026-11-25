/**
 * P77 — the BLACK case tier: 0.00000001% prop-account drops. The catalog
 * must carry the exact odds, the tier must never collide with inventory
 * fragments, and the claim references must stay distinguishable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES, BLACK_DROP_PERCENT, ALL_FRAGMENTS, RARITY_META } from "../shared/fragments.ts";

test("black tier: every built-in case carries the exact 0.00000001% prop drop", () => {
  assert.equal(BLACK_DROP_PERCENT, 0.00000001);
  assert.equal(CASES.inspire.blackDrop.label, "5k$ Prop Account");
  assert.equal(CASES.gold.blackDrop.label, "10k$ Prop Account");
  assert.equal(CASES.trading.blackDrop.label, "25k$ Prop Account");
  for (const c of Object.values(CASES)) {
    assert.equal(c.blackDrop.accountSize, c.accountSize);
    assert.equal(c.blackDrop.dropPercent, BLACK_DROP_PERCENT);
  }
});

test("black tier: never an inventory fragment — other surfaces cannot show it", () => {
  for (const f of ALL_FRAGMENTS) assert.notEqual(f.rarity, "black");
  // P77 user request — the UI label never says "Black"; it names the prize
  assert.equal(RARITY_META.black.label, "Prop Account");
  assert.ok(RARITY_META.black.order > RARITY_META.mythic.order);
});
