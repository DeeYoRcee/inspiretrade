/**
 * Multi-timeframe (MTF) analysis — transparent, configurable trend
 * classification for M1..D1. Every number comes from the indicator library;
 * classification rules are shown in the UI and ARE NOT trading advice.
 */
import type { Bar, Timeframe } from "@shared/terminal";
import { ema as emaFn, rsi as rsiFn, macd as macdFn, atr as atrFn, type Line } from "./indicators";

export interface MtfConfig {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiBull: number;  // rsi above → bullish bias
  rsiBear: number;  // rsi below → bearish bias
}

export const DEFAULT_MTF: MtfConfig = { emaFast: 20, emaSlow: 50, rsiPeriod: 14, rsiBull: 55, rsiBear: 45 };

export interface MtfRow {
  tf: Timeframe;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  score: number;          // -100..100 trend strength
  emaAlign: "bull" | "bear" | "mixed";
  rsi: number | null;
  macd: "bull" | "bear" | "flat";
  barsUsed: number;
  lastBarTime: number | null;
}

const val = (line: Line, t: number): number | undefined => {
  // lines are small; linear scan from the end is fine
  for (let i = line.length - 1; i >= 0 && i >= line.length - 3; i--) if (line[i].time === t) return line[i].value;
  return undefined;
};

export function analyzeTimeframe(bars: Bar[], tf: Timeframe, cfg: MtfConfig = DEFAULT_MTF): MtfRow {
  const n = bars.length;
  if (n < Math.max(cfg.emaSlow + 5, cfg.rsiPeriod + 5)) {
    return { tf, trend: "NEUTRAL", score: 0, emaAlign: "mixed", rsi: null, macd: "flat", barsUsed: n, lastBarTime: n ? bars[n - 1].time : null };
  }
  const fast = emaFn(bars, cfg.emaFast);
  const slow = emaFn(bars, cfg.emaSlow);
  const rsiLine = rsiFn(bars, cfg.rsiPeriod);
  const macdR = macdFn(bars);
  const atrLine = atrFn(bars, 14);
  const t = bars[n - 1].time;
  const tp = bars[n - 2].time;

  const f = val(fast, t), s = val(slow, t);
  const rsiV = val(rsiLine, t);
  const macdV = val(macdR.macd, t);
  const sigV = val(macdR.signal, t);
  const atrV = val(atrLine, t) ?? 0;

  const emaAlign: MtfRow["emaAlign"] = f != null && s != null ? (f > s ? "bull" : f < s ? "bear" : "mixed") : "mixed";
  const macdStatus: MtfRow["macd"] = macdV != null && sigV != null ? (macdV > sigV ? "bull" : macdV < sigV ? "bear" : "flat") : "flat";

  // transparent score: each component votes, ATR-normalized EMA gap sets weight
  const emaGapPct = f != null && s != null && atrV > 0 ? ((f - s) / atrV) * 100 : 0;
  const emaWeight = Math.max(-50, Math.min(50, emaGapPct));
  const priceVote = f != null ? (bars[n - 1].close > f ? 15 : -15) : 0;
  const rsiVote = rsiV != null ? (rsiV >= cfg.rsiBull ? 20 : rsiV <= cfg.rsiBear ? -20 : 0) : 0;
  const macdVote = macdStatus === "bull" ? 15 : macdStatus === "bear" ? -15 : 0;
  const score = Math.round(Math.max(-100, Math.min(100, emaWeight + priceVote + rsiVote + macdVote)));

  const trend: MtfRow["trend"] = score >= 35 ? "BULLISH" : score <= -35 ? "BEARISH" : "NEUTRAL";

  return {
    tf, trend, score,
    emaAlign,
    rsi: rsiV != null ? Math.round(rsiV * 10) / 10 : null,
    macd: macdStatus,
    barsUsed: n,
    lastBarTime: t,
  };
}

export const MTF_TFS: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export function mtfTable(barsByTf: Partial<Record<Timeframe, Bar[]>>, cfg: MtfConfig = DEFAULT_MTF): MtfRow[] {
  return MTF_TFS.map((tf) => analyzeTimeframe(barsByTf[tf] ?? [], tf, cfg));
}

export function mtfVerdict(rows: MtfRow[]): string {
  const bull = rows.filter((r) => r.trend === "BULLISH").length;
  const bear = rows.filter((r) => r.trend === "BEARISH").length;
  if (bull >= 5) return "Strong bullish alignment";
  if (bear >= 5) return "Strong bearish alignment";
  if (bull >= 4) return "Mostly bullish";
  if (bear >= 4) return "Mostly bearish";
  if (bull > bear) return "Mixed, bullish tilt";
  if (bear > bull) return "Mixed, bearish tilt";
  return "Mixed / no alignment";
}
