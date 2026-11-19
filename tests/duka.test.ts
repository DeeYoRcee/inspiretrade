/**
 * Phase 17 — Dukascopy bi5 decoder tests.
 * Builds a synthetic day file with lzma-native (same LZMA-alone format the
 * datafeed serves, verified 2026-11-19 against real EURUSD/USDJPY files)
 * and asserts the parse: point factors (1e5 forex / 1e3 JPY-quote), absolute
 * UTC minute timestamps, envelope validation and flat zero-volume filler
 * minutes dropped. Run: node --test tests/duka.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compress } from "lzma-native";
import { decodeDukaDay, dukaPoints, DUKA_MAP } from "../api/_src/lib/duka.ts";

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

test("duka: catalog is forex-only and covers every non-metal forex pair", () => {
  assert.equal(DUKA_MAP.XAUUSD, undefined); // metals ride the spot engine + TD
  assert.equal(DUKA_MAP.EURUSD, "EURUSD");
  assert.equal(DUKA_MAP.USDTRY, "USDTRY");
  assert.equal(Object.keys(DUKA_MAP).length >= 34, true);
});

test("duka: point factors — JPY-quote pairs 1e3, the rest 1e5", () => {
  assert.equal(dukaPoints("EURUSD"), 1e5);
  assert.equal(dukaPoints("GBPJPY"), 1e3);
  assert.equal(dukaPoints("USDJPY"), 1e3);
  assert.equal(dukaPoints("USDTRY"), 1e5);
});

test("duka: decodeDukaDay parses prices, scales and drops fillers", async () => {
  const day = new Date(Date.UTC(2026, 10, 17)); // Nov 17 2026
  const dayStart = Math.floor(day.getTime() / 1000);
  const rec = (sec: number, o: number, h: number, l: number, c: number, v: number): [number, number, number, number, number, number] =>
    [sec, o, h, l, c, v];
  const buf = await bi5([
    rec(0, 109970, 110000, 109950, 109980, 125.5), // EURUSD 1.09970 @ 00:00
    rec(60, 109980, 110020, 109960, 110010, 0), // real minute, flat price but traded
    rec(120, 109990, 109990, 109990, 109990, 0), // filler minute — dropped
    rec(180, 110000, 110050, 109970, 110040, 88.25),
  ]);
  const bars = await decodeDukaDay(buf, "EURUSD", day);
  assert.equal(bars.length, 3);
  assert.equal(bars[0].t, dayStart);
  assert.ok(Math.abs(bars[0].o - 1.0997) < 1e-9);
  assert.ok(Math.abs(bars[1].c - 1.1001) < 1e-9);
  assert.equal(bars[1].t, dayStart + 60);
  assert.ok(Math.abs(bars[2].v - 88.25) < 0.01);
});

test("duka: JPY-quote prices scale by 1e3", async () => {
  const day = new Date(Date.UTC(2026, 10, 17));
  const buf = await bi5([[0, 159525, 159540, 159500, 159530, 817.7]]);
  const bars = await decodeDukaDay(buf, "USDJPY", day);
  assert.equal(bars.length, 1);
  assert.ok(Math.abs(bars[0].o - 159.525) < 1e-9);
});

test("duka: corrupt input yields an empty array, never a throw", async () => {
  const bars = await decodeDukaDay(Buffer.from("not-lzma-at-all"), "EURUSD", new Date());
  assert.deepEqual(bars, []);
});
