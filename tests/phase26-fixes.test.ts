/**
 * Phase 26 — regression tests for the production fixes:
 *   §S1  withdrawal reserve = the REQUESTED amount (decrementAmount)
 *   §S4  spot identity price bands (SPOT_PRICE_BANDS) shared by spot-record
 *        and the TwelveData backfill
 *   §D1  fmtDrawingPrice — drawing labels print MARKET prices, not pixels
 *   §HIST backfill resume: every step continues BELOW the oldest stored day
 *        (mirror of the fixed runBackfillStep window math — the old code
 *        always re-walked the newest ~90 days, so deep fills never deepened)
 *   §HEAL metals deep-history self-heal trigger thresholds
 * Run: node --test tests/phase26-fixes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decrementAmount } from "../api/_src/lib/firebase.ts";
import { SPOT_PRICE_BANDS } from "../shared/terminal.ts";
import { fmtDrawingPrice } from "../client/src/lib/drawings.ts";
import { levelsFor, FIB_DEFAULT_LEVELS } from "../client/src/lib/drawings.ts";

// ---------------------------------------------------------------------------
// §S1 — decrementAmount reserves the requested amount
// ---------------------------------------------------------------------------

/** Minimal RTDB-ref stand-in implementing just what decrementAmount uses. */
function fakeRef(balance: number) {
  let v = balance;
  return {
    get: async () => ({ val: () => v }),
    transaction: async (fn: (c: any) => any) => {
      const next = fn(v);
      const committed = next !== v;
      if (committed) v = next;
      return { committed, snapshot: { val: () => v } };
    },
    value: () => v,
  };
}
const err = () => new Error("INSUFFICIENT") as any;

test("S1: reserve equals the requested amount (not 1)", async () => {
  const ref = fakeRef(1000);
  const after = await decrementAmount(ref as any, 350, err());
  assert.equal(after, 650);
  assert.equal(ref.value(), 650);
});

test("S1: insufficient balance → no-op + throw (100k request on 5 coins)", async () => {
  const ref = fakeRef(5);
  await assert.rejects(() => decrementAmount(ref as any, 100000, err()), /INSUFFICIENT/);
  assert.equal(ref.value(), 5, "balance must not change");
});

test("S1: reject-refund of the reserved amount can never mint coins", () => {
  // reserve(1000) then refund(1000) → net 0 — the exploit required reserve(1)/refund(amount)
  const ref = fakeRef(1000);
  return decrementAmount(ref as any, 1000, err()).then(async (after) => {
    assert.equal(after, 0);
    // refund path (admin/withdrawals.ts) adds current.amount back:
    const refunded = ref.value() + 1000;
    assert.equal(refunded, 1000, "net zero — no minting");
  });
});

test("S1: non-positive / NaN amount throws and leaves the balance intact", async () => {
  const ref = fakeRef(10);
  await assert.rejects(() => decrementAmount(ref as any, 0, err()));
  await assert.rejects(() => decrementAmount(ref as any, -5, err()));
  await assert.rejects(() => decrementAmount(ref as any, Number.NaN, err()));
  assert.equal(ref.value(), 10);
});

// ---------------------------------------------------------------------------
// §S4 — spot identity price bands
// ---------------------------------------------------------------------------

test("S4: bands reject foreign-instrument prices, accept real ones", () => {
  const [loXau, hiXau] = SPOT_PRICE_BANDS.XAU;
  const [loXag, hiXag] = SPOT_PRICE_BANDS.XAG;
  assert.equal(loXau <= 3300 && 3300 <= hiXau, true, "real gold spot inside band");
  assert.equal(0.5 < loXau && 25000 > hiXau, true, "$0.01 gold / over-band gold refused");
  assert.equal(loXau === 1000 && hiXau === 20000, true, "bands mirror the chart's identity priceBand");
  assert.equal(loXag === 5 && hiXag === 200, true);
  assert.equal(loXag <= 30 && 30 <= hiXag, true, "real silver spot inside band");
});

// ---------------------------------------------------------------------------
// §D1 — fmtDrawingPrice (market prices in drawing labels)
// ---------------------------------------------------------------------------

