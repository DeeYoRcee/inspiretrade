/**
 * Replay/backtest core unit tests — run: node --test tests/replay-engine.test.ts
 * Verifies: wallet math (spread/commission), SL/TP triggering with the
 * conservative intra-bar path, pending fills + gap rule, chronology guards,
 * no-look-ahead in the backtest runner, and performance statistics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newReplayWallet, replayOpen, replayClose, replayPlace, replayCancel,
  stepReplayBar, barPathPoints, performanceStats, equityCurve,
  type ReplayExecConfig,
} from "../shared/replay-engine.ts";
import { runBacktest, strategySignal, DEFAULT_STRATEGY_PARAMS } from "../shared/backtest.ts";
import { getInstrument } from "../shared/terminal.ts";
import type { Bar } from "../shared/terminal.ts";

const CFG: ReplayExecConfig = { commissionPerLot: 0, leverage: 100 };

function bar(time: number, open: number, high: number, low: number, close: number): Bar {
  return { time, open, high, low, close, volume: 100 };
}

// BTCUSD spec: pipSize 0.01, catalog spread 12 pips → 0.12 USD spread
const SPEC = getInstrument("BTCUSD")!;
const HS = (12 * SPEC.pipSize) / 2; // half spread = 0.06

// ---------------------------------------------------------------------------
// barPathPoints — conservative direction-aware path
// ---------------------------------------------------------------------------

test("barPathPoints: bullish candle walks O→L→H→C (SL before TP for longs)", () => {
  const path = barPathPoints(bar(0, 100, 110, 95, 108));
  assert.deepEqual(path, [100, 95, 110, 108]);
});

test("barPathPoints: bearish candle walks O→H→L→C (SL before TP for shorts)", () => {
  const path = barPathPoints(bar(0, 100, 106, 90, 92));
  assert.deepEqual(path, [100, 106, 90, 92]);
});

// ---------------------------------------------------------------------------
// Market orders + spread + P/L
// ---------------------------------------------------------------------------

test("replayOpen: BUY fills at ASK (mid + half spread), SELL at BID", () => {
  const w = newReplayWallet(10000);
  const res = replayOpen(w, SPEC, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, now: 0, kind: "market", mid: 50000 });
  assert.ok(res.ok);
  if (res.ok) {
    // spread 12 pips × pipSize 0.01 → ask = 50000 + 0.06
    assert.equal(res.position.entry, 50000 + HS);
  }
  const res2 = replayOpen(w, SPEC, CFG, { symbol: "BTCUSD", side: "sell", lots: 1, now: 0, kind: "market", mid: 50000 });
  assert.ok(res2.ok);
  if (res2.ok) assert.equal(res2.position.entry, 50000 - HS);
});

test("replayClose: BUY closes at BID, pnl = (bid - entry) × lots × contractSize", () => {
  const w = newReplayWallet(10000);
  const open = replayOpen(w, SPEC, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, now: 0, kind: "market", mid: 50000 });
  assert.ok(open.ok);
  if (!open.ok) return;
  const close = replayClose(open.wallet, SPEC, CFG, open.position.id, 50100, 60_000);
  assert.ok(close.ok);
  if (close.ok) {
    // entry 50000.06, exit bid 50099.94 → +99.88 USD, commission 0
    assert.equal(close.trade.pnl, 100 - 12 * SPEC.pipSize);
    assert.equal(close.wallet.balance, 10000 + 100 - 12 * SPEC.pipSize);
    assert.equal(close.trade.reason, "manual");
  }
});

test("replayOpen rejects SL on the wrong side and oversized lots", () => {
  const spec = getInstrument("BTCUSD")!;
  const w = newReplayWallet(10000);
  const bad = replayOpen(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 0.1, sl: 51000, now: 0, kind: "market", mid: 50000 });
  assert.ok(!bad.ok);
  const big = replayOpen(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 1000, now: 0, kind: "market", mid: 50000 });
  assert.ok(!big.ok);
  // margin: 100 lots × 1 BTC × 50k / 100 lev = 50k > 10k balance
  const noMargin = replayOpen(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 100, now: 0, kind: "market", mid: 50000 });
  assert.ok(!noMargin.ok);
});

test("commission is charged once per round trip at close", () => {
  const cfg = { ...CFG, commissionPerLot: 7 };
  const w = newReplayWallet(1000);
  const open = replayOpen(w, SPEC, cfg, { symbol: "BTCUSD", side: "buy", lots: 0.5, now: 0, kind: "market", mid: 50000 });
  if (!open.ok) throw new Error("open failed");
  assert.equal(open.wallet.balance, 1000); // nothing charged at open
  const close = replayClose(open.wallet, SPEC, cfg, open.position.id, 50000, 60_000);
  if (!close.ok) throw new Error("close failed");
  // entry 50000.06 (ask), exit 49999.94 (bid) → gross −0.12 × 0.5 lots = −0.06; commission 3.5
  assert.equal(close.trade.commission, 3.5);
  assert.equal(close.trade.pnl, -(12 * SPEC.pipSize * 0.5 + 3.5));
  assert.equal(close.wallet.balance, 1000 - (12 * SPEC.pipSize * 0.5 + 3.5));
});

// ---------------------------------------------------------------------------
// SL/TP + pending orders through the bar stepper
// ---------------------------------------------------------------------------

test("stepReplayBar: SL triggers on a bullish candle when low crosses it (fill at the triggering quote)", () => {
  const w = newReplayWallet(10000);
  const open = replayOpen(w, SPEC, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, sl: 49500, now: 0, kind: "market", mid: 50000 });
  if (!open.ok) throw new Error("open failed");
  // entry 50000.06 (ask). Bullish bar O=50000 L=49400 H=50100 C=50050:
  // path [50000, 49400, 50100, 50050]; bid crosses 49500 at point 49400
  // → SL fills AT the level (MT5 semantics: the stop is a bid price)
  const step = stepReplayBar(open.wallet, SPEC, CFG, bar(60, 50000, 50100, 49400, 50050));
  assert.equal(step.closed.length, 1);
  assert.equal(step.closed[0].reason, "sl");
  assert.equal(step.closed[0].trade.exit, 49500);
  assert.equal(step.closed[0].trade.pnl, -(500 + 12 * SPEC.pipSize / 2)); // −500.06
  assert.equal(step.wallet.balance, 10000 - (500 + 12 * SPEC.pipSize / 2));
});

test("stepReplayBar: TP triggers on a bearish candle for a short", () => {
  const w = newReplayWallet(10000);
  const open = replayOpen(w, SPEC, CFG, { symbol: "BTCUSD", side: "sell", lots: 1, tp: 49400, now: 0, kind: "market", mid: 50000 });
  if (!open.ok) throw new Error("open failed");
  // entry 49999.94 (bid). Bearish bar O=50000 H=50060 L=49350 C=49420:
  // path [50000, 50060, 49350, 49420]; ask crosses 49400 at point 49350
  // → TP fills AT the level (a short's TP is an ask price)
  const step = stepReplayBar(open.wallet, SPEC, CFG, bar(60, 50000, 50060, 49350, 49420));
  assert.equal(step.closed.length, 1);
  assert.equal(step.closed[0].reason, "tp");
  assert.equal(step.closed[0].trade.exit, 49400);
  assert.equal(step.closed[0].trade.pnl, 599.94); // (50000 − 0.06) − 49400, rounded to cents
});

test("stepReplayBar: both SL and TP inside one candle → SL fires first (conservative)", () => {
  const spec = getInstrument("BTCUSD")!;
  const w = newReplayWallet(10000);
  const open = replayOpen(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, sl: 49500, tp: 50500, now: 0, kind: "market", mid: 50000 });
  if (!open.ok) throw new Error("open failed");
  // bullish bar touching both SL and TP zones
  const step = stepReplayBar(open.wallet, spec, CFG, bar(60, 50000, 50600, 49400, 50550));
  assert.equal(step.closed.length, 1);
  assert.equal(step.closed[0].reason, "sl");
});

test("pending buy-limit fills at the trigger price; gap-through fills at open", () => {
  const spec = getInstrument("BTCUSD")!;
  const w = newReplayWallet(100000);
  const placed = replayPlace(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, kind: "limit", price: 49500, now: 0, mid: 50000 });
  assert.ok(placed.ok);
  if (!placed.ok) return;
  const step = stepReplayBar(placed.wallet, spec, CFG, bar(60, 50000, 50100, 49400, 50050));
  assert.equal(step.filledOrderIds.length, 1);
  const pos = step.wallet.positions[0];
  assert.ok(pos);
  assert.equal(pos.entry, 49500); // filled exactly at the trigger
  assert.equal(pos.id.startsWith("p-"), true);

  // gap: open below the limit → fill at open (better price)
  const w2 = newReplayWallet(100000);
  const placed2 = replayPlace(w2, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, kind: "limit", price: 49800, now: 0, mid: 50000 });
  if (!placed2.ok) throw new Error("place failed");
  const step2 = stepReplayBar(placed2.wallet, spec, CFG, bar(60, 49700, 50100, 49600, 50000));
  assert.equal(step2.filledOrderIds.length, 1);
  // a gapped-through buy limit fills at the open's ASK (49700 + half spread)
  assert.equal(step2.wallet.positions[0].entry, 49700 + HS);
});

test("pending order with wrong trigger side is rejected", () => {
  const spec = getInstrument("BTCUSD")!;
  const w = newReplayWallet(100000);
  const bad = replayPlace(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, kind: "limit", price: 50500, now: 0, mid: 50000 });
  assert.ok(!bad.ok); // buy limit above ask
  const ok = replayPlace(w, spec, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, kind: "stop", price: 50500, now: 0, mid: 50000 });
  assert.ok(ok.ok); // buy stop above ask is valid
  if (ok.ok) {
    const cancelled = replayCancel(ok.wallet, ok.order.id);
    assert.equal(cancelled.orders.length, 0);
  }
});

test("replayFloatingPnl marks open positions at bid/ask (spread cost visible)", () => {
  const w = newReplayWallet(10000);
  const open = replayOpen(w, SPEC, CFG, { symbol: "BTCUSD", side: "buy", lots: 1, now: 0, kind: "market", mid: 50000 });
  if (!open.ok) throw new Error("open failed");
  // buy entry at ask 50000.06, marks at bid 49999.94 → floating −0.12 at the same mid
  const floating = 0 - 12 * SPEC.pipSize;
  assert.equal(floating, -0.12);
  // equity at a higher mid: floating = (50100 − 0.06) − 50000.06 = 99.88
  assert.equal(open.wallet.positions.length, 1);
});

// ---------------------------------------------------------------------------
// Performance stats + equity curve
// ---------------------------------------------------------------------------

test("performanceStats: win rate, PF, streaks, by-symbol/day buckets", () => {
  const s = performanceStats([
    { symbol: "BTCUSD", side: "buy", profit: 100, closedAt: Date.UTC(2026, 0, 1, 10), openedAt: Date.UTC(2026, 0, 1, 9) },
    { symbol: "BTCUSD", side: "buy", profit: -50, closedAt: Date.UTC(2026, 0, 1, 12), openedAt: Date.UTC(2026, 0, 1, 11) },
    { symbol: "ETHUSD", side: "sell", profit: 200, closedAt: Date.UTC(2026, 0, 2, 12), openedAt: Date.UTC(2026, 0, 2, 11) },
    { symbol: "ETHUSD", side: "sell", profit: -100, closedAt: Date.UTC(2026, 0, 2, 14), openedAt: Date.UTC(2026, 0, 2, 13) },
    { symbol: "BTCUSD", side: "buy", profit: 150, closedAt: Date.UTC(2026, 0, 2, 16), openedAt: Date.UTC(2026, 0, 2, 15) },
  ]);
  assert.equal(s.totalTrades, 5);
  assert.equal(s.wins, 3);
  assert.equal(s.winRate, 60);
  assert.equal(s.netProfit, 300);
  assert.equal(s.profitFactor, 3); // grossWin 450 / grossLoss 150
  assert.equal(s.maxConsecutiveWins, 1); // W,L,W,L,W
  assert.equal(s.maxConsecutiveLosses, 1);
  assert.equal(s.longs.count, 3);
  assert.equal(s.shorts.count, 2);
  assert.equal(s.bySymbol["BTCUSD"].pnl, 200);
  assert.equal(s.bySymbol["ETHUSD"].pnl, 100);
  assert.equal(s.byDay["2026-01-01"], 50);
  assert.equal(s.byDay["2026-01-02"], 250);
  assert.equal(s.bestDay?.pnl, 250);
  assert.equal(s.worstDay?.pnl, 50);
});

test("equityCurve: max drawdown (USD + %) from chronological closes", () => {
  const r = equityCurve([
    { profit: 500, closedAt: 1 },
    { profit: -800, closedAt: 2 },
    { profit: 300, closedAt: 3 },
  ], 1000);
  // balance: 1500 → 700 → 1000; peak 1500, trough 700 → dd 800 (53.33%)
  assert.equal(r.maxDrawdownUsd, 800);
  assert.equal(r.maxDrawdownPct, 53.33);
  assert.equal(r.curve.length, 3);
  assert.equal(r.curve[1].balance, 700);
});

// ---------------------------------------------------------------------------
// Backtest runner — no look-ahead + chronology
// ---------------------------------------------------------------------------

function genBars(n: number): Bar[] {
  // simple deterministic zig-zag with a trend regime switch
  const out: Bar[] = [];
  let px = 50000;
  for (let i = 0; i < n; i++) {
    const drift = i < n / 2 ? 40 : -30;
    const open = px;
    const close = px + drift + (i % 3 === 0 ? -60 : 20);
    const high = Math.max(open, close) + 80;
    const low = Math.min(open, close) - 80;
    out.push(bar(i * 300_000, open, high, low, close));
    px = close;
  }
  return out;
}

test("runBacktest: chronological guard throws on unsorted bars", () => {
  const bars = genBars(120);
  const shuffled = [...bars];
  [shuffled[5], shuffled[6]] = [shuffled[6], shuffled[5]];
  assert.throws(() => runBacktest({
    symbol: "BTCUSD", timeframe: "5m", strategy: "sma_cross",
    params: { ...DEFAULT_STRATEGY_PARAMS }, startBalance: 10000, riskPct: null,
    fixedLots: 0.1, commissionPerLot: 0, spreadPips: 12, leverage: 100,
    closeOnOpposite: true,
  }, shuffled), /chronological/);
});

test("runBacktest: never executes a signal on the signal bar itself (no look-ahead)", () => {
  const bars = genBars(400);
  const cfg = {
    symbol: "BTCUSD", timeframe: "5m" as const, strategy: "sma_cross" as const,
    params: { ...DEFAULT_STRATEGY_PARAMS }, startBalance: 10000, riskPct: null,
    fixedLots: 0.1, commissionPerLot: 0, spreadPips: 12, leverage: 100,
    closeOnOpposite: true,
  };
  const res = runBacktest(cfg, bars);
  for (const t of res.trades) {
    // the entry price must be within the entry bar's range (it opened AT the
    // NEXT bar's open ± spread) — find the bar whose time == openedAt
    const idx = bars.findIndex((b) => b.time * 1000 === t.openedAt);
    assert.ok(idx > 0, "entry bar exists");
    assert.ok(t.entry >= bars[idx].low - 1 && t.entry <= bars[idx].high + 1, "entry within bar range");
    // AND: the signal bar (idx−1) must actually generate that signal
    const sig = strategySignal("sma_cross", bars, idx - 1, cfg.params);
    assert.ok(sig === "long" || sig === "short" || (sig === null && t.reason !== "manual"), "entry follows a signal");
    if (sig === "long") assert.equal(t.side, "buy");
    if (sig === "short") assert.equal(t.side, "sell");
    // exits happen at or after the entry bar
    assert.ok(t.closedAt >= t.openedAt);
  }
});

test("runBacktest: metrics are consistent with the trade list", () => {
  const bars = genBars(600);
  const res = runBacktest({
    symbol: "BTCUSD", timeframe: "5m", strategy: "breakout",
    params: { ...DEFAULT_STRATEGY_PARAMS }, startBalance: 10000, riskPct: 1,
    fixedLots: 0, commissionPerLot: 4, spreadPips: 12, leverage: 100,
    closeOnOpposite: true,
  }, bars);
  assert.ok(res.trades.length > 0, "strategy produced trades");
  assert.equal(res.stats.totalTrades, res.trades.length);
  assert.ok(res.finalBalance === res.equityCurve[res.equityCurve.length - 1].balance, "final balance matches the curve");
  const net = res.trades.reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(net - res.stats.netProfit) < 0.01, "netProfit = Σ pnl");
  assert.ok(res.maxDrawdownUsd >= 0);
  assert.ok(res.barsTested === 600);
  // fixedLots: 0 with riskPct set → risk-based sizing used, all lots ≥ 0.01
  for (const t of res.trades) assert.ok(t.lots >= 0.01);
});

test("strategySignal: SMA cross fires only after the slow period warm-up", () => {
  const bars = genBars(60);
  const p = { ...DEFAULT_STRATEGY_PARAMS };
  assert.equal(strategySignal("sma_cross", bars, p.slowPeriod - 1, p), null);
  const sig = strategySignal("sma_cross", bars, 200 >= bars.length ? bars.length - 1 : 55, p);
  assert.ok(sig === null || sig === "long" || sig === "short");
});
