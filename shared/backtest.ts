/**
 * InspireTrade backtesting engine — shared pure core.
 *
 * Runs DETERMINISTIC built-in strategies over real historical candles using
 * the exact same bar-step broker as interactive replay (shared/replay-engine)
 * so spread, commission and fill assumptions are identical platform-wide.
 *
 * Look-ahead prevention (verified by tests):
 *  - a signal is computed on bar i AFTER it has fully closed,
 *  - the resulting order executes at bar i+1's OPEN (its first quote),
 *  - SL/TP/pending handling inside a bar uses the conservative OHLC path
 *    (SL fires before TP when both lie within one candle),
 *  - bars must be strictly chronological or runBacktest() throws.
 */
import { getInstrument, type Bar, type InstrumentSpec, type Timeframe } from "./terminal.ts";
import {
  positionPnlUsd,
  exitPriceFor,
} from "./trading-engine.ts";
import {
  newReplayWallet, replayOpen, replayClose, stepReplayBar,
  replayQuote, performanceStats, equityCurve,
  type PerfStats, type ReplayExecConfig, type ReplayTrade, type ReplayWallet,
} from "./replay-engine.ts";

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export type StrategyId = "sma_cross" | "rsi_reversion" | "breakout";

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  sma_cross: "SMA crossover (trend)",
  rsi_reversion: "RSI mean reversion",
  breakout: "Donchian breakout",
};

export interface StrategyParams {
  /** SMA crossover */
  fastPeriod: number;   // default 10
  slowPeriod: number;   // default 30
  /** RSI mean reversion */
  rsiPeriod: number;    // default 14
  rsiOversold: number;  // default 30
  rsiOverbought: number;// default 70
  /** Donchian breakout */
  channelPeriod: number;// default 20
  /** shared: R:R multiple for the take-profit (1.5 = TP 1.5× the SL distance) */
  riskReward: number;   // default 2
  /** stop distance in ATR multiples (ATR(14)) */
  atrMultiple: number;  // default 2
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  fastPeriod: 10, slowPeriod: 30,
  rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70,
  channelPeriod: 20,
  riskReward: 2, atrMultiple: 2,
};

export type Signal = "long" | "short" | "closeLong" | "closeShort" | null;

/**
 * Evaluate a strategy on a fully CLOSED bar (index i). All indicators use
 * data up to and including bar i only — never bar i+1 or later.
 */
export function strategySignal(
  id: StrategyId, bars: Bar[], i: number, p: StrategyParams,
): Signal {
  switch (id) {
    case "sma_cross": {
      if (i < p.slowPeriod) return null;
      const fast = sma(bars, p.fastPeriod, i);
      const slow = sma(bars, p.slowPeriod, i);
      const fastPrev = sma(bars, p.fastPeriod, i - 1);
      const slowPrev = sma(bars, p.slowPeriod, i - 1);
      if (fast == null || slow == null || fastPrev == null || slowPrev == null) return null;
      if (fastPrev <= slowPrev && fast > slow) return "long";
      if (fastPrev >= slowPrev && fast < slow) return "short";
      return null;
    }
    case "rsi_reversion": {
      if (i < p.rsiPeriod + 1) return null;
      const r = rsi(bars, p.rsiPeriod, i);
      const rPrev = rsi(bars, p.rsiPeriod, i - 1);
      if (r == null || rPrev == null) return null;
      if (rPrev <= p.rsiOversold && r > p.rsiOversold) return "long";
      if (rPrev >= p.rsiOverbought && r < p.rsiOverbought) return "short";
      // mid-line exit
      if (rPrev < 50 && r >= 50) return "closeLong";
      if (rPrev > 50 && r <= 50) return "closeShort";
      return null;
    }
    case "breakout": {
      if (i < p.channelPeriod + 1) return null;
      const { hi, lo } = donchian(bars, p.channelPeriod, i - 1); // channel as of the PREVIOUS close
      const c = bars[i].close;
      if (c > hi) return "long";
      if (c < lo) return "short";
      return null;
    }
  }
}

function sma(bars: Bar[], period: number, i: number): number | null {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += bars[k].close;
  return s / period;
}

