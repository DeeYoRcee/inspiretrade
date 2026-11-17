/**
 * Phase 13 — instrument identity: the catalog maps every display symbol to
 * its GENUINE underlying market (no tokenized-gold substitutions), carries
 * the full identity metadata (name · session · precision · provider symbol)
 * and enforces a price-band sanity guard so another instrument's data can
 * never render silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTRUMENTS, getInstrument, TF_SECONDS,
  type InstrumentSpec, type Timeframe,
} from "../shared/terminal.ts";
import type { RawBar } from "../shared/feed-validation.ts";

// ---------------------------------------------------------------------------
// catalog completeness — every instrument carries the full identity block
// ---------------------------------------------------------------------------
test("every instrument has a complete identity block", () => {
  for (const inst of INSTRUMENTS) {
    assert.ok(inst.symbol, "symbol");
    assert.ok(inst.name && inst.name.length > 3, `${inst.symbol}: full name`);
    assert.ok(inst.session && inst.session.length > 3, `${inst.symbol}: session`);
    assert.ok(inst.priceBand && inst.priceBand[0] < inst.priceBand[1], `${inst.symbol}: price band`);
    assert.ok(inst.tickSize > 0, `${inst.symbol}: tick size`);
    assert.ok(["spot", "futures", "index"].includes(inst.underlier), `${inst.symbol}: underlier`);
    assert.ok(inst.digits >= 0 && inst.pipSize > 0 && inst.contractSize > 0, `${inst.symbol}: precision block`);
  }
});

// ---------------------------------------------------------------------------
// FORBIDDEN substitutions — tokenized gold / USDT FX pairs must never appear
// ---------------------------------------------------------------------------
test("no tokenized-gold or Tether substitutions anywhere in the catalog", () => {
  const FORBIDDEN = ["PAXGUSDT", "XAUTUSDT", "EURUSDT", "XAUT", "PAXG"];
  for (const inst of INSTRUMENTS) {
    const config = JSON.stringify(inst);
    for (const f of FORBIDDEN) {
      assert.ok(!config.includes(f), `${inst.symbol}: must not reference ${f}`);
    }
  }
  // XAUUSD specifically: charted via the quotes proxy with a gold-api spot code
  const gold = getInstrument("XAUUSD")!;
  assert.equal(gold.feed, "quotes");
  assert.equal(gold.underlier, "spot");
  assert.equal(gold.spotCode, "XAU");
  assert.equal(gold.name, "Gold Spot / U.S. Dollar");
});

// ---------------------------------------------------------------------------
// provider-symbol routing per asset class
// ---------------------------------------------------------------------------
test("provider symbols match the asset class exactly", () => {
  for (const inst of INSTRUMENTS) {
    if (inst.feed === "binance") {
      // crypto only — Binance quotes USDT pairs, disclosed in feedLabel
      assert.equal(inst.assetClass, "crypto", `${inst.symbol}: binance feed is crypto-only`);
      assert.ok(inst.binance?.endsWith("USDT"), `${inst.symbol}: binance symbol`);
      assert.ok(inst.feedLabel?.includes("USDT"), `${inst.symbol}: USDT basis disclosed`);
    } else if (inst.feed === "quotes") {
      assert.ok(inst.yahoo, `${inst.symbol}: yahoo symbol`);
      if (inst.assetClass === "forex") {
        assert.ok(inst.yahoo!.endsWith("=X"), `${inst.symbol}: genuine FX spot identifier`);
        assert.equal(inst.underlier, "spot");
      }
    }
  }
  // crypto majors exist with their standard pairs
  assert.equal(getInstrument("BTCUSD")?.binance, "BTCUSDT");
  assert.equal(getInstrument("ETHUSD")?.binance, "ETHUSDT");
});

// ---------------------------------------------------------------------------
// price-band sanity guard — wrong-instrument data is refused, never rendered
// ---------------------------------------------------------------------------
const specOf = (over: Partial<InstrumentSpec>): InstrumentSpec => ({
  symbol: "XAUUSD", name: "Gold Spot / U.S. Dollar", assetClass: "metal",
  digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes",
  yahoo: "GC=F", underlier: "spot", session: "24/5", tickSize: 0.01,
  priceBand: [1000, 20000], ...over,
});

test("assertPriceIdentity accepts genuine prices and rejects foreign data", async () => {
  const { assertPriceIdentity } = await import("../shared/feed-validation.ts");
  const bar = (close: number): RawBar => ({ time: 0, open: close, high: close, low: close, close, volume: 0 });
  const gold = specOf({});
  // genuine gold price → fine (empty array is also fine — nothing to check)
  assertPriceIdentity(gold, [bar(3856.25) as any]);
  assertPriceIdentity(gold, []);
  // silver (47) or EURUSD (1.10) arriving on the gold chart → loud refusal
  assert.throws(() => assertPriceIdentity(gold, [bar(47.21) as any]), /FEED_IDENTITY/);
  assert.throws(() => assertPriceIdentity(gold, [bar(1.1014) as any]), /FEED_IDENTITY/);
  // BTC (95000) on the gold chart → refusal
  assert.throws(() => assertPriceIdentity(gold, [bar(95000) as any]), /FEED_IDENTITY/);
  // NaN close → refusal (corrupted tail)
  assert.throws(() => assertPriceIdentity(gold, [bar(NaN) as any]), /FEED_IDENTITY/);
});

// ---------------------------------------------------------------------------
// timeframes still resolve for every instrument (chart routing intact)
// ---------------------------------------------------------------------------
test("timeframe configuration resolves for every instrument", () => {
  for (const inst of INSTRUMENTS) {
    const tf: Timeframe = "5m";
    assert.ok(TF_SECONDS[tf] > 0);
    if (inst.feed === "binance") {
      assert.ok(getInstrument(inst.symbol)?.binance, "binance routing");
    } else {
      assert.ok(getInstrument(inst.symbol)?.yahoo, "quotes routing");
    }
  }
});
