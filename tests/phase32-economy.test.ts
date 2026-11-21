/**
 * PHASE 32 — economy additions: the Trading Case ($25,000 account puzzle),
 * the referral milestone table and the VIP daily track constants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES, ALL_FRAGMENTS, TRADING_FRAGMENTS, getFragment, cycleDayOf } from "../shared/fragments.ts";
import { REFERRAL_MILESTONES } from "../shared/fragments.ts";

test("P32 · Trading Case: $25,000 account in 9 pieces, wired into ALL_FRAGMENTS", () => {
  assert.equal(CASES.trading.name, "Trading Case");
  assert.equal(CASES.trading.accountSize, 25000);
  assert.equal(TRADING_FRAGMENTS.length, 9);
  for (let i = 1; i <= 9; i++) {
    const f = TRADING_FRAGMENTS[i - 1];
    assert.equal(f.name, `25k$ ${i}`);
    assert.ok(getFragment(f.id), "trading fragment must resolve via getFragment");
  }
  assert.ok(ALL_FRAGMENTS.some((f) => f.id === "trade-9"));
  // rarity curve mirrors inspire/gold: common 70, rare 16, epic 10, covert ~6, mythic 0.001
  const sum = TRADING_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
  assert.ok(Math.abs(sum - 102) < 0.001);
  assert.equal(TRADING_FRAGMENTS[8].rarity, "mythic");
});

test("P32 · daily cycle math unchanged (inspire/gold rhythm intact)", () => {
  assert.equal(cycleDayOf(1), 1);
  assert.equal(cycleDayOf(7), 7);
  assert.equal(cycleDayOf(8), 1);
  assert.equal(cycleDayOf(14), 7);
});

test("P32 · referral milestone tiers match the product spec exactly", () => {
  assert.deepEqual(REFERRAL_MILESTONES.map((t) => t.invited), [3, 10, 25, 50, 100]);
  assert.deepEqual(REFERRAL_MILESTONES.map((t) => t.cases), [1, 3, 5, 7, 10]);
  assert.deepEqual(REFERRAL_MILESTONES.map((t) => t.goldCases), [0, 0, 1, 3, 5]);
  assert.deepEqual(REFERRAL_MILESTONES.map((t) => t.insp), [0, 0, 0, 5, 10]);
});
