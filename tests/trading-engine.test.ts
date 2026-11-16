/**
 * Engine unit tests — run: node --test tests/trading-engine.test.ts
 * Pure core only (no Firebase) — these are the authoritative math rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPREAD_PIPS, STOP_OUT_LEVEL_PCT, quoteFromMid, convQuoteToUsd, positionPnlUsd,
  marginUsdFor, computeMetrics, checkExitTrigger, checkPendingTrigger,
  validateNewOrder, evaluateAccount, exitPriceFor, dayKey,
  type Quote, type PositionLike, type OrderLike,
} from "../shared/trading-engine.ts";
import { getInstrument } from "../shared/terminal.ts";

const XAU = getInstrument("XAUUSD")!;
const EUR = getInstrument("EURUSD")!;
const JPY = getInstrument("USDJPY")!;
const GER = getInstrument("GER40")!;

const goldQ = quoteFromMid(2000, XAU, "test", true);
const eurQ = quoteFromMid(1.1, EUR, "test", true);
const jpyQ = quoteFromMid(149, JPY, "test", true);
const gerQ = quoteFromMid(18000, GER, "test", true);
const P: Record<string, number> = { USDJPY: 149, EURUSD: 1.08, GBPUSD: 1.27, USDCHF: 0.88, USDCAD: 1.36 };

test("spread → two-sided quotes", () => {
  // XAUUSD spread 2.5 pips × 0.1 = 0.25 around mid 2000
  assert.equal(goldQ.bid, 1999.875);
  assert.equal(goldQ.ask, 2000.125);
});

test("P/L math: XAUUSD, EURUSD, USDJPY conversion, GER40 EUR conversion", () => {
  assert.equal(positionPnlUsd(XAU, "buy", 1, 2000, 2010, P), 1000);        // $10/0.1 × 100
  assert.equal(positionPnlUsd(XAU, "buy", 0.5, 2000, 2010, P), 500);       // partial close
  assert.equal(positionPnlUsd(EUR, "buy", 1, 1.1, 1.101, P), 100);         // $10/pip
  assert.equal(positionPnlUsd(EUR, "sell", 1, 1.1, 1.101, P), -100);       // losing short
  // sell 1 lot USDJPY 150→149 = +100,000 JPY × (1/149) = 671.1409…
  assert.equal(Math.round(positionPnlUsd(JPY, "sell", 1, 150, 149, P) * 100) / 100, 671.14);
  // GER40 sell 18000→17900 = 100 EUR × EURUSD 1.08 = $108
  assert.equal(Math.round(positionPnlUsd(GER, "sell", 1, 18000, 17900, P) * 100) / 100, 108);
});

test("margin: USD-quote vs USD-base forex vs EUR-quote index", () => {
  assert.equal(marginUsdFor(XAU, 1, 2000, P, 100), 2000);       // 100 oz × 2000 / 100
  assert.equal(marginUsdFor(EUR, 1, 1.1, P, 100), 1100);        // 100k EUR × 1.1
  assert.equal(marginUsdFor(JPY, 1, 149, P, 100), 1000);        // USD base: fixed 100k
  assert.equal(marginUsdFor(GER, 1, 18000, P, 100), 194.4);     // 18000 EUR × 1.08 / 100
});

test("exit price: buy closes at bid, sell closes at ask", () => {
  assert.equal(exitPriceFor("buy", goldQ), 1999.875);
  assert.equal(exitPriceFor("sell", goldQ), 2000.125);
});

test("account metrics: equity, used margin, margin level", () => {
  const pos: PositionLike = { id: "p1", symbol: "XAUUSD", side: "buy", lots: 1, entry: 2000, sl: null, tp: null, openedAt: 0 };
  const m = computeMetrics(10000, [pos], { XAUUSD: quoteFromMid(2005, XAU, "t", true) }, P, 100);
  assert.equal(m.floatingPnl, 487.5);      // (2004.875-2000) × 100
  assert.equal(m.equity, 10487.5);
  assert.equal(m.usedMargin, 2005);        // mid 2005 × 100 / 100
  assert.equal(m.freeMargin, 8482.5);
  assert.equal(m.marginLevel, 523.07);     // 10487.5/2005×100
  assert.equal(m.openCount, 1);
});

test("SL/TP triggers for BUY (bid side) and SELL (ask side)", () => {
  const buy: PositionLike = { id: "b", symbol: "XAUUSD", side: "buy", lots: 1, entry: 2000, sl: 1990, tp: 2020, openedAt: 0 };
  const sell: PositionLike = { id: "s", symbol: "XAUUSD", side: "sell", lots: 1, entry: 2000, sl: 2030, tp: 1980, openedAt: 0 };
  const mk = (mid: number) => quoteFromMid(mid, XAU, "t", true);
  assert.equal(checkExitTrigger(buy, mk(1989.5)), "sl");
  assert.equal(checkExitTrigger(buy, mk(2020.5)), "tp");
  assert.equal(checkExitTrigger(buy, mk(2000)), null);
  assert.equal(checkExitTrigger(sell, mk(2030.5)), "sl");
  assert.equal(checkExitTrigger(sell, mk(1979.5)), "tp");
  assert.equal(checkExitTrigger(sell, mk(2000)), null);
});

test("pending triggers: buy/sell × limit/stop", () => {
  const mk = (mid: number) => quoteFromMid(mid, XAU, "t", true);
  const o = (side: "buy" | "sell", kind: "limit" | "stop", price: number): OrderLike =>
    ({ id: "o", symbol: "XAUUSD", side, kind, lots: 1, price, sl: null, tp: null });
  assert.equal(checkPendingTrigger(o("buy", "limit", 1995), mk(1995)), false); // ask 1995.125 > 1995 → no fill
  assert.equal(checkPendingTrigger(o("buy", "limit", 1995.13), mk(1995)), true); // ask 1995.125 <= 1995.13
  assert.equal(checkPendingTrigger(o("buy", "limit", 1994), mk(1995)), false);
  assert.equal(checkPendingTrigger(o("buy", "stop", 2005), mk(2005)), true);
  assert.equal(checkPendingTrigger(o("buy", "stop", 2005), mk(2004)), false);
  assert.equal(checkPendingTrigger(o("sell", "limit", 2005), mk(2005)), false); // bid 2004.875 < 2005 → no fill
  assert.equal(checkPendingTrigger(o("sell", "limit", 2005), mk(2005.2)), true); // bid 2005.075 >= 2005
  assert.equal(checkPendingTrigger(o("sell", "limit", 2010), mk(2006)), false); // bid 2005.875 < 2010 → no fill
  assert.equal(checkPendingTrigger(o("sell", "stop", 1995), mk(1995)), true);
  assert.equal(checkPendingTrigger(o("sell", "stop", 1995), mk(1996)), false);
});

test("order validation: margin, pending side rules, SL/TP side rules", () => {
  const base = { spec: XAU, side: "buy" as const, kind: "market" as const, lots: 1, quote: goldQ, balance: 5000, floatingPnl: 0, usedMargin: 0, prices: P };
  const ok = validateNewOrder(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry, 2000.125);
  const noMargin = validateNewOrder({ ...base, balance: 1000 });
  assert.equal(noMargin.ok, false);
  assert.match(noMargin.error!, /Not enough free margin/);
  const badLimit = validateNewOrder({ ...base, kind: "limit", price: 2005 });
  assert.equal(badLimit.ok, false); // buy limit above ask
  const goodLimit = validateNewOrder({ ...base, kind: "limit", price: 1995 });
  assert.equal(goodLimit.ok, true);
  const badSl = validateNewOrder({ ...base, sl: 2010 });
  assert.equal(badSl.ok, false);
  const badTp = validateNewOrder({ ...base, tp: 1990 });
  assert.equal(badTp.ok, false);
  const sellStopOk = validateNewOrder({ ...base, side: "sell", kind: "stop", price: 1990 });
  assert.equal(sellStopOk.ok, true);
  const sellStopBad = validateNewOrder({ ...base, side: "sell", kind: "stop", price: 2010 });
  assert.equal(sellStopBad.ok, false);
});

test("evaluateAccount: SL hit + pending fill together", () => {
  const buy: PositionLike = { id: "b", symbol: "XAUUSD", side: "buy", lots: 1, entry: 2000, sl: 1990, tp: 2020, openedAt: 0 };
  const order: OrderLike = { id: "o1", symbol: "XAUUSD", side: "buy", kind: "limit", lots: 1, price: 1995.13, sl: null, tp: null };
  // mid 1989 → bid 1988.875 ≤ 1990 (SL hits), ask 1989.125 ≤ 1995.13 (limit fills)
  const res = evaluateAccount({ balance: 5000, positions: [buy], orders: [order], quotes: { XAUUSD: quoteFromMid(1989, XAU, "t", true) }, prices: P });
  assert.equal(res.stopOut, false);
  assert.deepEqual(res.exits.map((e) => e.positionId), ["b"]);
  assert.equal(res.exits[0].reason, "sl");
  assert.equal(res.exits[0].exit, 1988.875);
  assert.deepEqual(res.fills.map((f) => f.orderId), ["o1"]);
  assert.equal(res.fills[0].entry, 1989.125);
});

test("stop-out: margin level breaches 20% → force close all", () => {
  const buy: PositionLike = { id: "b", symbol: "XAUUSD", side: "buy", lots: 1, entry: 2000, sl: null, tp: null, openedAt: 0 };
  const res = evaluateAccount({ balance: 1000, positions: [buy], orders: [], quotes: { XAUUSD: quoteFromMid(1910, XAU, "t", true) }, prices: P });
  assert.equal(res.stopOut, true);
  assert.deepEqual(res.stopOutIds, ["b"]);
  assert.equal(res.exits.length, 0);
  // healthy account is never stopped out
  const fine = evaluateAccount({ balance: 10000, positions: [buy], orders: [], quotes: { XAUUSD: goldQ }, prices: P });
  assert.equal(fine.stopOut, false);
  assert.equal(STOP_OUT_LEVEL_PCT, 20);
});

test("quote→USD conversion rates", () => {
  assert.equal(convQuoteToUsd("USD", P), 1);
  assert.equal(Math.round(convQuoteToUsd("JPY", P) * 1e6) / 1e6, Math.round((1 / 149) * 1e6) / 1e6);
  assert.equal(convQuoteToUsd("EUR", P), 1.08);
  assert.equal(convQuoteToUsd("GBP", P), 1.27);
});

test("dayKey is UTC YYYY-MM-DD", () => {
  assert.equal(dayKey(0), "1970-01-01");
  assert.match(dayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});
