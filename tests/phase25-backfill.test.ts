/**
 * Phase 25 — forex & metals data engine repair tests.
 *
 * Covers the mandatory §10 matrix that is testable without live RTDB:
 *  · §3 cap lift: intraday backfill depth reaches the full genuine range
 *    (240 months) with clamp safety (absurd values bounded, unknown tf → 12)
 *  · depth window math: 240 months reaches Dukascopy's 2010 era
 *  · §2 metals on Dukascopy: map + point factor + decoder scaling
 *  · §4 close-only honesty: shared flatShare (0 genuine / 1 close-only /
 *    mixed), read-agg chain folds from 1m shards, window guard
 *  · §5/§6 provider coverage: every terminal forex/metals symbol has a
 *    genuine-OHLC history source mapped (Dukascopy or stooq spot)
 *  · §6/§10 continuity: aggregateBars(1m→3m) ∪ live-tail upsert stays
 *    sorted, deduped, envelope-valid; duplicate/invalid rejection counted
 *  · crypto regression guard: Binance fold/aggBar untouched behavior via
 *    the shared aggregateBars used by the crypto engine
 * Run: node --test tests/phase25-backfill.test.ts (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HIST_MONTHS_CAP, clampBackfillMonths, backfillWindowFrom, READ_AGG_CHAIN, MAX_1M_FOLD_WINDOW_SEC, missingIntervals } from "../api/_src/lib/hist-sessions.ts";
import { DUKA_MAP, DUKA_METALS, dukaPoints, decodeDukaDay } from "../api/_src/lib/duka.ts";
import { flatShare, validateBars, alignAndDedupe, type RawBar } from "../shared/feed-validation.ts";
import { aggregateBars } from "../shared/terminal.ts";
import { compress } from "lzma-native";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Math.floor(Date.UTC(y, m - 1, d, h, mi) / 1000);

// ---------- §3 cap lift + clamp safety --------------------------------------

test("phase25 §3: intraday caps reach the full genuine depth (≥240 months)", () => {
  for (const tf of ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"]) {
    assert.ok((HIST_MONTHS_CAP[tf] ?? 0) >= 240, `${tf} cap ${HIST_MONTHS_CAP[tf]} must cover 2010-era Dukascopy depth`);
  }
});

test("phase25 §3: clampBackfillMonths bounds absurd requests, keeps honest ones", () => {
  assert.equal(clampBackfillMonths(undefined, "1m"), 240, "default = full depth");
  assert.equal(clampBackfillMonths(36, "1m"), 36, "honest request passes");
  assert.equal(clampBackfillMonths(9999, "1m"), 240, "absurd request clamped to cap");
  assert.equal(clampBackfillMonths(-5, "1m"), 240, "negative → default");
  assert.equal(clampBackfillMonths(Number.NaN, "1m"), 240, "NaN → default");
  assert.equal(clampBackfillMonths(3, "3m"), 3, "unknown tf falls back to 12-month default cap");
  assert.equal(clampBackfillMonths(9999, "7m"), 12, "unknown tf clamps to its 12-month default");
});

test("phase25 §3: 240-month window reaches Dukascopy's 2010 era", () => {
  const now = utc(2026, 11, 20);
  const from = backfillWindowFrom(240, now);
  const years = (now - from) / (365.25 * 86400);
  assert.ok(years > 19.5 && years < 20.5, `240 months ≈ 20 years, got ${years.toFixed(2)}`);
  assert.ok(from <= utc(2010, 12, 31), "target reaches before the end of 2010");
});

// ---------- §2 metals on Dukascopy ------------------------------------------

test("phase25 §2: metals mapped on the Dukascopy feed with 1e3 points", () => {
  assert.equal(DUKA_METALS.XAUUSD, "XAUUSD");
  assert.equal(DUKA_METALS.XAGUSD, "XAGUSD");
  assert.equal(DUKA_MAP.XAUUSD, undefined, "metals must stay OUT of the forex map (identity separation)");
  assert.equal(dukaPoints("XAUUSD"), 1e3);
  assert.equal(dukaPoints("XAGUSD"), 1e3);
});

function bi5(records: Array<[number, number, number, number, number, number]>): Promise<Buffer> {
  const raw = Buffer.alloc(records.length * 24);
  records.forEach((r, i) => {
    raw.writeInt32BE(r[0], i * 24);
    raw.writeInt32BE(r[1], i * 24 + 4);
    raw.writeInt32BE(r[2], i * 24 + 8);
    raw.writeInt32BE(r[3], i * 24 + 12);
    raw.writeInt32BE(r[4], i * 24 + 16);
    raw.writeFloatBE(r[5], i * 24 + 20);
  });
  return new Promise((resolve) => compress(raw, (out) => resolve(Buffer.isBuffer(out) ? out : Buffer.from(out as string))));
}

test("phase25 §2: decoder scales genuine gold prices (1710.758 spot) and keeps OHLC", async () => {
  const day = new Date("2020-06-15T00:00:00Z");
  const base = Math.round(1710.758 * 1e3); // gold at ×1e3 points
  // REAL bi5 layout (Phase 25): [t, O, C, L, H, vol] — verified against a
  // clean 2020-06-15 file; the old (O,H,L,C) assumption rejected ~94% of bars
  const records: Array<[number, number, number, number, number, number]> = [
    [0, base, base + 45, base - 90, base + 120, 3.25],       // 00:00 genuine
    [60, base + 45, base + 180, base + 30, base + 200, 1.5], // 00:01
    [120, base + 180, base + 180, base + 180, base + 180, 0],// 00:02 flat filler → dropped
  ];
  const buf = await bi5(records);
  const bars = await decodeDukaDay(buf, "XAUUSD", day);
  assert.equal(bars.length, 2, "flat zero-volume filler dropped");
  assert.equal(bars[0].t, utc(2020, 6, 15, 0, 0), "absolute UTC minute stamp");
  assert.equal(Math.round(bars[0].o * 1000) / 1000, 1710.758, "open decodes to the real spot price");
  assert.equal(Math.round(bars[0].c * 1000) / 1000, 1710.803, "close decodes from the C field");
  assert.equal(Math.round(bars[0].h * 1000) / 1000, 1710.878, "high decodes from the H field");
  assert.ok(bars[0].h >= Math.max(bars[0].o, bars[0].c) && bars[0].l <= Math.min(bars[0].o, bars[0].c), "envelope preserved");
});

// ---------- §4 close-only honesty -------------------------------------------

test("phase25 §4: flatShare — 0 for genuine OHLC, 1 for close-only, honest mixed", () => {
  const genuine: RawBar[] = [
    { time: 60, open: 1.1, high: 1.2, low: 1.05, close: 1.15 },
    { time: 120, open: 1.15, high: 1.17, low: 1.13, close: 1.16 },
  ];
  const closeOnly: RawBar[] = [
    { time: 60, open: 1.1, high: 1.1, low: 1.1, close: 1.1 },
    { time: 120, open: 1.2, high: 1.2, low: 1.2, close: 1.2 },
  ];
  assert.equal(flatShare(genuine), 0);
  assert.equal(flatShare(closeOnly), 1);
  assert.equal(flatShare([...genuine, ...closeOnly]), 0.5, "mixed share is exact");
  assert.equal(flatShare([]), 0, "empty series → 0 (no false alarm)");
});

test("phase25 §4: read-agg chain folds 5m/15m/30m/1h from 1m shards, 2h/4h prefer 1h", () => {
  assert.deepEqual(READ_AGG_CHAIN["5m"], [{ src: "1m", factorMin: 5 }]);
  assert.deepEqual(READ_AGG_CHAIN["15m"], [{ src: "1m", factorMin: 15 }]);
  assert.deepEqual(READ_AGG_CHAIN["30m"], [{ src: "1m", factorMin: 30 }]);
  assert.deepEqual(READ_AGG_CHAIN["1h"], [{ src: "1m", factorMin: 60 }]);
  assert.deepEqual(READ_AGG_CHAIN["2h"][0], { src: "1h", factorMin: 120 }, "2h first folds the native 1h store");
  assert.deepEqual(READ_AGG_CHAIN["2h"][1], { src: "1m", factorMin: 120 }, "…then falls back to 1m shards");
  assert.deepEqual(READ_AGG_CHAIN["4h"][0], { src: "1h", factorMin: 240 });
  assert.deepEqual(READ_AGG_CHAIN["1W"], [{ src: "1d", factorMin: 10080 }]);
  assert.deepEqual(READ_AGG_CHAIN["1M"], [{ src: "1d", factorMin: 43200 }]);
  assert.equal(MAX_1M_FOLD_WINDOW_SEC, 90 * 86400, "1m folds bounded to 90-day windows");
});

test("phase25 §4: genuine 1m shards fold to 5m/15m/30m/1h with exact epoch alignment", () => {
  // 1 minute EURUSD BID bars (Dukascopy-style), 09:00–10:59 UTC
  const m1: RawBar[] = [];
  for (let t = utc(2026, 11, 18, 9); t < utc(2026, 11, 18, 11); t += 60) {
    const k = t / 60;
    const drift = Math.sin(k / 7) * 0.0008;
    const o = 1.085 + drift;
    const c = 1.085 + Math.sin((k + 1) / 7) * 0.0008;
    const h = Math.max(o, c) + 0.00035;
    const l = Math.min(o, c) - 0.00035;
    m1.push({ time: t, open: o, high: h, low: l, close: c, volume: 1 });
  }
  for (const [tf, factor] of [["5m", 5], ["15m", 15], ["30m", 30], ["1h", 60]] as Array<[string, number]>) {
    const folded = aggregateBars(m1, factor) as RawBar[];
    assert.ok(folded.length === 120 / factor, `${tf}: ${120 / factor} buckets`);
    for (const b of folded) {
      assert.equal(b.time % (factor * 60), 0, `${tf} bucket anchored to true UTC boundary`);
      assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close), `${tf} envelope valid`);
      assert.ok(b.high > b.low, `${tf} candles have real bodies, not dots`);
    }
  }
});

// ---------- §5/§6 provider coverage -----------------------------------------

test("phase25 §5: every terminal forex/metals symbol maps to a genuine-OHLC history source", () => {
  const FOREX = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
  for (const f of FOREX) {
    assert.ok(DUKA_MAP[f], `${f} missing from Dukascopy map`);
    assert.equal(dukaPoints(f), f.endsWith("JPY") ? 1e3 : 1e5, `${f} point factor matches its digits`);
  }
  for (const m of ["XAUUSD", "XAGUSD"]) {
    assert.ok(DUKA_METALS[m] || DUKA_MAP[m], `${m} has a metals history source`);
  }
});

// ---------- §6/§10 continuity + rejection -----------------------------------

test("phase25 §6: history ∪ live continuity — tail upsert merges, order/dedupe hold", () => {
  const m1: RawBar[] = [];
  for (let t = utc(2026, 11, 18, 13); t < utc(2026, 11, 18, 14); t += 60) {
    m1.push({ time: t, open: 2650 + (t % 600) / 1e5, high: 2650.9, low: 2649.9, close: 2650 + ((t + 60) % 600) / 1e5, volume: 1 });
  }
  const m3 = aggregateBars(m1, 3) as RawBar[];
  // live tail arrives for the CURRENT bucket — upsert must replace it in place
  const tail = { ...m3[m3.length - 1], close: m3[m3.length - 1].close + 0.5, high: m3[m3.length - 1].high + 0.5 };
  const merged = alignAndDedupe(validateBars([...m3.slice(0, -1), tail, m3[m3.length - 1]]).bars, 180);
  assert.equal(merged.bars.length, m3.length, "re-delivered tail does not duplicate");
  for (let i = 1; i < merged.bars.length; i++) {
    assert.ok(merged.bars[i].time > merged.bars[i - 1].time, "strictly ascending");
  }
  const last = merged.bars[merged.bars.length - 1];
  assert.equal(last.close, tail.close, "live tick survived the merge");
  assert.ok(last.high >= Math.max(last.open, last.close), "envelope still valid after merge");
});

test("phase25 §10: invalid candles are counted/rejected, never silently kept", () => {
  const t0 = utc(2026, 11, 18, 9);
  const mixed: RawBar[] = [
    { time: t0, open: 1.085, high: 1.086, low: 1.084, close: 1.0855 }, // valid
    { time: t0 + 60, open: 1.0855, high: 1.084, low: 1.087, close: 1.086 }, // h<l → dropped
    { time: t0 + 120, open: -1, high: 1.08, low: 1.09, close: 1.085 }, // non-positive → dropped
    { time: t0, open: 1.085, high: 1.086, low: 1.084, close: 1.0855 }, // duplicate of the first
  ];
  const checked = validateBars(mixed);
  const deduped = alignAndDedupe(checked.bars, 60);
  assert.equal(checked.invalid, 2, "inverted H/L + non-positive bars dropped and counted");
  assert.equal(deduped.bars.length, 1, "the re-delivered duplicate collapses into one bar");
  assert.equal(deduped.dropped, 1, "duplicate counted");
  assert.equal(deduped.bars[0].close, 1.0855, "the surviving bar keeps its genuine values");
});

test("phase25 §10: weekend gaps in backfilled history stay honest (no fabrication)", () => {
  // a Saturday hole between Fri 21:00 and Sun 22:00 must NOT be reported missing
  const bars: { time: number }[] = [];
  for (let t = utc(2026, 11, 20, 12); t <= utc(2026, 11, 23, 12); t += 60) {
    const d = new Date(t * 1000);
    const dow = d.getUTCDay();
    const closed = dow === 6 || (dow === 5 && d.getUTCHours() >= 21) || (dow === 0 && d.getUTCHours() < 22);
    if (!closed) bars.push({ time: t });
  }
  const scan = missingIntervals(bars, 60, utc(2026, 11, 20, 12), utc(2026, 11, 23, 12), "metal");
  assert.equal(scan.count, 0, "weekend closures are never 'missing' data");
});

// ---------- §7 crypto regression guard --------------------------------------

test("phase25 §7: crypto aggregation untouched — 1s→1m folds with real bodies", () => {
  const s1: RawBar[] = [];
  for (let t = utc(2026, 11, 20, 10); t < utc(2026, 11, 20, 10, 1); t += 1) {
    const p = 97000 + (t % 30) * 2;
    s1.push({ time: t, open: p, high: p + 3, low: p - 3, close: p + 1, volume: 0.1 });
  }
  // factorMin=1 → 60-second buckets (the crypto engine's 1s→1m fold)
  const m1 = aggregateBars(s1, 1) as RawBar[];
  assert.equal(m1.length, 1);
  assert.equal(m1[0].time, utc(2026, 11, 20, 10), "minute bucket epoch-aligned");
  assert.equal(m1[0].open, 97000, "open = first second");
  assert.equal(m1[0].close, 97000 + 29 * 2 + 1, "close = last second");
  assert.equal(m1[0].high, 97000 + 29 * 2 + 3, "high = max second high");
  assert.equal(m1[0].low, 96997, "low = min second low");
  assert.ok(m1[0].high > m1[0].low, "real body preserved — crypto stays candles");
});