function rsi(bars: Bar[], period: number, i: number): number | null {
  if (i < period) return null;
  let gains = 0, losses = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const d = bars[k].close - bars[k - 1].close;
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

/** Highest high / lowest low of the `period` bars ENDING at index `i` (inclusive). */
function donchian(bars: Bar[], period: number, i: number): { hi: number; lo: number } {
  let hi = -Infinity, lo = Infinity;
  for (let k = i - period + 1; k <= i; k++) {
    if (k < 0) continue;
    hi = Math.max(hi, bars[k].high);
    lo = Math.min(lo, bars[k].low);
  }
  return { hi, lo };
}

function atr(bars: Bar[], period: number, i: number): number {
  if (i < 1) return Math.max(1e-9, bars[0]?.high - bars[0]?.low || 1e-9);
  let s = 0, n = 0;
  for (let k = Math.max(1, i - period + 1); k <= i; k++) {
    const tr = Math.max(
      bars[k].high - bars[k].low,
      Math.abs(bars[k].high - bars[k - 1].close),
      Math.abs(bars[k].low - bars[k - 1].close),
    );
    s += tr; n += 1;
  }
  return n ? s / n : 1e-9;
}

// ---------------------------------------------------------------------------
// Backtest runner
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  symbol: string;
  timeframe: Timeframe;
  strategy: StrategyId;
  params: StrategyParams;
  startBalance: number;
  /** risk % of current equity per trade; when null → fixedLots is used */
  riskPct: number | null;
  fixedLots: number;
  commissionPerLot: number;
  /** spread override in pips; null = catalog SPREAD_PIPS (same as live) */
  spreadPips: number | null;
  leverage: number;
  /** exit an opposite signal closes the current position (default true) */
  closeOnOpposite: boolean;
}

export interface BacktestTradeRow {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  exit: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;  // bar open time (ms)
  closedAt: number;  // bar time of the closing bar (ms)
  pnl: number;
  commission: number;
  reason: "manual" | "sl" | "tp" | "stop-out";
  /** bar index the position was opened at (chart review) */
  entryBar: number;
  /** bar index the position closed at */
  exitBar: number;
  /** realized reward/risk (|exit-entry| / |entry-sl|) */
  realizedRR: number | null;
}

export interface BacktestResult {
  config: BacktestConfig;
  barsTested: number;
  from: number;            // first bar time (ms)
  to: number;              // last bar time (ms)
  stats: PerfStats;
  trades: BacktestTradeRow[];
  equityCurve: { t: number; equity: number; balance: number }[];
  /** balance stepped at each trade close; equity marks the running balance too */
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  finalBalance: number;
  /** peak equity seen during the run */
  peakEquity: number;
}

/**
 * Run a backtest. `bars` MUST be strictly chronological real candles for the
 * requested window (the loader guarantees this; this function re-verifies).
 * Equity is marked per bar (balance + floating of open positions at close),
 * giving an honest drawdown including open-position swings.
 */
