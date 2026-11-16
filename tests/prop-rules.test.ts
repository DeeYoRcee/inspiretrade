/**
 * Phase-2 engine tests — prop rules, swap, modify validations, uid guard.
 * Run: node --test tests/prop-rules.test.ts  (also picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  nightsHeld, swapForPosition, evaluatePropRules, validatePositionModify,
  validateOrderModify, validateAgainstRules, tradingDayCount, quoteFromMid,
  DEFAULT_PROP_RULES, type PropRules,
} from "../shared/trading-engine.ts";
import { getInstrument } from "../shared/terminal.ts";

const XAU = getInstrument("XAUUSD")!;
const P: Record<string, number> = { USDJPY: 149, EURUSD: 1.08, GBPUSD: 1.27, USDCHF: 0.88, USDCAD: 1.36 };
const DAY = 86_400_000;

// ---- swap ------------------------------------------------------------------

test("nightsHeld counts whole UTC midnights crossed", () => {
  const open = Date.UTC(2025, 0, 1, 23, 0); // 23:00 UTC
  assert.equal(nightsHeld(open, open + 1_000), 0);          // same day
  assert.equal(nightsHeld(open, Date.UTC(2025, 0, 2, 1, 0)), 1);
  assert.equal(nightsHeld(open, Date.UTC(2025, 0, 3, 1, 0)), 2);
  assert.equal(nightsHeld(open, open - 1), 0);              // reversed → 0
});

test("swapForPosition: signed rate × lots × nights (XAU long pays)", () => {
  const open = Date.UTC(2025, 0, 1, 12, 0);
  // XAU long = -8.4 USD/lot/night → 1 lot × 2 nights
  assert.equal(swapForPosition(XAU, "buy", 1, open, open + 2 * DAY + 3600_000), -16.8);
  // short receives +1.6/lot/night; 0.5 lots × 3 nights
  assert.equal(swapForPosition(XAU, "sell", 0.5, open, open + 3 * DAY + 3600_000), 2.4);
  // same day → no swap
  assert.equal(swapForPosition(XAU, "buy", 1, open, open + 1_000), 0);
});

// ---- position modify (MT5 semantics vs the LIVE price) ----------------------

test("validatePositionModify: SL beyond entry is legal when it locks profit", () => {
  const q = quoteFromMid(2050, XAU, "t", true); // bid 2049.875 / ask 2050.125
  // BUY entered at 2000, price now 2050: SL at 2030 (above entry, below bid) → OK
  assert.equal(validatePositionModify({ pos: { side: "buy", entry: 2000 }, quote: q, sl: 2030 }).ok, true);
  // SL above the current bid → rejected
  assert.equal(validatePositionModify({ pos: { side: "buy", entry: 2000 }, quote: q, sl: 2055 }).ok, false);
  // TP below the current bid → rejected; above → OK
  assert.equal(validatePositionModify({ pos: { side: "buy", entry: 2000 }, quote: q, tp: 2040 }).ok, false);
  assert.equal(validatePositionModify({ pos: { side: "buy", entry: 2000 }, quote: q, tp: 2060 }).ok, true);
  // SELL at 2000 with price now 2050: SL above ask → OK, TP below ask → OK
  const s = validatePositionModify({ pos: { side: "sell", entry: 2000 }, quote: q, sl: 2060, tp: 1990 });
  assert.equal(s.ok, true);
  // clearing (null) is always fine
  assert.equal(validatePositionModify({ pos: { side: "buy", entry: 2000 }, quote: q, sl: null, tp: null }).ok, true);
});

// ---- pending order modify ----------------------------------------------------

test("validateOrderModify keeps the trigger on the correct side of the live quote", () => {
  const q = quoteFromMid(2000, XAU, "t", true); // ask 2000.125 / bid 1999.875
  // buy limit moved above the ask → invalid
  assert.equal(validateOrderModify({ order: { side: "buy", kind: "limit", price: 1990 }, quote: q, price: 2005 }).ok, false);
  // buy limit kept below the ask → valid
  assert.equal(validateOrderModify({ order: { side: "buy", kind: "limit", price: 1990 }, quote: q, price: 1995 }).ok, true);
  // buy stop moved below the ask → invalid
  assert.equal(validateOrderModify({ order: { side: "buy", kind: "stop", price: 2010 }, quote: q, price: 1995 }).ok, false);
  // sell stop moved above the bid → invalid
  assert.equal(validateOrderModify({ order: { side: "sell", kind: "stop", price: 1990 }, quote: q, price: 2005 }).ok, false);
  // price kept, SL/TP re-validated against the NEW trigger price
  const v = validateOrderModify({ order: { side: "buy", kind: "limit", price: 1990 }, quote: q, price: 1995, sl: 2000, tp: 1994 });
  assert.equal(v.ok, false); // SL above trigger for a buy
});

// ---- prop-rule order guards ---------------------------------------------------

test("validateAgainstRules: per-order lots, combined lots, position count", () => {
  const rules: PropRules = { ...DEFAULT_PROP_RULES, maxLotsPerOrder: 5, maxLotsTotal: 10, maxOpenPositions: 3 };
  assert.equal(validateAgainstRules({ rules, lots: 3, openPositions: 1, openOrders: 1, openLots: 4 }).ok, true);
  const perOrder = validateAgainstRules({ rules, lots: 6, openPositions: 0, openOrders: 0, openLots: 0 });
  assert.equal(perOrder.ok, false);
  assert.match(perOrder.error!, /Max lot size per order/);
  const total = validateAgainstRules({ rules, lots: 2, openPositions: 0, openOrders: 0, openLots: 9 });
  assert.equal(total.ok, false);
  assert.match(total.error!, /Max combined volume/);
  const count = validateAgainstRules({ rules, lots: 1, openPositions: 2, openOrders: 1, openLots: 2 });
  assert.equal(count.ok, false);
  assert.match(count.error!, /Max 3 open positions/);
  // no rules → everything passes
  assert.equal(validateAgainstRules({ rules: null, lots: 100, openPositions: 99, openOrders: 99, openLots: 999 }).ok, true);
});

// ---- rule evaluation -----------------------------------------------------------

const RULES: PropRules = {
  dailyLossLimitPct: 5, maxDrawdownPct: 10, profitTargetPct: 10,
  minTradingDays: 3, maxLotsTotal: null, maxLotsPerOrder: null, maxOpenPositions: null,
};

test("prop rules: daily loss breach → hard breach + failed", () => {
  // start 100k, day-start 100k, equity 94.9k → daily loss 5.1k > 5% (5k)
  const r = evaluatePropRules({
    rules: RULES, status: "active", balance: 100_000, equity: 94_900,
    startingBalance: 100_000, dayStartBalance: 100_000, peakEquity: 100_000,
    tradingDays: 5, openPositions: 2, openLots: 1,
  });
  assert.equal(r.dailyBreach, true);
  assert.equal(r.hardBreach, true);
  assert.equal(r.status, "failed");
  assert.match(r.failedReason!, /Daily loss limit breached/);
  assert.equal(r.dailyLossUsed > 1, true);
});

test("prop rules: overall drawdown breach → failed", () => {
  const r = evaluatePropRules({
    rules: RULES, status: "active", balance: 91_000, equity: 90_000,
    startingBalance: 100_000, dayStartBalance: 92_000, peakEquity: 105_000,
    tradingDays: 2, openPositions: 0, openLots: 0,
  });
  assert.equal(r.overallBreach, true);
  assert.equal(r.hardBreach, true);
  assert.equal(r.status, "failed");
  assert.match(r.failedReason!, /Maximum drawdown breached/);
});

test("prop rules: target reached but book open → still active", () => {
  const r = evaluatePropRules({
    rules: RULES, status: "active", balance: 112_000, equity: 112_000,
    startingBalance: 100_000, dayStartBalance: 110_000, peakEquity: 112_000,
    tradingDays: 4, openPositions: 1, openLots: 1,
  });
  assert.equal(r.targetReached, true);
  assert.equal(r.canPass, false);
  assert.equal(r.status, "active");
});

test("prop rules: target + flat + enough days → passed", () => {
  const r = evaluatePropRules({
    rules: RULES, status: "active", balance: 111_000, equity: 111_000,
    startingBalance: 100_000, dayStartBalance: 111_000, peakEquity: 111_000,
    tradingDays: 3, openPositions: 0, openLots: 0,
  });
  assert.equal(r.targetReached, true);
  assert.equal(r.canPass, true);
  assert.equal(r.status, "passed");
});

test("prop rules: target + flat but not enough trading days → active", () => {
  const r = evaluatePropRules({
    rules: RULES, status: "active", balance: 115_000, equity: 115_000,
    startingBalance: 100_000, dayStartBalance: 115_000, peakEquity: 115_000,
    tradingDays: 2, openPositions: 0, openLots: 0,
  });
  assert.equal(r.canPass, false);
  assert.equal(r.status, "active");
});

test("prop rules: once failed, evaluation never restores active", () => {
  const r = evaluatePropRules({
    rules: RULES, status: "failed", balance: 120_000, equity: 120_000,
    startingBalance: 100_000, dayStartBalance: 120_000, peakEquity: 120_000,
    tradingDays: 10, openPositions: 0, openLots: 0,
  });
  assert.equal(r.status, "failed");
  assert.equal(r.hardBreach, false);
});

test("prop rules: DEMO (rules=null) → neutral pass-through", () => {
  const r = evaluatePropRules({
    rules: null, status: "active", balance: 50_000, equity: 49_000,
    startingBalance: 100_000, dayStartBalance: 50_000, peakEquity: 55_000,
    tradingDays: 0, openPositions: 0, openLots: 0,
  });
  assert.equal(r.status, "active");
  assert.equal(r.hardBreach, false);
  assert.equal(r.dailyLossLimitUsd, null);
});

test("tradingDayCount: distinct UTC days with closed trades", () => {
  const d = (day: number, hour = 12) => Date.UTC(2025, 0, day, hour);
  assert.equal(tradingDayCount([{ closedAt: d(5) }, { closedAt: d(5, 23) }, { closedAt: d(6) }]), 2);
  assert.equal(tradingDayCount([]), 0);
});

// ---- multi-user guard (regression) ------------------------------------------
//
// uid isolation is structural: every store call is rooted at users/{uid} with
// the uid taken ONLY from the verified ID token. Guard the invariant: the
// trading route/store must never read a uid from the request body.

test("security: trading route never trusts a client-supplied uid", () => {
  const routeSrc = readFileSync(new URL("../api/_src/trading/index.ts", import.meta.url), "utf8");
  assert.equal(/body\s*&&\s*body\.uid|body\?\.\s*uid/.test(routeSrc), false, "route must not read body.uid");
  const storeSrc = readFileSync(new URL("../api/_src/trading/store.ts", import.meta.url), "utf8");
  assert.equal(/body\.uid|body\?\.\s*uid/.test(storeSrc), false, "store must not read body.uid");
  // every store mutation takes the authenticated uid as its first parameter
  for (const fn of ["listAccounts", "createAccount", "placeOrder", "closePosition", "closeAll",
    "modifyPosition", "modifyOrder", "cancelOrder", "evaluate", "resetAccount", "history"]) {
    assert.match(storeSrc, new RegExp(`(async\\s+function|export\\s+async\\s+function)\\s+${fn}\\s*\\(\\s*uid\\s*[:,]`),
      `${fn} must be rooted at the authenticated uid`);
  }
});
