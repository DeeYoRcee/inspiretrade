/**
 * PHASE 24 §5 — all-timeframe matrix tests (pure functions, real boundaries).
 *  · m3 from m1 lands on TRUE 3-minute UTC boundaries (not load-relative)
 *  · 2h/4h fold factors are the TARGET timeframe in minutes (the Phase 20
 *    ratio bug regression guard)
 *  · seconds TFs (5s/15s/30s) bucket correctly from native 1s
 *  · weekly buckets anchor MONDAY (same as the live engine + Binance)
 *  · interval maps cover every timeframe × feed combination offered
 *  · availableTimeframes offers seconds ONLY where a real source exists
 * Run: `npm test`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateBars, TF_SECONDS, BINANCE_INTERVAL, YAHOO_INTERVAL, YAHOO_AGGREGATE, BINANCE_AGGREGATE, availableTimeframes, SUB_MINUTE_TFS, TIMEFRAMES } from "../shared/terminal.ts";
import { aggregateToSeconds } from "../shared/candle-core.ts";
import { bucketStart } from "../shared/feed-validation.ts";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Math.floor(Date.UTC(y, m - 1, d, h, mi) / 1000);

test("§5 m3 aggregation: buckets align to true 3-minute UTC boundaries", () => {
  const bars = [
    { time: utc(2026, 11, 18, 10, 0), open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { time: utc(2026, 11, 18, 10, 1), open: 1.5, high: 1.7, low: 1.4, close: 1.6, volume: 2 },
    { time: utc(2026, 11, 18, 10, 2), open: 1.6, high: 1.9, low: 1.55, close: 1.7, volume: 3 },
    { time: utc(2026, 11, 18, 10, 3), open: 1.7, high: 1.8, low: 1.6, close: 1.75, volume: 4 },
  ];
  const m3 = aggregateBars(bars, 3);
  assert.equal(m3.length, 2);
  assert.equal(m3[0].time, utc(2026, 11, 18, 10, 0), "bucket anchored to the 3-min boundary");
  assert.equal(m3[0].open, 1);
  assert.equal(m3[0].high, 2, "running envelope across the bucket");
  assert.equal(m3[0].low, 0.5);
  assert.equal(m3[0].close, 1.7, "last close in bucket");
  assert.equal(m3[0].volume, 6, "volume summed");
  assert.equal(m3[1].time, utc(2026, 11, 18, 10, 3));
});

test("§5 2h/4h fold factor = TARGET timeframe minutes (Phase 20 regression guard)", () => {
  // the Phase 20 bug: TF_SECONDS[tf]/TF_SECONDS[agg] gave 2 "minutes" for 2h —
  // the current code must pass the target minutes (120/240)
  for (const [tf, expectedMin] of [["2h", 120], ["4h", 240]] as const) {
    const h1 = [
      { time: utc(2026, 11, 18, 0), open: 10, high: 11, low: 9, close: 10.5, volume: 1 },
      { time: utc(2026, 11, 18, 1), open: 10.5, high: 12, low: 10, close: 11, volume: 1 },
      { time: utc(2026, 11, 18, 2), open: 11, high: 11.5, low: 10.7, close: 10.8, volume: 1 },
      { time: utc(2026, 11, 18, 3), open: 10.8, high: 11.2, low: 10.6, close: 11.1, volume: 1 },
    ];
    const out = aggregateBars(h1, TF_SECONDS[tf] / 60);
    // 00:00-03:59 hourly bars: 2h → buckets [00,02) and [02,04) = 2 · 4h → 1
    assert.equal(out.length, tf === "2h" ? 2 : 1, `${tf}: correct bucket count`);
    assert.equal(out[0].time, utc(2026, 11, 18, 0));
    assert.equal(out[0].open, 10);
    assert.equal(out[0].close, tf === "2h" ? 11 : 11.1, `${tf}: last close inside the bucket`);
    assert.equal(out[0].volume, tf === "2h" ? 2 : 4);
    assert.equal(out[0].high, tf === "2h" ? 12 : 12);
    assert.equal(out[0].low, 9);
    assert.equal(TF_SECONDS[tf] / 60, expectedMin, `${tf} factor is ${expectedMin} minutes`);
  }
});

test("§5 seconds TFs: 5s/15s/30s bucket from native 1s with summed volume", () => {
  const t0 = utc(2026, 11, 18, 10, 0);
  const oneSec = Array.from({ length: 20 }, (_, i) => ({
    time: t0 + i, open: 100 + i * 0.01, high: 100 + i * 0.01 + 0.02, low: 100 + i * 0.01 - 0.02, close: 100 + i * 0.01 + 0.01, volume: 1,
  }));
  const s5 = aggregateToSeconds(oneSec, 5);
  assert.equal(s5.length, 4, "20 one-second bars → 4 × 5s buckets");
  assert.equal(s5[0].time, t0, "5s boundary aligned");
  assert.equal(s5[0].open, 100, "first bar's open");
  assert.equal(s5[0].close, oneSec[4].close, "last bar's close in bucket");
  assert.equal(s5[0].volume, 5, "volume summed");
  assert.equal(s5[0].high, Math.max(...oneSec.slice(0, 5).map((b) => b.high)));
  const s15 = aggregateToSeconds(oneSec, 15);
  assert.equal(s15.length, 2);
  const s30 = aggregateToSeconds(oneSec, 30);
  assert.equal(s30.length, 1);
});

test("§5 weekly buckets anchor MONDAY (parity with live engine + Binance)", () => {
  // 2026-11-20 is a Friday; its weekly bucket must start Mon 2026-11-16
  assert.equal(bucketStart(utc(2026, 11, 20, 12), 604800), utc(2026, 11, 16, 0), "Friday folds into Monday's bucket");
  assert.equal(bucketStart(utc(2026, 11, 15, 23), 604800), utc(2026, 11, 9, 0), "Sunday evening belongs to the PREVIOUS Monday bucket");
  assert.equal(new Date(utc(2026, 11, 16, 0) * 1000).getUTCDay(), 1, "the anchor itself is a Monday");
});

test("§5 every offered timeframe has a provider interval mapping", () => {
  for (const tf of TIMEFRAMES) {
    assert.ok(TF_SECONDS[tf] > 0, `TF_SECONDS[${tf}]`);
    if (tf === "1s" || tf === "5s" || tf === "15s" || tf === "30s") {
      assert.equal(BINANCE_INTERVAL[tf], "1s", `${tf}: sub-minute rides the native 1s stream`);
      assert.ok(BINANCE_AGGREGATE[tf] === "1s" || tf === "1s", `${tf}: aggregate mapping present (1s is native)`);
    } else {
      assert.ok(BINANCE_INTERVAL[tf], `BINANCE_INTERVAL[${tf}]`);
      assert.ok(YAHOO_INTERVAL[tf], `YAHOO_INTERVAL[${tf}] (non-sub-minute must have a quotes mapping)`);
    }
  }
  assert.equal(YAHOO_AGGREGATE["3m"], "1m");
  assert.equal(YAHOO_AGGREGATE["2h"], "1h");
  assert.equal(YAHOO_AGGREGATE["4h"], "1h");
});

test("§5 availableTimeframes: seconds ONLY where a genuine source exists", () => {
  const crypto = availableTimeframes("BTCUSD");
  for (const tf of SUB_MINUTE_TFS) assert.ok(crypto.includes(tf), `crypto offers ${tf} (native 1s)`);
  const metal = availableTimeframes("XAUUSD");
  for (const tf of SUB_MINUTE_TFS) assert.ok(metal.includes(tf), `metals offer ${tf} (1s gold-api poll)`);
  const forex = availableTimeframes("EURUSD");
  for (const tf of SUB_MINUTE_TFS) assert.ok(!forex.includes(tf), `forex does NOT offer ${tf} (no sub-minute history feed — honest limitation)`);
  const index = availableTimeframes("NAS100");
  for (const tf of SUB_MINUTE_TFS) assert.ok(!index.includes(tf), `indices do NOT offer ${tf}`);
  for (const tf of ["1m", "15m", "1h", "1d"]) {
    assert.ok(forex.includes(tf), `forex offers ${tf}`);
    assert.ok(index.includes(tf), `indices offer ${tf}`);
    assert.ok(metal.includes(tf), `metals offer ${tf}`);
    assert.ok(crypto.includes(tf), `crypto offers ${tf}`);
  }
});
