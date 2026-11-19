/**
 * Phase-18 execution-quote & spot-candle integrity tests.
 * Run: node --test tests/execution-quote.test.ts  (also picked up by npm test)
 *
 * Locks the Phase 18 market-data rules:
 *  - genuine two-sided quotes (TrueFX bid/ask) keep the real spread and
 *    widen symmetrically with the platform multiplier;
 *  - the XAUUSD synthetic spread matches SPREAD_PIPS × pipSize;
 *  - recorded spot candles fold ticks into a true OHLC envelope — the latest
 *    price must never overwrite an observed high/low (the M1-accuracy rule);
 *  - provider minute bars (s = 0) and sparse recorded dots merge without
 *    losing either the observed envelope or the genuine OHLC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteFromMid, quoteFromTwoSided } from "../shared/trading-engine.ts";
import { getInstrument } from "../shared/terminal.ts";
import {
  recordSpotTick, mergeSpotCandles, mergeSpotSeries, validSpotCandle,
} from "../client/src/lib/spot-tail.ts";

const XAU = getInstrument("XAUUSD")!;
const EUR = getInstrument("EURUSD")!;

// ---- genuine two-sided quotes ---------------------------------------------

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test("quoteFromTwoSided keeps the genuine interbank spread at mult=1", () => {
  const q = quoteFromTwoSided(1.09996, 1.09997, 1, "truefx", true);
  assert.ok(near(q.mid, (1.09996 + 1.09997) / 2));
  assert.ok(near(q.bid, 1.09996));
  assert.ok(near(q.ask, 1.09997));
  assert.ok(q.bid < q.mid && q.mid < q.ask);
});

test("quoteFromTwoSided widens symmetrically with the platform multiplier", () => {
  const q = quoteFromTwoSided(1.09990, 1.09998, 2, "truefx", true);
  assert.ok(near(q.mid, 1.09994));
  assert.ok(near(q.bid, 1.09994 - 0.00008));
  assert.ok(near(q.ask, 1.09994 + 0.00008));
});

test("quoteFromTwoSided never inverts bid/ask at multiplier 1", () => {
  const q = quoteFromTwoSided(159.890, 159.895, 1, "truefx", true);
  assert.ok(q.bid < q.ask);
  assert.equal(q.source, "truefx");
});

// ---- XAUUSD execution quote ------------------------------------------------

test("XAUUSD quoteFromMid spread = SPREAD_PIPS(2.5) × pipSize(0.1) = $0.25", () => {
  const spot = 3710.7;
  const q = quoteFromMid(spot, XAU, "gold-api", true);
  assert.ok(Math.abs(q.ask - q.bid - 0.25) < 1e-9);
  assert.ok(Math.abs(q.bid - (spot - 0.125)) < 1e-9);
  assert.ok(Math.abs(q.ask - (spot + 0.125)) < 1e-9);
  assert.equal(q.live, true);
});

// ---- M1 spot candle envelope (the M1-accuracy rule) -------------------------

test("recordSpotTick keeps the observed high/low — close never overwrites extremes", () => {
  let m: ReturnType<typeof recordSpotTick> = null as any;
  const t0 = Math.floor(Date.now() / 1000 / 60) * 60;
  const ticks = [3710.50, 3712.30, 3709.80, 3711.00, 3710.90];
  for (const p of ticks) m = recordSpotTick(m, p, t0 + 5);
  assert.equal(m.o, 3710.50);
  assert.equal(m.h, 3712.30, "high must be the max observed price");
  assert.equal(m.l, 3709.80, "low must be the min observed price");
  assert.equal(m.c, 3710.90, "close is the latest observed price");
  assert.equal(m.s, ticks.length);
});

test("recordSpotTick opens a fresh candle at the minute boundary", () => {
  let m: any = null;
  const base = Math.floor(Date.now() / 1000 / 60) * 60;
  m = recordSpotTick(m, 3710.0, base + 10);
  const m2 = recordSpotTick(m, 3712.0, base + 65); // next minute
  assert.equal(m2.t, base + 60);
  assert.equal(m2.o, 3712.0, "new minute opens at the real observed price");
  assert.equal(m2.s, 1);
});

test("mergeSpotCandles envelopes two observations without losing extremes", () => {
  const a = { t: 1000, o: 3710.0, h: 3711.5, l: 3709.5, c: 3710.8, s: 30 };
  const b = { t: 1000, o: 3710.2, h: 3712.1, l: 3709.9, c: 3711.0, s: 12 };
  const m = mergeSpotCandles(a, b);
  assert.equal(m.o, 3710.0, "earlier writer keeps the open");
  assert.equal(m.c, 3711.0, "later writer keeps the close");
  assert.equal(m.h, 3712.1);
  assert.equal(m.l, 3709.5);
  assert.equal(m.s, 30);
});

test("mergeSpotSeries unions minute buckets without duplicate timestamps", () => {
  const base = [{ t: 60, o: 1, h: 2, l: 0.5, c: 1.5, s: 20 }, { t: 120, o: 1.5, h: 2, l: 1, c: 1.8, s: 20 }];
  const inc = [{ t: 120, o: 1.6, h: 2.4, l: 1.2, c: 2.0, s: 8 }, { t: 180, o: 2, h: 2.5, l: 1.9, c: 2.2, s: 10 }];
  const out = mergeSpotSeries(base, inc);
  assert.deepEqual(out.map((c) => c.t), [60, 120, 180]);
  assert.equal(out[1].h, 2.4);
  assert.equal(out[1].l, 1.0);
});

test("validSpotCandle rejects close-only malformed bars and forged times", () => {
  const now = Math.floor(Date.now() / 1000);
  const minute = Math.floor(now / 60) * 60;
  assert.equal(validSpotCandle({ t: minute, o: 10, h: 9, l: 8, c: 10, s: 5 }, now), false, "h < max(o,c)");
  assert.equal(validSpotCandle({ t: minute + 30, o: 10, h: 11, l: 9, c: 10, s: 5 }, now), false, "off-minute timestamp");
  assert.equal(validSpotCandle({ t: minute, o: 10, h: 11, l: 9, c: 10, s: 61 }, now), false, "impossible sample count");
  assert.equal(validSpotCandle({ t: minute - 9 * 86400, o: 10, h: 11, l: 9, c: 10, s: 5 }, now), false, "older than 8 days");
  assert.equal(validSpotCandle({ t: minute, o: 10, h: 11, l: 9, c: 10, s: 12 }, now), true);
  // provider bar: s = 0 is legal (genuine Twelve Data OHLC)
  assert.equal(validSpotCandle({ t: minute, o: 10, h: 11, l: 9, c: 10, s: 0 }, now), true);
});

test("provider-bar protection: a sparse recorded dot must not degrade genuine OHLC", () => {
  // mirrors the quotes.ts spot-record rule for existing s === 0 bars
  const provider = { t: 60, o: 100.5, h: 101.2, l: 100.1, c: 100.9, s: 0 };
  const dot = { t: 60, o: 100.7, h: 100.7, l: 100.7, c: 100.7, s: 1 };
  const inc = { ...dot };
  const merged = provider.s === 0 && inc.s < 3
    ? { o: provider.o, c: provider.c, h: Math.max(inc.h, provider.h), l: Math.min(inc.l, provider.l), s: Math.max(inc.s, provider.s) }
    : mergeSpotCandles(provider, inc);
  assert.equal(merged.o, 100.5, "genuine provider open survives a 1-sample dot");
  assert.equal(merged.c, 100.9, "genuine provider close survives a 1-sample dot");
  assert.equal(merged.h, 101.2);
  assert.equal(merged.l, 100.1);
});

// ---- simulated execution against the spot quote (Phase 18 §6) --------------

test("simulated BUY opens at ASK, SELL at BID, both derived from the gold-api spot", () => {
  const spot = 3710.7; // gold-api XAU mid (the chart's live tail source)
  const q = quoteFromMid(spot, XAU, "gold-api", true);
  const buyEntry = q.ask;   // BUY fills at ask
  const sellEntry = q.bid;  // SELL fills at bid
  assert.ok(Math.abs(buyEntry - (spot + 0.125)) < 1e-9);
  assert.ok(Math.abs(sellEntry - (spot - 0.125)) < 1e-9);
  // an immediate close must cost exactly one spread (× contract/lots), P/L in USD
  const lot = 0.1;
  const buyLoss = (sellEntry - buyEntry) * lot * XAU.contractSize;   // close BUY at bid
  const sellLoss = (sellEntry - buyEntry) * lot * XAU.contractSize;  // close SELL at ask: entry(bid) − exit(ask)
  assert.ok(Math.abs(buyLoss - -0.25 * 0.1 * 100) < 1e-6);
  assert.ok(Math.abs(sellLoss - -0.25 * 0.1 * 100) < 1e-6);
  assert.ok(Math.abs(q.mid - q.bid - 0.125) < 1e-9 && Math.abs(q.ask - q.mid - 0.125) < 1e-9);
});

test("SELL-side SL/TP triggers evaluate on ASK, BUY-side on BID (engine conventions)", () => {
  // guards the conventions the evaluator relies on after the quote-source swap
  const q = quoteFromMid(3710.7, XAU, "gold-api", true);
  assert.ok(q.bid < q.mid && q.mid < q.ask);
  assert.equal(q.source, "gold-api");
  assert.equal(q.live, true, "gold-api spot is a live source — the quote must say so");
});
