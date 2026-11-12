/**
 * Strategy Tester — deterministic backtest engine over REAL historical bars.
 *
 * Anti-look-ahead discipline:
 *  - every rule is evaluated on bar i's CLOSE only;
 *  - fills happen at bar i+1's OPEN (with spread);
 *  - SL/TP are checked on each subsequent bar's high/low; when both are hit
 *    inside the same bar the STOP is assumed first (pessimistic);
 *  - all indicators are causal (EMA/RSI/MACD/BB only use data ≤ i).
 *
 * Money model mirrors the terminal demo account: P/L = Δprice × lots ×
 * contractSize (quote currency ≈ USD reference for cross pairs), commission
 * = pct of notional per side, spread applied on the ask side of each fill.
 */
import type { Bar } from "@shared/terminal";
import { getInstrument } from "@shared/terminal";
import { rsi as rsiFn, ema as emaFn, sma as smaFn, macd as macdFn, bollinger as bbFn, atr as atrFn, stochastic as stochFn, type Line } from "./indicators";

export type RuleKind =
  | "rsiBelow" | "rsiAbove" | "rsiCrossUp" | "rsiCrossDown"
  | "emaCrossUp" | "emaCrossDown" | "smaCrossUp" | "smaCrossDown"
  | "priceAboveEma" | "priceBelowEma"
  | "macdCrossUp" | "macdCrossDown"
  | "bbBreakoutUp" | "bbBreakoutDown"
  | "stochCrossUp" | "stochCrossDown";

export interface Rule { kind: RuleKind; p1?: number; p2?: number; p3?: number }

export interface RuleSpec { kind: RuleKind; label: string; params: { key: "p1" | "p2" | "p3"; label: string; def: number }[] }

export const RULE_CATALOG: RuleSpec[] = [
  { kind: "rsiBelow", label: "RSI < level", params: [{ key: "p1", label: "period", def: 14 }, { key: "p2", label: "level", def: 30 }] },
  { kind: "rsiAbove", label: "RSI > level", params: [{ key: "p1", label: "period", def: 14 }, { key: "p2", label: "level", def: 70 }] },
  { kind: "rsiCrossUp", label: "RSI crosses UP level", params: [{ key: "p1", label: "period", def: 14 }, { key: "p2", label: "level", def: 30 }] },
  { kind: "rsiCrossDown", label: "RSI crosses DOWN level", params: [{ key: "p1", label: "period", def: 14 }, { key: "p2", label: "level", def: 70 }] },
  { kind: "emaCrossUp", label: "EMA fast crosses ABOVE slow", params: [{ key: "p1", label: "fast", def: 9 }, { key: "p2", label: "slow", def: 21 }] },
  { kind: "emaCrossDown", label: "EMA fast crosses BELOW slow", params: [{ key: "p1", label: "fast", def: 9 }, { key: "p2", label: "slow", def: 21 }] },
  { kind: "smaCrossUp", label: "SMA fast crosses ABOVE slow", params: [{ key: "p1", label: "fast", def: 20 }, { key: "p2", label: "slow", def: 50 }] },
  { kind: "smaCrossDown", label: "SMA fast crosses BELOW slow", params: [{ key: "p1", label: "fast", def: 20 }, { key: "p2", label: "slow", def: 50 }] },
  { kind: "priceAboveEma", label: "Price above EMA", params: [{ key: "p1", label: "period", def: 50 }] },
  { kind: "priceBelowEma", label: "Price below EMA", params: [{ key: "p1", label: "period", def: 50 }] },
  { kind: "macdCrossUp", label: "MACD crosses ABOVE signal", params: [{ key: "p1", label: "fast", def: 12 }, { key: "p2", label: "slow", def: 26 }, { key: "p3", label: "signal", def: 9 }] },
  { kind: "macdCrossDown", label: "MACD crosses BELOW signal", params: [{ key: "p1", label: "fast", def: 12 }, { key: "p2", label: "slow", def: 26 }, { key: "p3", label: "signal", def: 9 }] },
  { kind: "bbBreakoutUp", label: "Close above upper BB", params: [{ key: "p1", label: "period", def: 20 }, { key: "p2", label: "mult", def: 2 }] },
  { kind: "bbBreakoutDown", label: "Close below lower BB", params: [{ key: "p1", label: "period", def: 20 }, { key: "p2", label: "mult", def: 2 }] },
  { kind: "stochCrossUp", label: "Stoch %K crosses ↑ %D", params: [{ key: "p1", label: "k", def: 14 }, { key: "p2", label: "d", def: 3 }, { key: "p3", label: "below lvl", def: 30 }] },
  { kind: "stochCrossDown", label: "Stoch %K crosses ↓ %D", params: [{ key: "p1", label: "k", def: 14 }, { key: "p2", label: "d", def: 3 }, { key: "p3", label: "above lvl", def: 70 }] },
];

