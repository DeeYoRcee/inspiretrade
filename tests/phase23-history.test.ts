/**
 * Phase 23 — historical data engine pure-function tests.
 *  §7 timeframe consistency: higher TFs aggregate from compatible lower data;
 *    weekends/market closures are NEVER filled with artificial candles.
 *  §8 validation quality gates: envelope sanity, rejections counted.
 *  §2 backfill honesty: month caps per timeframe.
 * Run: picked up by `npm test` (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inMarketHours, missingIntervals, HIST_MONTHS_CAP } from "../api/_src/lib/hist-sessions.ts";
import { aggregateBars } from "../shared/terminal.ts";

// UTC helpers: y m d h m → epoch sec
const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Math.floor(Date.UTC(y, m - 1, d, h, mi) / 1000);

test("inMarketHours: metals session Sun 22:00 → Fri 21:00 UTC, weekend closed", () => {
  // 2026-11-16 is a Monday
  assert.equal(inMarketHours(utc(2026, 11, 16, 12), "metal"), true, "Monday midday open");
  assert.equal(inMarketHours(utc(2026, 11, 16, 20, 59), "metal"), true);
  // 2026-11-20 is the Friday
  assert.equal(inMarketHours(utc(2026, 11, 20, 20, 59), "metal"), true);
  assert.equal(inMarketHours(utc(2026, 11, 20, 21, 0), "metal"), false, "Friday 21:00 close");
  // 2026-11-15 is a Sunday
  assert.equal(inMarketHours(utc(2026, 11, 15, 21, 59), "metal"), false, "Sunday before 22:00");
  assert.equal(inMarketHours(utc(2026, 11, 15, 22, 0), "metal"), true, "Sunday open 22:00");
  // 2026-11-21 is a Saturday
  assert.equal(inMarketHours(utc(2026, 11, 21, 12), "metal"), false, "Saturday closed");
});

test("inMarketHours: forex runs to Fri 21:55, crypto never closes", () => {
  assert.equal(inMarketHours(utc(2026, 11, 20, 21, 50), "forex"), true, "Friday 21:50 open");
  assert.equal(inMarketHours(utc(2026, 11, 20, 21, 56), "forex"), false, "Friday 21:56 closed");
  assert.equal(inMarketHours(utc(2026, 11, 21, 3), "crypto"), true, "Saturday 3am — crypto trades");
  assert.equal(inMarketHours(utc(2026, 11, 21, 3), "metal"), false);
});

test("inMarketHours: cash indices trade weekdays 13:30-20:00 UTC only", () => {
  assert.equal(inMarketHours(utc(2026, 11, 16, 14), "index"), true);
  assert.equal(inMarketHours(utc(2026, 11, 16, 12), "index"), false, "pre-market");
  assert.equal(inMarketHours(utc(2026, 11, 16, 21), "index"), false, "after close");
  assert.equal(inMarketHours(utc(2026, 11, 21, 14), "index"), false, "Saturday");
});

test("missingIntervals: market-hours gaps counted, weekend gaps NEVER counted", () => {
  // 1h bars over Wed→Mon: build bars everywhere EXCEPT a 3h midweek hole
  const tf = 3600;
  const bars: { time: number }[] = [];
  for (let t = utc(2026, 11, 18, 0); t <= utc(2026, 11, 23, 0); t += tf) {
    const d = new Date(t * 1000);
    const dow = d.getUTCDay();
    const weekend = dow === 6 || (dow === 5 && d.getUTCHours() >= 21) || (dow === 0 && d.getUTCHours() < 22);
    const hole = t >= utc(2026, 11, 18, 10) && t < utc(2026, 11, 18, 13); // Wed 10:00-13:00 missing
    if (!weekend && !hole) bars.push({ time: t });
  }
  const res = missingIntervals(bars as any, tf, utc(2026, 11, 18, 0), utc(2026, 11, 23, 0), "metal");
  assert.equal(res.count, 3, "exactly the 3 midweek hours are missing");
  assert.deepEqual(res.sample, [utc(2026, 11, 18, 10), utc(2026, 11, 18, 11), utc(2026, 11, 18, 12)]);
  assert.equal(res.longestGapSec, 3 * 3600, "the weekend closure is not a gap");
});

test("missingIntervals: closed market ≠ missing data (full weekend in window)", () => {
  const bars = [{ time: utc(2026, 11, 20, 12) }, { time: utc(2026, 11, 23, 12) }]; // Fri noon, Mon noon
  const res = missingIntervals(bars as any, 3600, utc(2026, 11, 20, 12), utc(2026, 11, 23, 12), "metal");
  // Fri 13→21 (8h — the Fri-noon bar exists) + Sat/Sun skipped + Sun 22→24 (2h) + Mon 0→12 (12h)
  const expected = 8 + 2 + 12;
  assert.equal(res.count, expected);
});

test("HIST_MONTHS_CAP: Phase 25 — full genuine depth, budgets provide the safety", () => {
  // Phase 25 §3: intraday caps no longer limit history depth — Dukascopy
  // serves forex/metals 1m BID candles back to 2010 (~202 months). Safety
  // moved to per-call budgets (≤90 day files, 45s deadline, 600 files/day,
  // TD pages) + the resumable cursor, so every single request stays small.
  assert.ok(HIST_MONTHS_CAP["1m"] >= 240, "m1 reaches the full genuine depth");
  assert.ok(HIST_MONTHS_CAP["5m"] >= 240);
  assert.ok(HIST_MONTHS_CAP["15m"] >= 240);
  assert.ok(HIST_MONTHS_CAP["1h"] >= 240);
  assert.ok(HIST_MONTHS_CAP["1d"] >= 240, "daily archives go back decades");
});

test("§7 fold correctness: 2h/4h aggregate exactly from 1h bars (no OHLC drift)", () => {
  // 6 hourly bars with known envelope
  const h1: any[] = [];
  for (let i = 0; i < 6; i++) {
    const t = utc(2026, 11, 16, i);
    const o = 100 + i;
    h1.push({ time: t, open: o, high: o + 3, low: o - 3, close: o + 1, volume: 10 });
  }
  const h2 = aggregateBars(h1, 120);
  assert.equal(h2.length, 3);
  assert.equal(h2[0].open, 100);
  assert.equal(h2[0].high, 104, "max(103,104) — running envelope");
  assert.equal(h2[0].low, 97, "min(97,98)");
  assert.equal(h2[0].close, 102, "latest close");
  assert.equal(h2[0].volume, 20, "volume summed");
  const h4 = aggregateBars(h1, 240);
  assert.equal(h4.length, 2); // wait — 6 hourly bars fold to 2 × 4h? floor bucketing
  // 4h buckets: 0-3 and 4-5 → 2 bars ✓ (partial trailing bucket folds honestly)
  assert.equal(h4[0].volume, 40);
});