export function runBacktest(cfg: BacktestConfig, bars: Bar[]): BacktestResult {
  const spec = getInstrument(cfg.symbol);
  if (!spec) throw new Error(`Unknown instrument: ${cfg.symbol}`);
  if (bars.length < Math.max(cfg.params.slowPeriod, cfg.params.channelPeriod, cfg.params.rsiPeriod) + 10) {
    throw new Error("Not enough historical bars for the strategy warm-up — widen the date range");
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i - 1].time) throw new Error("Historical data is not chronological — aborting");
  }
  const exec: ReplayExecConfig = {
    commissionPerLot: cfg.commissionPerLot,
    spreadPips: cfg.spreadPips ?? undefined,
    leverage: cfg.leverage,
  };
  let wallet: ReplayWallet = newReplayWallet(cfg.startBalance);
  let equityPeak = cfg.startBalance;
  const equityPoints: { t: number; equity: number; balance: number }[] = [];
  const trades: BacktestTradeRow[] = [];
  let warmup = Math.max(
    cfg.strategy === "sma_cross" ? cfg.params.slowPeriod : 0,
    cfg.strategy === "rsi_reversion" ? cfg.params.rsiPeriod + 1 : 0,
    cfg.strategy === "breakout" ? cfg.params.channelPeriod + 1 : 0,
  );
  warmup = Math.max(warmup, 15); // ATR floor

  const markEquity = (bar: Bar) => {
    const q = replayQuote(spec, bar.close, bar.time * 1000, exec);
    let floating = 0;
    for (const p of wallet.positions) {
      floating += positionPnlUsd(spec, p.side, p.lots, p.entry, exitPriceFor(p.side, q), { [spec.symbol]: bar.close });
    }
    const equity = Math.round((wallet.balance + floating) * 100) / 100;
    equityPeak = Math.max(equityPeak, equity);
    equityPoints.push({ t: bar.time * 1000, equity, balance: wallet.balance });
  };

  for (let i = warmup; i < bars.length; i++) {
    const bar = bars[i];
    // --- 1) advance the broker by this bar (SL/TP/pending fills, manual exits) ---
    const step = stepReplayBar(wallet, spec, exec, bar);
    wallet = step.wallet;
    for (const c of step.closed) {
      trades.push(toRow(c.trade, bars, i));
    }
    // --- 2) strategy signal on the CLOSED bar → execute on the NEXT bar ---
    // (i.e. this signal is queued; it acts at bars[i+1].open)
    if (i + 1 < bars.length) {
      const signal = strategySignal(cfg.strategy, bars, i, cfg.params);
      if (signal === "closeLong" || signal === "closeShort") {
        const want = signal === "closeLong" ? "buy" : "sell";
        for (const p of [...wallet.positions]) {
          if (p.side !== want) continue;
          const res = replayClose(wallet, spec, exec, p.id, bars[i + 1].open, bars[i + 1].time * 1000);
          if (res.ok && res.trade) {
            wallet = res.wallet;
            trades.push(toRow(res.trade, bars, i + 1));
          }
        }
      } else if (signal === "long" || signal === "short") {
        const flat = !wallet.positions.some((p) => p.side === (signal === "long" ? "buy" : "sell"));
        if (flat) {
          // close-on-opposite: an opposite-signal exit of the other side first
          if (cfg.closeOnOpposite) {
            const opposite = signal === "long" ? "sell" : "buy";
            for (const p of [...wallet.positions]) {
              if (p.side !== opposite) continue;
              const res = replayClose(wallet, spec, exec, p.id, bars[i + 1].open, bars[i + 1].time * 1000);
              if (res.ok && res.trade) {
                wallet = res.wallet;
                trades.push(toRow(res.trade, bars, i + 1));
              }
            }
          }
          const nextOpen = bars[i + 1].open;
          const a = atr(bars, 14, i);
          const slDist = Math.max(a * cfg.params.atrMultiple, spec.pipSize * 5);
          const tpDist = slDist * Math.max(0.1, cfg.params.riskReward);
          const sl = signal === "long" ? nextOpen - slDist : nextOpen + slDist;
          const tp = signal === "long" ? nextOpen + tpDist : nextOpen - tpDist;
          const lots = sizeFor(cfg, spec, slDist, wallet.balance);
          const res = replayOpen(wallet, spec, exec, {
            symbol: spec.symbol, side: signal === "long" ? "buy" : "sell",
            lots, sl, tp, now: bars[i + 1].time * 1000, kind: "market", mid: nextOpen,
          });
          if (res.ok) wallet = res.wallet;
        }
      }
    }
    markEquity(bar);
  }

  // close anything still open at the last close price (marked "manual")
  const lastBar = bars[bars.length - 1];
  for (const p of [...wallet.positions]) {
    const res = replayClose(wallet, spec, exec, p.id, lastBar.close, lastBar.time * 1000);
    if (res.ok && res.trade) {
      wallet = res.wallet;
      trades.push(toRow(res.trade, bars, bars.length - 1));
    }
  }

  const { curve, maxDrawdownUsd, maxDrawdownPct } = equityCurve(trades, cfg.startBalance);
  const stats = performanceStats(trades);
  return {
    config: cfg,
    barsTested: bars.length,
    from: bars[0].time * 1000,
    to: lastBar.time * 1000,
    stats,
    trades,
    equityCurve: curve.length ? curve : equityPoints,
    maxDrawdownUsd,
    maxDrawdownPct,
    finalBalance: wallet.balance,
    peakEquity: equityPeak,
  };
}

function sizeFor(cfg: BacktestConfig, spec: InstrumentSpec, slDist: number, balance: number): number {
  if (cfg.riskPct == null) return Math.max(0.01, Math.round(cfg.fixedLots * 100) / 100);
  const riskUsd = balance * (cfg.riskPct / 100);
  const perLot = slDist * spec.contractSize;
  if (perLot <= 0) return 0.01;
  return Math.max(0.01, Math.min(100, Math.round((riskUsd / perLot) * 100) / 100));
}

function toRow(t: ReplayTrade, bars: Bar[], closeBarIdx: number): BacktestTradeRow {
  // find the bar index of the entry by time (bounded scan backwards)
  let entryBar = closeBarIdx;
  const entryMs = t.openedAt;
  for (let k = Math.min(closeBarIdx, bars.length - 1); k >= 0; k--) {
    if (bars[k].time * 1000 <= entryMs) { entryBar = k; break; }
    entryBar = k;
  }
  const risk = t.sl != null ? Math.abs(t.entry - t.sl) : null;
  const reward = Math.abs(t.exit - t.entry);
  const rr = risk && risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  return {
    id: t.id, symbol: t.symbol, side: t.side, lots: t.lots,
    entry: t.entry, exit: t.exit, sl: t.sl, tp: t.tp,
    openedAt: t.openedAt, closedAt: t.closedAt,
    pnl: t.pnl, commission: t.commission, reason: t.reason,
    entryBar, exitBar: closeBarIdx,
    realizedRR: rr,
  };
}
