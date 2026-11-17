/**
 * Daily-reward 7-day cycle simulation — replicates the EXACT server
 * transaction logic from api/_src/rewards/claim.ts and walks it day by day
 * against the real shared helpers. Guards the reported bug: after day 7 the
 * cycle MUST roll back to day 1 (and must survive a streak stored as a
 * string, which used to concatenate "7" + 1 = "71" and break the sequence).
 * Run: node --test tests/reward-cycle.test.ts  (also picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleDayOf, caseTypeForCycleDay, REWARD_CYCLE_DAYS } from "../shared/fragments.ts";

/** Mirror of previousDate() from api/_src/lib/firebase.ts (UTC calendar). */
function previousDate(dateStr: string): string {
  return new Date(Date.parse(dateStr + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}

/** Mirror of the claim transaction body (claim.ts) for a given local date. */
function claimTransaction(eco: any, today: string) {
  const current = eco || { coins: 0, cases: 0, goldCases: 0, streak: 0, totalClaimed: 0 };
  if (current.lastClaimDate === today) return undefined; // abort: already claimed
  const continued = current.lastClaimDate === previousDate(today);
  const streak = continued ? Math.floor(Number(current.streak) || 0) + 1 : 1;
  const cycleDay = cycleDayOf(streak);
  const caseType = caseTypeForCycleDay(cycleDay);
  return {
    ...current,
    coins: current.coins || 0,
    cases: (current.cases || 0) + (caseType === "inspire" ? 1 : 0),
    goldCases: (current.goldCases || 0) + (caseType === "gold" ? 1 : 0),
    streak,
    lastClaimDate: today,
    totalClaimed: (current.totalClaimed || 0) + 1,
  };
}

/** "2026-11-17" + n days → "2026-11-18"-style strings (UTC calendar). */
function dateAfter(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

test("reward cycle: 10 consecutive days — day 8 rolls back to cycle day 1", () => {
  let eco: any = null;
  const days: number[] = [];
  const goldDays: number[] = [];
  for (let i = 0; i < 10; i++) {
    const today = dateAfter("2026-11-10", i);
    const next = claimTransaction(eco, today);
    assert.ok(next !== undefined, `claim on ${today} must commit`);
    eco = next;
    days.push(cycleDayOf(eco.streak));
    if (caseTypeForCycleDay(cycleDayOf(eco.streak)) === "gold") goldDays.push(i + 1);
  }
  assert.deepEqual(days, [1, 2, 3, 4, 5, 6, 7, 1, 2, 3], "cycle must restart after day 7");
  assert.deepEqual(goldDays, [7], "exactly one Gold Case per cycle");
  assert.equal(eco.cases, 9, "9 Inspire Cases after 10 days");
  assert.equal(eco.goldCases, 1, "1 Gold Case after 10 days");
});

test("reward cycle: the day after completing day 7 shows day 1 as next (client math)", () => {
  // server state right after the day-7 claim
  let eco: any = claimTransaction(null, "2026-11-16");
  for (let i = 1; i < 7; i++) eco = claimTransaction(eco, dateAfter("2026-11-16", i));
  assert.equal(eco.streak, 7);

  // next day, reward not yet claimed — the CLIENT computes:
  const claimedToday = false;
  const streakNum = Number(eco.streak) || 0;
  const claimedInCycle = claimedToday ? cycleDayOf(streakNum) : streakNum % REWARD_CYCLE_DAYS;
  const nextCycleDay = (claimedInCycle % REWARD_CYCLE_DAYS) + 1;
  assert.equal(nextCycleDay, 1, "day 1 must be next after the cycle completes");
});

test("reward cycle: missed day resets the streak (fresh cycle from day 1)", () => {
  let eco: any = null;
  for (let i = 0; i < 5; i++) eco = claimTransaction(eco, dateAfter("2026-11-10", i));
  assert.equal(eco.streak, 5);
  // skip two days → claim on day 8
  const next = claimTransaction(eco, "2026-11-18");
  assert.ok(next);
  assert.equal(next.streak, 1, "broken streak resets to 1");
  assert.equal(cycleDayOf(next.streak), 1);
});

test("reward cycle: a streak stored as a STRING heals on the next claim", () => {
  // corrupted account state: streak "7" as a string (old data / manual edit).
  // Pre-fix logic: "7" + 1 = "71" → the sequence never followed 1→7 again.
  const eco = { streak: "7", lastClaimDate: "2026-11-16", coins: 5, cases: 6, goldCases: 1, totalClaimed: 7 };
  const next: any = claimTransaction(eco, "2026-11-17");
  assert.equal(typeof next.streak, "number", "streak normalized back to a number");
  assert.equal(next.streak, 8);
  assert.equal(cycleDayOf(next.streak), 1, "cycle restarts at day 1");
});

test("reward cycle: claim transaction preserves fields written elsewhere", () => {
  const eco = { streak: 3, lastClaimDate: "2026-11-16", coins: 100, customCases: { my_case: 2 } };
  const next: any = claimTransaction(eco, "2026-11-17");
  assert.deepEqual(next.customCases, { my_case: 2 }, "customCases must survive the claim");
  assert.equal(next.coins, 100);
});

test("reward cycle: double claim on the same day aborts", () => {
  const eco: any = claimTransaction(null, "2026-11-17");
  assert.equal(claimTransaction(eco, "2026-11-17"), undefined, "second claim aborts");
});