export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  direction: "both" | "long" | "short";
  entryLong: Rule[];
  entryShort: Rule[];
  slType: "atr" | "pct" | "points";
  slValue: number;
  tpType: "atr" | "pct" | "points" | "rr";
  tpValue: number;
  exitOpposite: boolean;
  maxBarsOpen: number;
  riskPct: number;
  startingBalance: number;
  commissionPct: number;
  spreadPips: number;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  symbol: "BTCUSD", timeframe: "1h", direction: "both",
  entryLong: [{ kind: "emaCrossUp", p1: 9, p2: 21 }],
  entryShort: [{ kind: "emaCrossDown", p1: 9, p2: 21 }],
  slType: "atr", slValue: 2,
  tpType: "rr", tpValue: 2,
  exitOpposite: false, maxBarsOpen: 0,
  riskPct: 1, startingBalance: 10000,
  commissionPct: 0.02, spreadPips: 2,
};

export interface BacktestTrade {
  id: number; side: "long" | "short";
  entryTime: number; exitTime: number;
  entry: number; exit: number; lots: number;
  sl: number; tp: number;
  pips: number; pnl: number; fees: number;
  reason: "sl" | "tp" | "signal" | "end";
  bars: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equity: { time: number; value: number }[];
  stats: {
    total: number; wins: number; losses: number; winRate: number;
    profitFactor: number; maxDrawdown: number; maxDrawdownPct: number;
    netProfit: number; netProfitPct: number;
    avgWin: number; avgLoss: number; avgRR: number; expectancy: number;
    longs: number; shorts: number; longWinRate: number; shortWinRate: number;
    longNet: number; shortNet: number; avgBars: number; fees: number;
  };
  monthly: { month: string; pnl: number; trades: number; winRate: number }[];
  barsUsed: number; fromTime: number; toTime: number;
}

const byTime = (line: Line) => new Map(line.map((p) => [p.time, p.value]));
const val = (m: Map<number, number>, t: number): number | undefined => m.get(t);