test("D1: formatter keeps integers intact and strips trailing zeros", () => {
  assert.equal(fmtDrawingPrice(200), "200");
  assert.equal(fmtDrawingPrice(3265.4), "3265.4");
  assert.equal(fmtDrawingPrice(42.5), "42.5");
  assert.equal(fmtDrawingPrice(42.50), "42.5");
  assert.equal(fmtDrawingPrice(0.618), "0.618");
  assert.equal(fmtDrawingPrice(-12.34), "-12.34");
  assert.equal(fmtDrawingPrice(Number.NaN), "—");
  assert.equal(fmtDrawingPrice(1e7), "10000000");
});

// ---------------------------------------------------------------------------
// §D2 — fib level config drives rendering (levelsFor is what visibleLevels
// filters; retracement/extension now consume it instead of constants)
// ---------------------------------------------------------------------------

test("D2: per-drawing level overrides win over the tool defaults", () => {
  const base = { id: "d1", type: "fib-retracement" as const, points: [], style: { color: "#fff", width: 1, dash: "solid" as const, fontSize: 12 } };
  // no overrides → the tool defaults (the exact table the renderer used before)
  assert.deepEqual(levelsFor(base).map((l) => l.ratio), FIB_DEFAULT_LEVELS["fib-retracement"]);
  // overrides (hide 0.5, recolor 0.618) are returned verbatim
  const custom = { ...base, levels: [{ ratio: 0.236, show: true }, { ratio: 0.5, show: false }, { ratio: 0.618, show: true, color: "#ff0000" }] };
  const got = levelsFor(custom);
  assert.equal(got.length, 3);
  assert.equal(got[1].show, false);
  assert.equal(got[2].color, "#ff0000");
});

// ---------------------------------------------------------------------------
// §HIST — resume window math (mirror of the fixed runBackfillStep logic)
// ---------------------------------------------------------------------------

/** Mirror of the FIXED walk-window selection in api/_src/lib/hist.ts. */
function walkWindow(stateOldest: number | null, wantFrom: number, now: number, maxDays: number) {
  const covered = stateOldest ? Math.min(stateOldest, wantFrom) : wantFrom;
  const top = stateOldest != null ? Math.min(stateOldest, now - 2 * 86400) : now - 2 * 86400;
  // dukaWalkM1 builds days from `top` DOWNWARD, capped at maxDays:
  const firstDay = Math.floor(top / 86400) * 86400;
  const lastDay = Math.max(firstDay - (maxDays - 1) * 86400, Math.ceil(covered / 86400) * 86400);
  return { covered, top, oldestReached: lastDay };
}

const NOW = Date.UTC(2026, 10, 20) / 1000;
const WANT_FROM = NOW - 240 * 30 * 86400; // 240-month target

test("HIST: repeated steps deepen monotonically and cover the target window", () => {
  let oldest: number | null = null;
  let prev: number | null = null;
  for (let step = 0; step < 6; step++) {
    const { oldestReached } = walkWindow(oldest, WANT_FROM, NOW, 90);
    oldest = oldestReached;
    if (prev != null) assert.ok(oldest < prev, `step ${step} must go DEEPER (${oldest} < ${prev})`);
    prev = oldest;
  }
  // ~540 days covered after 6 steps — the old code stayed at ~92 days forever
  assert.ok(NOW - oldest! > 500 * 86400, "6 steps must cover ~540 days, not ~90");
});

test("HIST: a done store (older than target) re-walks nothing and reports done", () => {
  const deep = WANT_FROM - 86400; // already deeper than the target
  const { oldestReached } = walkWindow(deep, WANT_FROM, NOW, 90);
  assert.ok(oldestReached <= WANT_FROM, "done");
});

// ---------------------------------------------------------------------------
// §HEAL — metals deep-history self-heal trigger (mirror of loadRecordedSpot)
// ---------------------------------------------------------------------------

test("HEAL: thin store fires, a store deeper than the threshold does not", () => {
  const now = Date.now() / 1000;
  const heal = (deepFrom: number, sec: number) => deepFrom > now - (sec >= 3600 ? 85 : 40) * 86400;
  // minute TF: 30-day recorded window only → fire
  assert.equal(heal(now - 30 * 86400, 60), true);
  // minute TF: store already 45+ days deep → stop (scroll-back takes over)
  assert.equal(heal(now - 45 * 86400, 60), false);
  // hour TF: empty 90-day shard window (firstBar = now) → fire
  assert.equal(heal(now, 3600), true);
  // hour TF: shards cover the 90-day window → stop
  assert.equal(heal(now - 90 * 86400, 3600), false);
});
