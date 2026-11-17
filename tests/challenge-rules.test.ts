/**
 * Phase 6 — prop-firm rule engine tests. Exercises the SHARED pure engine
 * (shared/trading-engine.ts) that the server enforces inside every trading
 * transaction: daily/overall drawdown, profit target + min trading days,
 * order risk limits, the challenge period deadline, win/loss stats and
 * simultaneous fills (concurrent SL/TP + pending triggers in one pass).
 * Run: node --test tests/  (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePropRules, validateAgainstRules, evaluateAccount, computeMetrics,
  periodExpired, bumpTradeStats, quoteFromMid, DEFAULT_PROP_RULES,
  type PropRules,
} from "../shared/trading-engine.ts";
import { getInstrument } from "../shared/terminal.ts";

const rules: PropRules = {
  dailyLossLimitPct: 5, maxDrawdownPct: 10, profitTargetPct: 10,
  minTradingDays: 3, maxLotsTotal: 10, maxLotsPerOrder: 5, maxOpenPositions: 10,
  maxTradingDays: 30,
};

const base = {
  rules, status: "active" as const, balance: 10_000, equity: 10_000,
  startingBalance: 10_000, dayStartBalance: 10_000, peakEquity: 10_000,
  tradingDays: 0, openPositions: 0, openLots: 0,
};

test("daily drawdown: breach at -5% of day-start equity fails the account", () => {
  const out = evaluatePropRules({ ...base, equity: 9_500 });
  assert.equal(out.dailyBreach, true);
  assert.equal(out.hardBreach, true);
  assert.equal(out.status, "failed");
  assert.match(out.failedReason || "", /Daily loss/);
  assert.equal(out.dailyLossLimitUsd, 500);
  assert.equal(out.dailyLossUsd, 500);
  assert.equal(out.dailyLossUsed, 1);
});

test("daily drawdown: below the limit stays active (floating P/L counts)", () => {
  const out = evaluatePropRules({ ...base, equity: 9_500.01 });
  assert.equal(out.dailyBreach, false);
  assert.equal(out.status, "active");
  assert.ok(out.dailyLossUsed < 1 && out.dailyLossUsed > 0.99);
});

test("overall drawdown: -10% of the starting balance is a hard breach", () => {
  const out = evaluatePropRules({ ...base, equity: 9_000, dayStartBalance: 10_000 });
  assert.equal(out.overallBreach, true);
  assert.equal(out.hardBreach, true);
  assert.equal(out.status, "failed");
  assert.match(out.failedReason || "", /Maximum drawdown/);
});

test("overall drawdown: daily-breach-only day keeps overall untouched", () => {
  const out = evaluatePropRules({ ...base, equity: 9_600 });
  assert.equal(out.dailyBreach, false);
  assert.equal(out.overallBreach, false);
  assert.equal(out.drawdownUsed, 0.4);
});

test("profit target: pass requires target + min days + flat book", () => {
  const pass = evaluatePropRules({ ...base, equity: 11_000, tradingDays: 3 });
  assert.equal(pass.targetReached, true);
  assert.equal(pass.canPass, true);
  assert.equal(pass.status, "passed");

  const noDays = evaluatePropRules({ ...base, equity: 11_000, tradingDays: 2 });
  assert.equal(noDays.canPass, false);
  assert.equal(noDays.status, "active");

  const openBook = evaluatePropRules({ ...base, equity: 11_000, tradingDays: 3, openPositions: 1, openLots: 0.5 });
  assert.equal(openBook.canPass, false);

  const notReached = evaluatePropRules({ ...base, equity: 10_999.99, tradingDays: 3 });
  assert.equal(notReached.canPass, false);
});

test("profit target: floating profit counts via equity; progress is capped at 0..", () => {
  const out = evaluatePropRules({ ...base, balance: 10_000, equity: 10_700 });
  assert.equal(out.targetProgress, 0.7);
  assert.equal(out.status, "active");
});

test("challenge period: expiry fails the account even without other breaches", () => {
  const started = Date.now() - 31 * 86_400_000;
  assert.equal(periodExpired(rules, started), true);
  assert.equal(periodExpired(rules, Date.now()), false);
  assert.equal(periodExpired({ ...rules, maxTradingDays: null }, started), false);
  assert.equal(periodExpired(null, started), false);

  const out = evaluatePropRules({ ...base, periodExpired: true });
  assert.equal(out.status, "failed");
  assert.equal(out.hardBreach, true);
  assert.match(out.failedReason || "", /period expired/i);
});

test("order risk limits: max lot per order, combined volume, position count", () => {
  // per-order cap
  assert.equal(validateAgainstRules({ rules, lots: 5.01, openPositions: 0, openOrders: 0, openLots: 0 }).ok, false);
  assert.equal(validateAgainstRules({ rules, lots: 5, openPositions: 0, openOrders: 0, openLots: 0 }).ok, true);
  // combined cap (positions + pending + new): 5.5 open + 5 new = 10.5 > 10
  assert.equal(validateAgainstRules({ rules, lots: 1, openPositions: 2, openOrders: 3, openLots: 4.5 }).ok, true);
  assert.equal(validateAgainstRules({ rules, lots: 5, openPositions: 2, openOrders: 3, openLots: 5.5 }).ok, false);
  // position + pending count cap
  const many: PropRules = { ...rules, maxOpenPositions: 3 };
  assert.equal(validateAgainstRules({ rules: many, lots: 0.01, openPositions: 2, openOrders: 0, openLots: 1 }).ok, true);
  assert.equal(validateAgainstRules({ rules: many, lots: 0.01, openPositions: 2, openOrders: 1, openLots: 1 }).ok, false);
  // no rules → everything allowed
  assert.equal(validateAgainstRules({ rules: null, lots: 100, openPositions: 99, openOrders: 99, openLots: 999 }).ok, true);
});

test("simultaneous activity: two pendings fill and an SL hits in ONE evaluation", () => {
  const eur = getInstrument("EURUSD")!;
  const gold = getInstrument("XAUUSD")!;
  // quotes: EURUSD ask sits between the limit and stop triggers (both fill),
  // gold dropped far enough for the SL to hit
  const quotes = {
    EURUSD: quoteFromMid(1.0900, eur, "test", true), // ask ≈ 1.09004
    XAUUSD: quoteFromMid(2640, gold, "test", true),
  };
  const out = evaluateAccount({
    balance: 10_000,
    positions: [{
      id: "p1", symbol: "XAUUSD", side: "buy", lots: 0.1, entry: 2660,
      sl: 2_650, tp: null, openedAt: Date.now() - 1000,
    }],
    orders: [
      { id: "o1", symbol: "EURUSD", side: "buy", kind: "limit", lots: 0.1, price: 1.0901, sl: null, tp: null },
      { id: "o2", symbol: "EURUSD", side: "buy", kind: "stop", lots: 0.1, price: 1.0900, sl: null, tp: null },
    ],
    quotes,
  });
  assert.equal(out.fills.length, 2, "both pending orders must fill together");
  assert.deepEqual(out.fills.map((f) => f.orderId).sort(), ["o1", "o2"]);
  assert.equal(out.exits.length, 1);
  assert.equal(out.exits[0].reason, "sl");
  assert.equal(out.exits[0].positionId, "p1");
});

test("metrics: equity, margin and free margin are consistent", () => {
  const gold = getInstrument("XAUUSD")!;
  const q = quoteFromMid(2650, gold, "test", true);
  // a market BUY opened at the ask (mid + half-spread = 2650.125)
  const m = computeMetrics(10_000, [{
    id: "p1", symbol: "XAUUSD", side: "buy", lots: 1, entry: 2650.125, sl: null, tp: null, openedAt: Date.now(),
  }], { XAUUSD: q }, { XAUUSD: 2650 }, 100);
  // close at bid 2649.875 → floating -25; 1 lot gold = 100 oz → margin 2_650 at 1:100
  assert.equal(m.usedMargin, 2650);
  assert.equal(m.equity, 9975);
  assert.equal(m.floatingPnl, -25);
  assert.equal(m.freeMargin, 7325);
});

test("trade stats: wins/losses accumulate and win rate math holds", () => {
  let s = bumpTradeStats(undefined, 120);
  s = bumpTradeStats(s, -80);
  s = bumpTradeStats(s, 15);
  s = bumpTradeStats(s, 0); // neither win nor loss
  assert.deepEqual(s, { totalTrades: 4, wins: 2, losses: 1 });
  assert.equal(Math.round((s.wins / s.totalTrades) * 1000) / 10, 50);
});

test("default rules are a sane production profile", () => {
  assert.equal(DEFAULT_PROP_RULES.dailyLossLimitPct, 5);
  assert.equal(DEFAULT_PROP_RULES.maxDrawdownPct, 10);
  assert.equal(DEFAULT_PROP_RULES.profitTargetPct, 10);
  assert.equal(DEFAULT_PROP_RULES.maxTradingDays, 30);
});