/** Evaluate a rule set at bar index i. Returns true when ALL rules fire. */
function evaluateRules(rules: Rule[], bars: Bar[], i: number, pre: Precomputed): boolean {
  if (!rules.length) return false;
  const t = bars[i].time, tp = bars[i - 1]?.time;
  for (const r of rules) {
    const p1 = r.p1 ?? 0, p2 = r.p2 ?? 0, p3 = r.p3 ?? 0;
    switch (r.kind) {
      case "rsiBelow": { const v = val(pre.rsi(p1), t); if (v == null || !(v < p2)) return false; break; }
      case "rsiAbove": { const v = val(pre.rsi(p1), t); if (v == null || !(v > p2)) return false; break; }
      case "rsiCrossUp": {
        const a = val(pre.rsi(p1), t), b = val(pre.rsi(p1), tp);
        if (a == null || b == null || !(b <= p2 && a > p2)) return false; break;
      }
      case "rsiCrossDown": {
        const a = val(pre.rsi(p1), t), b = val(pre.rsi(p1), tp);
        if (a == null || b == null || !(b >= p2 && a < p2)) return false; break;
      }
      case "emaCrossUp": {
        const f = val(pre.ema(p1), t), fp = val(pre.ema(p1), tp), s = val(pre.ema(p2), t), sp = val(pre.ema(p2), tp);
        if (f == null || fp == null || s == null || sp == null || !(fp <= sp && f > s)) return false; break;
      }
      case "emaCrossDown": {
        const f = val(pre.ema(p1), t), fp = val(pre.ema(p1), tp), s = val(pre.ema(p2), t), sp = val(pre.ema(p2), tp);
        if (f == null || fp == null || s == null || sp == null || !(fp >= sp && f < s)) return false; break;
      }
      case "smaCrossUp": {
        const f = val(pre.sma(p1), t), fp = val(pre.sma(p1), tp), s = val(pre.sma(p2), t), sp = val(pre.sma(p2), tp);
        if (f == null || fp == null || s == null || sp == null || !(fp <= sp && f > s)) return false; break;
      }
      case "smaCrossDown": {
        const f = val(pre.sma(p1), t), fp = val(pre.sma(p1), tp), s = val(pre.sma(p2), t), sp = val(pre.sma(p2), tp);
        if (f == null || fp == null || s == null || sp == null || !(fp >= sp && f < s)) return false; break;
      }
      case "priceAboveEma": { const v = val(pre.ema(p1), t); if (v == null || !(bars[i].close > v)) return false; break; }
      case "priceBelowEma": { const v = val(pre.ema(p1), t); if (v == null || !(bars[i].close < v)) return false; break; }
      case "macdCrossUp": {
        const m = val(pre.macdLine(p1, p2, p3), t), mp = val(pre.macdLine(p1, p2, p3), tp);
        const s = val(pre.macdSig(p1, p2, p3), t), sp = val(pre.macdSig(p1, p2, p3), tp);
        if (m == null || mp == null || s == null || sp == null || !(mp <= sp && m > s)) return false; break;
      }
      case "macdCrossDown": {
        const m = val(pre.macdLine(p1, p2, p3), t), mp = val(pre.macdLine(p1, p2, p3), tp);
        const s = val(pre.macdSig(p1, p2, p3), t), sp = val(pre.macdSig(p1, p2, p3), tp);
        if (m == null || mp == null || s == null || sp == null || !(mp >= sp && m < s)) return false; break;
      }
      case "bbBreakoutUp": { const u = val(pre.bbUpper(p1, p2), t); if (u == null || !(bars[i].close > u)) return false; break; }
      case "bbBreakoutDown": { const l = val(pre.bbLower(p1, p2), t); if (l == null || !(bars[i].close < l)) return false; break; }
      case "stochCrossUp": {
        const k = val(pre.stochK(p1, p2), t), kp = val(pre.stochK(p1, p2), tp);
        const d = val(pre.stochD(p1, p2), t), dp = val(pre.stochD(p1, p2), tp);
        if (k == null || kp == null || d == null || dp == null) return false;
        if (p3 > 0 && kp >= p3) return false; // only from oversold zone
        if (!(kp <= dp && k > d)) return false; break;
      }
      case "stochCrossDown": {
        const k = val(pre.stochK(p1, p2), t), kp = val(pre.stochK(p1, p2), tp);
        const d = val(pre.stochD(p1, p2), t), dp = val(pre.stochD(p1, p2), tp);
        if (k == null || kp == null || d == null || dp == null) return false;
        if (p3 > 0 && kp <= p3) return false;
        if (!(kp >= dp && k < d)) return false; break;
      }
    }
  }
  return true;
}

interface Precomputed {
  rsi: (p: number) => Map<number, number>;
  ema: (p: number) => Map<number, number>;
  sma: (p: number) => Map<number, number>;
  macdLine: (f: number, s: number, g: number) => Map<number, number>;
  macdSig: (f: number, s: number, g: number) => Map<number, number>;
  bbUpper: (p: number, m: number) => Map<number, number>;
  bbLower: (p: number, m: number) => Map<number, number>;
  stochK: (k: number, d: number) => Map<number, number>;
  stochD: (k: number, d: number) => Map<number, number>;
  atr: (p: number) => Map<number, number>;
}

