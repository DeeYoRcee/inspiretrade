/**
 * Phase 27 §8 — market-session restriction tests with a CONTROLLABLE clock
 * (every scenario passes an explicit `at` instant; no waiting for Saturday).
 *
 * Reference instants (UTC). 2026 DST: US spring-forward Sun Mar 8, fall-back
 * Sun Nov 1 (02:00 EDT → 01:00 EST). After Nov 1, New York = UTC-5.
 * Run: node --test tests/  (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketHours, nextOpen, marketOpenOrThrow, closedIntervals, filterClosedCandles, isClosedAt } from "../shared/market-hours.ts";

const T = (isoUtc: string) => Date.parse(isoUtc);

// ---- fixed scenario instants ------------------------------------------------
const SAT_NOON = T("2026-11-21T12:00:00Z"); // Saturday Nov 21, 2026
const FRI_BEFORE = T("2026-11-20T20:00:00Z"); // Fri 15:00 NY (EST) — session live
const FRI_AFTER = T("2026-11-20T22:30:00Z"); // Fri 17:30 NY — week closed
const SUN_BEFORE = T("2026-11-22T18:00:00Z"); // Sun 13:00 NY — still weekend
const SUN_AFTER_FX = T("2026-11-22T23:00:00Z"); // Sun 18:00 NY — FX reopened
const SUN_METAL_CLOSED = T("2026-11-22T22:00:00Z"); // Sun 17:00 NY — CME metals still shut
const WED_BREAK = T("2026-11-18T22:30:00Z"); // Wed 17:30 NY — metals daily pause
const DST_SPRING_OPEN = T("2026-03-08T21:30:00Z"); // Sun 17:30 EDT (UTC-4) — FX open
const DST_FALL_CLOSED = T("2026-11-01T21:30:00Z"); // Sun 16:30 EST (UTC-5) — FX still shut

test("§8.1/8.2 Saturday: XAUUSD (metals) closed for BUY and SELL alike", () => {
  const mh = marketHours("XAUUSD", SAT_NOON);
  assert.equal(mh.open, false);
  assert.equal(mh.reason, "weekend");
  assert.throws(() => marketOpenOrThrow("XAUUSD", SAT_NOON), /MARKET_CLOSED/);
});

test("§8.3 Saturday: EURUSD closed", () => {
  const mh = marketHours("EURUSD", SAT_NOON);
  assert.equal(mh.open, false);
  assert.equal(mh.reason, "weekend");
  assert.throws(() => marketOpenOrThrow("EURUSD", SAT_NOON), /MARKET_CLOSED/);
});

test("§8.4 Saturday: pending orders rejected too (same guard, any kind)", () => {
  // the guard runs before kind handling — market/limit/stop all hit it
  assert.throws(() => marketOpenOrThrow("GBPUSD", SAT_NOON), /MARKET_CLOSED/);
});

test("§8.5 Saturday: BTC/USDT still tradable (crypto 24/7)", () => {
  const mh = marketHours("BTCUSD", SAT_NOON);
  assert.equal(mh.open, true);
  assert.equal(mh.reason, "open");
  assert.doesNotThrow(() => marketOpenOrThrow("BTCUSD", SAT_NOON));
  const eth = marketHours("ETHUSD", SAT_NOON);
  assert.equal(eth.open, true);
});

test("§8.6 Sunday before FX opening: forex orders rejected", () => {
  assert.equal(marketHours("EURUSD", SUN_BEFORE).open, false);
  assert.equal(marketHours("EURUSD", SUN_BEFORE).reason, "weekend");
});

test("§8.7 Sunday after FX opening: forex allowed (provider window confirms)", () => {
  const mh = marketHours("EURUSD", SUN_AFTER_FX);
  assert.equal(mh.open, true);
  assert.equal(mh.reason, "open");
  // metals stay shut one more hour on Sunday (CME 18:00 NY open)
  assert.equal(marketHours("XAUUSD", SUN_METAL_CLOSED).open, false);
  assert.equal(marketHours("XAUUSD", SUN_AFTER_FX).open, true);
});

test("§8.8 Friday after 17:00 NY: forex orders rejected; before: allowed", () => {
  assert.equal(marketHours("EURUSD", FRI_BEFORE).open, true);
  assert.equal(marketHours("EURUSD", FRI_AFTER).open, false);
  assert.equal(marketHours("XAUUSD", FRI_AFTER).open, false);
});

test("§8.9 DST transitions handled by the NY wall clock (no fixed UTC offset)", () => {
  // spring forward: Sun Mar 8 2026, 17:30 EDT = 21:30 UTC → OPEN
  assert.equal(marketHours("EURUSD", DST_SPRING_OPEN).open, true);
  // fall back: Sun Nov 1 2026, 16:30 EST = 21:30 UTC → still CLOSED
  // (a fixed UTC-4 offset would wrongly read 17:30 and open the market)
  assert.equal(marketHours("EURUSD", DST_FALL_CLOSED).open, false);
});

test("§8 metals daily break: 17:00–18:00 NY midweek pauses metals only", () => {
  const gold = marketHours("XAUUSD", WED_BREAK);
  assert.equal(gold.open, false);
  assert.equal(gold.reason, "daily-break");
  assert.equal(marketHours("EURUSD", WED_BREAK).open, true);
});

test("§8.10 next opening time is computed in absolute UTC instants", () => {
  // Saturday noon → FX reopens Sunday 17:00 EST = Sun 22:00 UTC Nov 22
  const fxNext = nextOpen("EURUSD", SAT_NOON);
  assert.equal(fxNext, Date.parse("2026-11-22T22:00:00Z"));
  // metals reopens Sunday 18:00 EST = Sun 23:00 UTC
  const goldNext = nextOpen("XAUUSD", SAT_NOON);
  assert.equal(goldNext, Date.parse("2026-11-22T23:00:00Z"));
  // an open market reports no next-open
  assert.equal(nextOpen("BTCUSD", SAT_NOON), null);
});

test("backend contract: guard throws the exact Phase 27 §2 error text", () => {
  try {
    marketOpenOrThrow("USDJPY", SAT_NOON);
    assert.fail("must have thrown");
  } catch (e: any) {
    assert.equal(String(e.message), "MARKET_CLOSED: Trading is unavailable for this instrument at the moment.");
  }
});

test("indices keep their real exchange windows; unknown classes never blocked", () => {
  // NAS100 Saturday → closed; Wednesday 15:00 NY → open
  assert.equal(marketHours("NAS100", SAT_NOON).open, false);
  assert.equal(marketHours("NAS100", T("2026-11-18T20:00:00Z")).open, true);
  // unknown instrument → closed (phase 21 contract; the backend rejects
  // unknown symbols with BAD_SYMBOL long before this guard matters)
  assert.equal(marketHours("NOT_A_SYMBOL", SAT_NOON).open, false);
});

// ---- Phase 28 — weekend candle-generation pipeline --------------------------
// The recorder/merger gates all run through these pure helpers, so the
// simulated-clock scenario matrix below covers the whole pipeline: a candle
// whose OPEN time falls in a closed session is provably false (a closed
// market cannot print a price) and must be rejected at every door — client
// recorder, server spot-record, server serving fold, purge.

// candles are stored in epoch SECONDS (T() gives ms) — divide once here
const SC: (t: number) => any = (t: number) => ({ time: t / 1000, t: t / 1000, o: 3539, h: 3539, l: 3539, c: 3539, s: 1 });

test("§8 Fri before close: M1 candle accepted (open session)", () => {
  // Fri Nov 20 2026, 15:00 NY = 20:00 UTC — genuine session
  const kept = filterClosedCandles("XAUUSD", [SC(T("2026-11-20T20:00:00Z"))]);
  assert.equal(kept.length, 1);
  assert.equal(isClosedAt("XAUUSD", T("2026-11-20T20:00:00Z") / 1000), false);
});

test("§8 Fri after close: candle rejected at every door", () => {
  assert.equal(isClosedAt("XAUUSD", T("2026-11-20T22:30:00Z") / 1000), true);
  assert.equal(filterClosedCandles("XAUUSD", [SC(T("2026-11-20T22:30:00Z"))]).length, 0);
});

test("§8 Saturday morning AND evening: no candles can exist", () => {
  const sat = [T("2026-11-21T08:00:00Z"), T("2026-11-21T15:00:00Z"), T("2026-11-21T21:59:00Z")];
  for (const t of sat) {
    assert.equal(isClosedAt("XAUUSD", t / 1000), true, `Sat ${t}`);
    assert.equal(isClosedAt("EURUSD", t / 1000), true);
    assert.equal(filterClosedCandles("XAUUSD", [SC(t)]).length, 0);
  }
  // crypto: same Saturday instants are a valid open session — untouched
  const btc = filterClosedCandles("BTCUSD", sat.map(SC));
  assert.equal(btc.length, 3); // empty closed-interval list for crypto
});

test("§8 Sunday before reopening: rejected; after reopening: accepted", () => {
  // FX reopens Sun 17:00 EST = 22:00 UTC; metals one hour later (23:00 UTC)
  assert.equal(filterClosedCandles("EURUSD", [SC(T("2026-11-22T18:00:00Z"))]).length, 0);
  assert.equal(filterClosedCandles("XAUUSD", [SC(T("2026-11-22T22:00:00Z"))]).length, 0);
  assert.equal(filterClosedCandles("EURUSD", [SC(T("2026-11-22T23:00:00Z"))]).length, 1);
  assert.equal(filterClosedCandles("XAUUSD", [SC(T("2026-11-22T23:00:00Z"))]).length, 1);
});

test("§8 DST transition days produce the correct closed windows", () => {
  // spring forward Sun 2026-03-08: FX closed until 21:00 UTC (17:00 EDT)
  const fx = closedIntervals("EURUSD", T("2026-03-08T00:00:00Z") / 1000, T("2026-03-09T00:00:00Z") / 1000);
  assert.deepEqual(fx, [{ from: T("2026-03-08T00:00:00Z") / 1000, to: T("2026-03-08T21:00:00Z") / 1000 }]);
  // metals reopen at 22:00 UTC EDT
  const gold = closedIntervals("XAUUSD", T("2026-03-08T00:00:00Z") / 1000, T("2026-03-09T00:00:00Z") / 1000);
  assert.equal(gold[0].to, T("2026-03-08T22:00:00Z") / 1000);
  // fall back Sun 2026-11-01: FX closed until 22:00 UTC (17:00 EST)
  const fx2 = closedIntervals("EURUSD", T("2026-11-01T00:00:00Z") / 1000, T("2026-11-02T00:00:00Z") / 1000);
  assert.equal(fx2[0].to, T("2026-11-01T22:00:00Z") / 1000);
});

test("§8 metals daily-break minute is provably false on Wednesday", () => {
  // Wed Nov 18 2026, 17:30 NY = 22:30 UTC — CME metals pause
  assert.equal(filterClosedCandles("XAUUSD", [SC(T("2026-11-18T22:30:00Z"))]).length, 0);
  assert.equal(filterClosedCandles("EURUSD", [SC(T("2026-11-18T22:30:00Z"))]).length, 1);
});

test("§6 higher timeframes cannot inherit a false weekend sample", () => {
  // the store contains Fri-close + weekend + Sun-reopen candles; the serving
  // filter must keep ONLY the genuine ones, so any H1/H4/D1 fold built from
  // this array is clean by construction
  const store = [
    T("2026-11-20T21:59:00Z"), // Fri 16:59 NY — last genuine minute
    T("2026-11-20T22:05:00Z"), // Fri 17:05 NY — false
    T("2026-11-21T09:30:00Z"), // Sat — false
    T("2026-11-22T15:00:00Z"), // Sun 10:00 NY — false
    T("2026-11-22T23:30:00Z"), // Sun 18:30 NY — genuine reopen
  ].map(SC);
  const kept = filterClosedCandles("XAUUSD", store);
  assert.deepEqual(kept.map((c) => c.time), [store[0].time, store[4].time]); // seconds
});

test("§9 genuine open-session corrections are never dropped", () => {
  // Friday bucket boundaries and the reopen minute all pass unharmed
  const edge = [
    T("2026-11-20T04:00:00Z"), // Fri 00:00 NY — session live
    T("2026-11-22T23:00:00Z"), // metals Sunday reopen minute (18:00 NY)
  ].map(SC);
  assert.equal(filterClosedCandles("XAUUSD", edge).length, 2);
});
