/**
 * Phase 28 — data-integrity tests for the two production defects fixed here:
 *
 *  · XAUUSD "history starts Oct 22": the spot-history 30-day read wall is
 *    gone (server folds the FULL recorded store to the requested tf), and a
 *    stooq-SPOT-daily layer guarantees genuine daily history for metals
 *    1d/1W/1M charts.
 *  · EURUSD D1 poisoned candle (H=1.16023 on 2026-11-21 — a mid-2025 price
 *    from a truncated TrueFX big-figure row, inflated by monotonic max() and
 *    invisible to every OHLC check): shared repairOutlierExtremes + the
 *    TrueFX ingest guards (structure + per-pair jump).
 *
 * Run: node --test tests/phase28-data-integrity.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repairOutlierExtremes, staleRunFilter, bucketStart, type RawBar,
} from "../shared/feed-validation.ts";
import { parseTrueFxRow, TRUEFX_BIG_FIGURE_RE } from "../api/_src/lib/truefx.ts";

const bar = (time: number, open: number, high: number, low: number, close: number): RawBar =>
  ({ time, open, high, low, close });

// ---------------------------------------------------------------------------
// repairOutlierExtremes — the foreign-price wick repair
// ---------------------------------------------------------------------------

test("P28 repair: EURUSD poisoned daily wick (the 2026-11-21 case) is narrowed to the body", () => {
  // 6 real November-2026 daily bars (Yahoo-verified levels) + the poisoned
  // last candle: O/L/C at the real level, H inflated to a mid-2025 price
  const bars: RawBar[] = [
    bar(1, 1.09912, 1.09975, 1.09545, 1.09929),
    bar(2, 1.09719, 1.1012, 1.09564, 1.0972),
    bar(3, 1.09709, 1.16023, 1.09613, 1.09647), // H = 1.16023 ← foreign price
    bar(4, 1.0975, 1.1005, 1.0961, 1.0997),
    bar(5, 1.0997, 1.1032, 1.099, 1.10249),
    bar(6, 1.10262, 1.10314, 1.1001, 1.10249),
  ];
  const r = repairOutlierExtremes(bars);
  assert.equal(r.repairedHigh, 1);
  assert.equal(r.repairedLow, 0);
  // the impossible wick is gone; the truthful body envelope remains
  assert.equal(r.bars[2].high, Math.max(1.09709, 1.09647));
  assert.equal(r.bars[2].open, 1.09709);
  assert.equal(r.bars[2].close, 1.09647);
  // genuine neighbouring bars untouched
  assert.equal(r.bars[1].high, 1.1012);
  assert.equal(r.bars[4].high, 1.1032);
});

test("P28 repair: a REAL crash day keeps its genuine extremes", () => {
  // gold 2013-style: −9% close-to-close — the body disagrees with the
  // neighbourhood, so the wick check must NOT touch it
  const bars: RawBar[] = [
    bar(1, 1480, 1489, 1475, 1483),
    bar(2, 1481, 1491, 1476, 1487),
    bar(3, 1455, 1492, 1431, 1359), // real crash bar: body FAR from neighbours
    bar(4, 1358, 1368, 1349, 1361),
    bar(5, 1361, 1372, 1355, 1366),
  ];
  const r = repairOutlierExtremes(bars);
  assert.equal(r.repairedHigh, 0);
  assert.equal(r.repairedLow, 0);
  assert.equal(r.bars[2].high, 1492);
  assert.equal(r.bars[2].low, 1431);
});

test("P28 repair: poisoned LOW is raised to the body (mirror case)", () => {
  const bars: RawBar[] = [
    bar(1, 1.099, 1.1005, 1.0961, 1.0997),
    bar(2, 1.0997, 1.1032, 1.099, 1.10249),
    bar(3, 1.10262, 1.10314, 0.80013, 1.10249), // L from another era
    bar(4, 1.10249, 1.105, 1.101, 1.1041),
    bar(5, 1.1041, 1.1062, 1.103, 1.1052),
  ];
  const r = repairOutlierExtremes(bars);
  assert.equal(r.repairedLow, 1);
  assert.equal(r.repairedHigh, 0);
  assert.equal(r.bars[2].low, Math.min(1.10262, 1.10249));
});

test("P28 repair: the LAST bar (no right neighbour) is repaired from the left alone", () => {
  const bars: RawBar[] = [
    bar(1, 1.09719, 1.1012, 1.09564, 1.0972),
    bar(2, 1.09709, 1.10023, 1.09613, 1.09757),
    bar(3, 1.0975, 1.1005, 1.0961, 1.0997),
    bar(4, 1.0997, 1.1032, 1.099, 1.10249),
    bar(5, 1.09709, 1.16023, 1.09613, 1.09647), // live tail, poisoned wick
  ];
  const r = repairOutlierExtremes(bars);
  assert.equal(r.repairedHigh, 1);
  assert.equal(r.bars[4].high, 1.09709);
});

test("P28 repair: short series and quiet-but-honest candles stay untouched", () => {
  const few = [bar(1, 1.1, 1.102, 1.098, 1.101), bar(2, 1.101, 1.103, 1.099, 1.102)];
  const r = repairOutlierExtremes(few);
  assert.equal(r.repairedHigh + r.repairedLow, 0);
  // a quiet series (median Δ≈0.001 → K = 1.2% floor): a 3% wick beyond both
  // neighbours with a body inside the envelope is foreign — repaired
  const bars: RawBar[] = [
    bar(1, 100, 100.3, 99.7, 100.1),
    bar(2, 100.1, 100.4, 99.8, 100.2),
    bar(3, 100.2, 104.0, 99.9, 100.3), // +3.7% wick, body quiet
    bar(4, 100.3, 100.6, 100.0, 100.4),
    bar(5, 100.4, 100.7, 100.1, 100.5),
  ];
  const r2 = repairOutlierExtremes(bars);
  assert.equal(r2.repairedHigh, 1);
  assert.equal(r2.bars[2].high, 100.3);
});

// ---------------------------------------------------------------------------
// TrueFX ingest guards — the source of the poisoned price
// ---------------------------------------------------------------------------

const ROW_OK = ["EUR/USD", "1763688000000", "1.09", "64321", "1.09", "65432", "1.09", "1.10", "1.05"];

test("P28 truefx: normal rows parse (4-figure and JPY-style big figures)", () => {
  const ok = parseTrueFxRow(ROW_OK);
  assert.ok(ok);
  assert.equal(ok!.code, "EURUSD");
  assert.equal(ok!.quote.bid, 1.0964321);
  assert.equal(ok!.quote.ask, 1.0965432);
  assert.ok(Math.abs(ok!.quote.mid - (ok!.quote.bid + ok!.quote.ask) / 2) < 1e-12);
  const jpy = parseTrueFxRow(["USD/JPY", "1763688000000", "159.", "89012", "159.", "91234", "159.", "160", "155"]);
  assert.ok(jpy);
  assert.equal(jpy!.quote.bid, 159.89012);
});

test("P28 truefx: the TRUNCATED big-figure row that produced H=1.16023 is refused", () => {
  // "1.1" + "6023" string-concats to 1.16023 — a mid-2025 EUR/USD price
  const glitched = ["EUR/USD", "1763688000000", "1.1", "6023", "1.1", "6123", "1.1", "1.1", "1.05"];
  const r = parseTrueFxRow(glitched);
  assert.equal(r, null);
  assert.ok(!TRUEFX_BIG_FIGURE_RE.test("1.1"));
  assert.ok(TRUEFX_BIG_FIGURE_RE.test("1.09"));
  assert.ok(TRUEFX_BIG_FIGURE_RE.test("159."));
});

test("P28 truefx: jump guard refuses a >1.5% inter-snapshot move, accepts normal drift", () => {
  const base = { lastGood: { EURUSD: 1.0965 }, lastGoodAt: { EURUSD: Date.now() - 1000 }, nowMs: Date.now() };
  const drift = parseTrueFxRow(ROW_OK, base); // 1.0964321 vs 1.0965 → +0.006%
  assert.ok(drift);
  const spike = ["EUR/USD", "1763688000000", "1.12", "20001", "1.12", "21001", "1.12", "1.13", "1.05"]; // +2.3%
  assert.equal(parseTrueFxRow(spike, base), null);
  // fresh pair with no baseline: accepted (the first snapshot seeds it)
  assert.ok(parseTrueFxRow(spike, {}));
});

test("P28 truefx: the guard releases after 5 minutes without an accepted quote", () => {
  const stale = {
    lastGood: { EURUSD: 1.0965 },
    lastGoodAt: { EURUSD: Date.now() - 300001 },
    nowMs: Date.now(),
  };
  const spike = ["EUR/USD", "1763688000000", "1.12", "20001", "1.12", "21001", "1.12", "1.13", "1.05"];
  const r = parseTrueFxRow(spike, stale);
  assert.ok(r, "a genuine regime move must eventually win over a frozen baseline");
  assert.equal(r!.quote.bid, 1.1220001);
});

// ---------------------------------------------------------------------------
// Deep-history layers
// ---------------------------------------------------------------------------

test("P28 weekly bucket anchor: Monday UTC (the fold used by the metals weekly layer)", () => {
  // 2026-11-16 (Mon) 00:00 UTC
  const monday = 1794787200;
  assert.equal(bucketStart(monday + 3 * 86400, 604800), monday, "a Thursday stamp folds back to its Monday");
  assert.equal(bucketStart(monday + 7 * 86400, 604800), monday + 7 * 86400, "the next week starts on the next Monday");
});

test("P28 layer priority: later layers win per bucket without duplication", () => {
  // mirrors the byTime merge used by loadRecordedSpot for hourly+ layers
  const layer1 = [bar(100, 1, 2, 0.5, 1.5), bar(200, 2, 3, 1.5, 2.5)];
  const layer2 = [bar(200, 2.1, 3.1, 1.9, 2.9)]; // conflicts with layer1's 200
  const byTime = new Map<number, RawBar>();
  for (const b of layer1) byTime.set(b.time, b);
  for (const b of layer2) byTime.set(b.time, b);
  const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
  assert.equal(merged.length, 2, "conflicting timestamps collapse into one bar");
  assert.equal(merged[1].open, 2.1, "the later layer wins the bucket");
});


// ---------------------------------------------------------------------------
// Phase 29 — frozen-provider run filter (the 1H/1M flat plateaus)
// ---------------------------------------------------------------------------

// helper: one recorded minute (dot candle — O=H=L=C, the normal recorder
// output when gold-api publishes fewer than one distinct price per minute)
const dot = (t: number, price: number): RawBar => ({ time: t, open: price, high: price, low: price, close: price });

test("P29 stale-run: the freeze-and-left plateau (3875/3533 defect) is rejected", () => {
  const bars: RawBar[] = [];
  let t = 0;
  // 20 moving minutes (the market is alive — steps 0.1-0.3%)
  let px = 3550;
  for (let k = 0; k < 20; k++) { px *= 1 + (k % 2 ? 0.002 : -0.0015); bars.push(dot(t, px)); t += 60; }
  // 60 minutes FROZEN at one level (gold-api stuck, fresh stamp)
  const frozen = px;
  for (let k = 0; k < 60; k++) { bars.push(dot(t, frozen)); t += 60; }
  // exit step +0.17%, never returns within 30+ min
  const live = frozen * 1.0017;
  for (let k = 0; k < 40; k++) { bars.push(dot(t, live)); t += 60; }
  const r = staleRunFilter(bars);
  assert.equal(r.rejected, 60, "the whole frozen run is dropped");
  assert.equal(r.ranges.length, 1);
  assert.equal(r.bars.length, bars.length - 60);
  // the moving bars and the live tail survive
  assert.equal(r.bars[0].close, bars[0].close);
  assert.equal(r.bars[r.bars.length - 1].close, live);
});

test("P29 stale-run: smooth recorded-dot drift is NEVER rejected", () => {
  const bars: RawBar[] = [];
  let t = 0;
  let px = 3530;
  for (let k = 0; k < 200; k++) { px *= 1 + 0.0003; bars.push(dot(t, px)); t += 60; } // drift ≤ flatPct
  const r = staleRunFilter(bars);
  assert.equal(r.rejected, 0, "no exit step, no aliveness — nothing to reject");
});

test("P29 stale-run: provider-OHLC minutes (real ranges) never match the flat run", () => {
  const bars: RawBar[] = [];
  let t = 0;
  let px = 1.095;
  for (let k = 0; k < 150; k++) {
    px *= 1 + (k % 5 === 0 ? 0.0012 : 0.0001);
    bars.push({ time: t, open: px, high: px * 1.0006, low: px * 0.9994, close: px * (1 + (k % 3 - 1) * 0.0002) });
    t += 60;
  }
  const r = staleRunFilter(bars);
  assert.equal(r.rejected, 0);
});

test("P29 stale-run: a run whose level is revisited within the confirm window is kept", () => {
  const bars: RawBar[] = [];
  let t = 0;
  let px = 100;
  for (let k = 0; k < 20; k++) { px *= 1 + 0.003; bars.push(dot(t, px)); t += 60; }
  const frozen = px;
  for (let k = 0; k < 50; k++) { bars.push(dot(t, frozen)); t += 60; }
  const up = frozen * 1.002;
  for (let k = 0; k < 10; k++) { bars.push(dot(t, up)); t += 60; }       // exit step
  for (let k = 0; k < 40; k++) { bars.push(dot(t, frozen)); t += 60; }   // RETURNS to the level
  const r = staleRunFilter(bars);
  assert.equal(r.rejected, 0, "a revisited level is a real market, not a frozen feed");
});