function precompute(bars: Bar[]): Precomputed {
  const cache = new Map<string, Map<number, number>>();
  const line = (key: string, fn: () => Line): Map<number, number> => {
    if (!cache.has(key)) cache.set(key, byTime(fn()));
    return cache.get(key)!;
  };
  const macdR = (f: number, s: number, g: number) => macdFn(bars, f, s, g);
  const stochR = (k: number, d: number) => stochFn(bars, k, d);
  const bbR = (p: number, m: number) => bbFn(bars, p, m);
  return {
    rsi: (p) => line(`rsi${p}`, () => rsiFn(bars, p)),
    ema: (p) => line(`ema${p}`, () => emaFn(bars, p)),
    sma: (p) => line(`sma${p}`, () => smaFn(bars, p)),
    macdLine: (f, s, g) => line(`macd${f}_${s}_${g}`, () => macdR(f, s, g).macd),
    macdSig: (f, s, g) => line(`macdsig${f}_${s}_${g}`, () => macdR(f, s, g).signal),
    bbUpper: (p, m) => line(`bbu${p}_${m}`, () => bbR(p, m).upper),
    bbLower: (p, m) => line(`bbl${p}_${m}`, () => bbR(p, m).lower),
    stochK: (k, d) => line(`stk${k}_${d}`, () => stochR(k, d).k),
    stochD: (k, d) => line(`std${k}_${d}`, () => stochR(k, d).d),
    atr: (p) => line(`atr${p}`, () => atrFn(bars, p)),
  };
}

