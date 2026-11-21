/**
 * PHASE 31 — session-gated recording + closed-anchor shards + fold engine.
 *
 * Issue 4 (EURUSD/GBPUSD M1 candles on Saturday/Sunday): the batch Market
 * Watch poll called recordFxLiveBids UNGATED, so TrueFX's stale weekend BIDs
 * folded minute candles all weekend (799 Sat minutes per pair, live-verified
 * Nov 21). The fix gates the recorder itself with the shared NY-wall-clock
 * session engine — these tests pin the session boundaries the gate relies on.
 *
 * Issues 1-3 (W1 deep, lower TFs empty): the fold engine must refuse closed
 * anchors and incomplete base days, so a weekly/daily fold can never print
 * a fabricated bar from weekend poison or partial walk days.
 *
 * Run: node --test tests/ (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketHours, closedIntervals, filterClosedCandles } from "../shared/market-hours.ts";
import { isIntradayTf, dropClosedAnchors, foldWeekComplete, INTRADAY_TFS } from "../api/_src/lib/hist-sessions.ts";

const T = (iso: string) => Math.floor(new Date(iso).getTime() / 1000); // epoch SECONDS (closedIntervals / candle times)
const Tms = (iso: string) => new Date(iso).getTime(); // epoch MS (marketHours)
// 2026-11: after the Nov 1 fall-back, New York = EST (UTC-5).
// 2026-07: summer, New York = EDT (UTC-4).

test("P31 · forex session: Saturday is fully closed (the EURUSD/GBPUSD bug)", () => {
  const mh = marketHours("EURUSD", new Date("2026-11-21T13:18:00Z").getTime()); // Sat 08:18 NY
  assert.equal(mh.open, false);
  assert.equal(marketHours("GBPUSD", new Date("2026-11-21T00:00:30Z").getTime()).open, false); // Sat 00:00 NY edge
});

test("P31 · forex session: Sunday reopen / Friday close (winter EST)", () => {
  assert.equal(marketHours("EURUSD", Tms("2026-11-22T21:59:00Z")).open, false); // Sun 16:59 NY
  assert.equal(marketHours("EURUSD", Tms("2026-11-22T22:00:00Z")).open, true);  // Sun 17:00 NY — reopen
  assert.equal(marketHours("EURUSD", Tms("2026-11-20T21:59:00Z")).open, true);  // Fri 16:59 NY — still open
  assert.equal(marketHours("EURUSD", Tms("2026-11-20T22:00:00Z")).open, false); // Fri 17:00 NY — closed
});

test("P31 · forex session: DST-correct reopen/close (summer EDT)", () => {
  assert.equal(marketHours("EURUSD", Tms("2026-07-12T20:59:00Z")).open, false); // Sun 16:59 EDT
  assert.equal(marketHours("EURUSD", Tms("2026-07-12T21:00:00Z")).open, true);  // Sun 17:00 EDT = 21:00 UTC
  assert.equal(marketHours("EURUSD", Tms("2026-07-10T21:00:00Z")).open, false); // Fri 17:00 EDT = 21:00 UTC
});

test("P31 · metals session: Sat closed, Sun 18:00 NY reopen (unchanged by P31)", () => {
  assert.equal(marketHours("XAUUSD", Tms("2026-11-21T13:18:00Z")).open, false);
  assert.equal(marketHours("XAUUSD", Tms("2026-11-22T23:00:00Z")).open, true); // Sun 18:00 EST
  assert.equal(marketHours("XAUUSD", Tms("2026-11-22T22:59:00Z")).open, false);
});

test("P31 · crypto is 24/7 in the session engine (recorder gate no-op)", () => {
  assert.equal(marketHours("BTCUSD", Tms("2026-11-21T13:18:00Z")).open, true); // Saturday
  assert.deepEqual(closedIntervals("BTCUSD", T("2026-11-14T00:00:00Z"), T("2026-11-21T00:00:00Z")), []);
});

test("P31 · isIntradayTf: minute-anchor gate applies intraday only", () => {
  for (const tf of ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h"]) assert.equal(isIntradayTf(tf), true);
  for (const tf of ["1d", "1W", "1M"]) assert.equal(isIntradayTf(tf), false);
  assert.equal(INTRADAY_TFS.size, 8);
});

test("P31 · closedIntervals EURUSD: every weekend instant is inside a closed interval", () => {
  // Fri Nov 20 22:00 UTC close → Sun Nov 22 22:00 UTC open (EST). The engine
  // emits per-DAY intervals (Fri tail, Saturday, Sunday head) — the union
  // must cover every minute of the closed window.
  const ivs = closedIntervals("EURUSD", T("2026-11-20T00:00:00Z"), T("2026-11-23T00:00:00Z"));
  const inside = (t: number) => ivs.some((iv) => t >= iv.from && t < iv.to);
  for (const iso of ["2026-11-20T22:00:00Z", "2026-11-21T00:00:00Z", "2026-11-21T12:00:00Z", "2026-11-21T23:59:00Z", "2026-11-22T08:00:00Z", "2026-11-22T21:59:00Z"]) {
    assert.ok(inside(T(iso)), `${iso} must be closed`);
  }
  assert.equal(inside(T("2026-11-20T21:59:00Z")), false, "Fri 16:59 NY is open");
  assert.equal(inside(T("2026-11-22T22:00:00Z")), false, "Sun 17:00 NY reopen is open");
});

test("P31 · dropClosedAnchors keeps open anchors, drops weekend/boundary minutes", () => {
  const bars = [
    { time: T("2026-11-20T21:55:00Z") }, // Fri 16:55 NY — OPEN, keep (last valid Friday minute)
    { time: T("2026-11-20T22:00:00Z") }, // Fri 17:00 NY — close instant, drop
    { time: T("2026-11-21T12:00:00Z") }, // Saturday — drop
    { time: T("2026-11-22T21:59:00Z") }, // Sun 16:59 NY — drop
    { time: T("2026-11-22T22:00:00Z") }, // Sun 17:00 NY — OPEN, keep
    { time: T("2026-11-23T00:00:00Z") }, // Monday — keep
  ];
  const ivs = closedIntervals("EURUSD", T("2026-11-18T00:00:00Z"), T("2026-11-24T00:00:00Z"));
  const g = dropClosedAnchors(bars, ivs);
  assert.deepEqual(g.bars.map((b) => b.time), [bars[0].time, bars[4].time, bars[5].time]);
  assert.equal(g.dropped, 3);
});

test("P31 · metals daily 17:00-18:00 NY break is a closed interval (write gate)", () => {
  // Tuesday Nov 17: break 22:00→23:00 UTC (17:00-18:00 EST)
  const ivs = closedIntervals("XAUUSD", T("2026-11-17T00:00:00Z"), T("2026-11-18T00:00:00Z"));
  const brk = ivs.find((iv) => iv.from === T("2026-11-17T22:00:00Z"));
  assert.ok(brk, "metals daily break interval must exist");
  const g = dropClosedAnchors([{ time: T("2026-11-17T22:30:00Z") }], ivs);
  assert.equal(g.dropped, 1);
});

test("P31 · filterClosedCandles on forex minutes mirrors dropClosedAnchors", () => {
  const bars = [
    { time: T("2026-11-20T21:59:00Z"), open: 1, high: 1, low: 1, close: 1 },
    { time: T("2026-11-21T08:00:00Z"), open: 1, high: 1, low: 1, close: 1 }, // Sat poison
    { time: T("2026-11-22T22:01:00Z"), open: 1, high: 1, low: 1, close: 1 },
  ];
  const out = filterClosedCandles("EURUSD", bars);
  assert.equal(out.length, 2);
  assert.equal(out[0].time, bars[0].time);
  assert.equal(out[1].time, bars[2].time);
});

test("P31 · foldWeekComplete refuses weeks with a missing weekday", () => {
  const mk = (iso: string) => iso.slice(0, 10);
  // Week of Mon Nov 16 2026 (bucket = 2026-11-16T00:00:00Z)
  const full = new Set([16, 17, 18, 19, 20].map((d) => mk(`2026-11-${String(d).padStart(2, "0")}T00:00:00Z`)));
  assert.equal(foldWeekComplete(full, T("2026-11-16T00:00:00Z"), T("2026-11-23T06:00:00Z")), true); // week over
  const hole = new Set([16, 17, 19, 20].map((d) => mk(`2026-11-${String(d).padStart(2, "0")}T00:00:00Z`))); // Wed missing
  assert.equal(foldWeekComplete(hole, T("2026-11-16T00:00:00Z"), T("2026-11-23T06:00:00Z")), false);
  // CURRENT live week (now = Wednesday): never folds — the live engine owns it
  const partial = new Set([23, 24].map((d) => mk(`2026-11-${String(d).padStart(2, "0")}T00:00:00Z`))); // Mon+Tue
  assert.equal(foldWeekComplete(partial, T("2026-11-23T00:00:00Z"), T("2026-11-25T12:00:00Z")), false);
});

test("P31 · weekend poison shape: static Sat rows are detectable and droppable", () => {
  // The live-verified XAUUSD poison: ~1440 flat rows on Saturday.
  const satRows = Array.from({ length: 1440 }, (_, i) => ({ time: T("2026-11-14T00:00:00Z") + i * 60 }));
  const openRows = [{ time: T("2026-11-13T21:59:00Z") }, { time: T("2026-11-15T23:30:00Z") }]; // Fri tail + Sun open
  const ivs = closedIntervals("XAUUSD", T("2026-11-13T00:00:00Z"), T("2026-11-16T00:00:00Z"));
  const g = dropClosedAnchors([...satRows, ...openRows], ivs);
  assert.equal(g.dropped, 1440);
  assert.deepEqual(g.bars.map((b) => b.time), openRows.map((b) => b.time));
});