export function runBacktest(allBars: Bar[], cfg: BacktestConfig, fromTime = 0): BacktestResult | { error: string } {
  const inst = getInstrument(cfg.symbol);
  const contract = inst?.contractSize ?? 1;
  const pip = inst?.pipSize ?? 0.0001;
  const bars = fromTime > 0 ? allBars.filter((b) => b.time >= fromTime) : allBars;
  if (bars.length < 120) return { error: "Not enough historical bars for this period (need ≥ 120)" };

  const pre = precompute(bars);
  const warmup = Math.max(60, 2); // indicator maps simply return undefined when not ready
  const trades: BacktestTrade[] = [];
  const equityPts: { time: number; value: number }[] = [{ time: bars[0].time, value: cfg.startingBalance }];
  let equity = cfg.startingBalance;
  let pos: {
    side: "long" | "short"; entry: number; lots: number; sl: number; tp: number;
    entryIdx: number; entryTime: number; openIdx: number;
  } | null = null;

  const spread = cfg.spreadPips * pip;

  const closePos = (exitRaw: number, exitIdx: number, reason: BacktestTrade["reason"]) => {
    if (!pos) return;
    const exit = pos.side === "long" ? exitRaw : exitRaw + spread; // short buys back at ask
    const diff = pos.side === "long" ? exit - pos.entry : pos.entry - exit;
    const notional = pos.entry * pos.lots * contract;
    const fees = (notional * cfg.commissionPct) / 100 * 2;
    const pnl = Math.round((diff * pos.lots * contract - fees) * 100) / 100;
    equity += pnl; // accumulate the SAME rounded value that is recorded
    const pips = diff / pip;
    trades.push({
      id: trades.length + 1, side: pos.side,
      entryTime: pos.entryTime, exitTime: bars[exitIdx].time,
      entry: pos.entry, exit, lots: pos.lots, sl: pos.sl, tp: pos.tp,
      pips: Math.round(pips * 10) / 10, pnl: Math.round(pnl * 100) / 100,
      fees: Math.round(fees * 100) / 100, reason,
      bars: exitIdx - pos.openIdx,
    });
    equityPts.push({ time: bars[exitIdx].time, value: Math.round(equity * 100) / 100 });
    pos = null;
  };

  for (let i = warmup; i < bars.length; i++) {
    // manage the open position on bar i (its high/low/first-touch ordering)
    if (pos) {
      const b = bars[i];
      const hitSL = pos.side === "long" ? b.low <= pos.sl : b.high >= pos.sl;
      const hitTP = pos.side === "long" ? b.high >= pos.tp : b.low <= pos.tp;
      if (hitSL) closePos(pos.side === "long" ? pos.sl : pos.sl, i, "sl");
      else if (hitTP) closePos(pos.side === "long" ? pos.tp : pos.tp, i, "tp");
      else if (cfg.maxBarsOpen > 0 && i - pos.openIdx >= cfg.maxBarsOpen) closePos(b.close, i, "end");
      else if (cfg.exitOpposite) {
        if (pos.side === "long" && evaluateRules(cfg.entryShort, bars, i, pre)) closePos(b.close, i, "signal");
        else if (pos.side === "short" && evaluateRules(cfg.entryLong, bars, i, pre)) closePos(b.close, i, "signal");
      }
    }
    // new entry decided at close i, filled at open i+1
    if (!pos && i + 1 < bars.length) {
      const wantLong = cfg.direction !== "short" && evaluateRules(cfg.entryLong, bars, i, pre);
      const wantShort = cfg.direction !== "long" && evaluateRules(cfg.entryShort, bars, i, pre);
      if (wantLong !== wantShort) {
        const side: "long" | "short" = wantLong ? "long" : "short";
        const next = bars[i + 1];
        const entry = side === "long" ? next.open + spread : next.open;
        let slDist = 0;
        if (cfg.slType === "atr") slDist = (val(pre.atr(14), bars[i].time) ?? 0) * cfg.slValue;
        else if (cfg.slType === "pct") slDist = entry * (cfg.slValue / 100);
        else slDist = cfg.slValue;
        if (slDist > 0) {
          const sl = side === "long" ? entry - slDist : entry + slDist;
          let tpDist = 0;
          if (cfg.tpType === "rr") tpDist = slDist * cfg.tpValue;
          else if (cfg.tpType === "atr") tpDist = (val(pre.atr(14), bars[i].time) ?? 0) * cfg.tpValue;
          else if (cfg.tpType === "pct") tpDist = entry * (cfg.tpValue / 100);
          else tpDist = cfg.tpValue;
          const tp = side === "long" ? entry + tpDist : entry - tpDist;
          const riskUSD = (equity * cfg.riskPct) / 100;
          const lots = Math.max(0.01, Math.floor((riskUSD / (slDist * contract)) * 100) / 100);
          pos = {
            side, entry, lots, sl, tp,
            entryIdx: i + 1, entryTime: next.time, openIdx: i + 1,
          };
        }
      }
    }
  }
  if (pos) closePos(bars[bars.length - 1].close, bars.length - 1, "end");

  // ---- stats ---------------------------------------------------------------
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netProfit = trades.reduce((s, t) => s + t.pnl, 0);
  let peak = cfg.startingBalance, maxDD = 0;
  for (const p of equityPts) {
    peak = Math.max(peak, p.value);
    maxDD = Math.max(maxDD, peak - p.value);
  }
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const longs = trades.filter((t) => t.side === "long");
  const shorts = trades.filter((t) => t.side === "short");
  const monthMap = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const m = new Date(t.exitTime * 1000).toISOString().slice(0, 7);
    const row = monthMap.get(m) ?? { pnl: 0, trades: 0, wins: 0 };
    row.pnl += t.pnl; row.trades++; if (t.pnl > 0) row.wins++;
    monthMap.set(m, row);
  }
  const fees = trades.reduce((s, t) => s + t.fees, 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;

  return {
    trades, equity: equityPts,
    stats: {
      total: trades.length,
      wins: wins.length, losses: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      maxDrawdownPct: Math.round((maxDD / Math.max(peak, 1)) * 10000) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      netProfitPct: Math.round((netProfit / cfg.startingBalance) * 10000) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      avgRR: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : avgWin > 0 ? 99 : 0,
      expectancy: trades.length ? Math.round((netProfit / trades.length) * 100) / 100 : 0,
      longs: longs.length, shorts: shorts.length,
      longWinRate: longs.length ? Math.round((longs.filter((t) => t.pnl > 0).length / longs.length) * 1000) / 10 : 0,
      shortWinRate: shorts.length ? Math.round((shorts.filter((t) => t.pnl > 0).length / shorts.length) * 1000) / 10 : 0,
      longNet: Math.round(longs.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
      shortNet: Math.round(shorts.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
      avgBars: trades.length ? Math.round(trades.reduce((s, t) => s + t.bars, 0) / trades.length) : 0,
      fees: Math.round(fees * 100) / 100,
    },
    monthly: [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, r]) => ({ month, pnl: Math.round(r.pnl * 100) / 100, trades: r.trades, winRate: r.trades ? Math.round((r.wins / r.trades) * 1000) / 10 : 0 })),
    barsUsed: bars.length,
    fromTime: bars[0].time,
    toTime: bars[bars.length - 1].time,
  };
}
