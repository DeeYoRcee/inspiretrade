/**
 * Market screener — runs user filters over REAL bars of every instrument.
 * Bars are loaded through the terminal feed layer with a TTL cache
 * (see data-feeds.loadBarsCached) so a full scan costs at most one history
 * request per instrument per 5 minutes.
 */
import { getInstrument, type Bar, type Timeframe } from "@shared/terminal";
import { rsi as rsiFn, ema as emaFn, sma as smaFn, macd as macdFn, atr as atrFn, type Line } from "./indicators";

export type FilterKind =
  | "rsi" | "emaCross" | "smaCross" | "macdCross"
  | "changePct" | "volatilityPct" | "atrPct" | "priceMovePct" | "volume";

export type FilterOp = "above" | "below" | "crossUp" | "crossDown";

export interface ScreenerFilter {
  id: string;
  kind: FilterKind;
  op: FilterOp;
  value: number;
  p1: number; // period / fast
  p2: number; // slow / level
}

export const FILTER_CATALOG: { kind: FilterKind; label: string; ops: FilterOp[]; p1?: string; p2?: string }[] = [
  { kind: "rsi", label: "RSI", ops: ["above", "below", "crossUp", "crossDown"], p1: "period", p2: "level" },
  { kind: "emaCross", label: "EMA fast vs slow", ops: ["crossUp", "crossDown"], p1: "fast", p2: "slow" },
  { kind: "smaCross", label: "SMA fast vs slow", ops: ["crossUp", "crossDown"], p1: "fast", p2: "slow" },
  { kind: "macdCross", label: "MACD vs signal", ops: ["crossUp", "crossDown"] },
  { kind: "changePct", label: "% change (last bar)", ops: ["above", "below"], p1: "value %" },
  { kind: "volatilityPct", label: "Volatility (σ of returns %)", ops: ["above", "below"], p1: "period" },
  { kind: "atrPct", label: "ATR % of price", ops: ["above", "below"], p1: "period" },
  { kind: "priceMovePct", label: "Move over N bars %", ops: ["above", "below"], p1: "bars" },
  { kind: "volume", label: "Volume (last bar)", ops: ["above", "below"] },
];

export interface ScreenerRow {
  symbol: string;
  name: string;
  assetClass: string;
  price: number;
  changePct: number;
  rsi: number | null;
  atrPct: number | null;
  volatilityPct: number | null;
  volume: number | null;
  passed: boolean;
  failed: string[];
}

const byTime = (line: Line) => new Map(line.map((p) => [p.time, p.value]));

function lastTwo(line: Line, bars: Bar[]): [number, number] | null {
  if (line.length < 2) return null;
  // last two values aligned to the last two bars that exist in the line
  const m = byTime(line);
  const t1 = bars[bars.length - 1].time;
  const t0 = bars[bars.length - 2].time;
  const a = m.get(t0), b = m.get(t1);
  return a == null || b == null ? null : [a, b];
}

function checkFilter(f: ScreenerFilter, bars: Bar[], row: ScreenerRow): boolean {
  const n = bars.length;
  if (n < Math.max(60, f.p1 + f.p2 + 2)) return false; // not enough data → filter fails honestly
  switch (f.kind) {
    case "rsi": {
      const line = rsiFn(bars, f.p1 || 14);
      const two = lastTwo(line, bars);
      row.rsi = two ? Math.round(two[1] * 10) / 10 : null;
      if (!two) return false;
      if (f.op === "above") return two[1] > f.value;
      if (f.op === "below") return two[1] < f.value;
      if (f.op === "crossUp") return two[0] <= f.value && two[1] > f.value;
      return two[0] >= f.value && two[1] < f.value;
    }
    case "emaCross": case "smaCross": {
      const fn = f.kind === "emaCross" ? emaFn : smaFn;
      const fast = lastTwo(fn(bars, f.p1 || 9), bars);
      const slow = lastTwo(fn(bars, f.p2 || 21), bars);
      if (!fast || !slow) return false;
      if (f.op === "crossUp") return fast[0] <= slow[0] && fast[1] > slow[1];
      return fast[0] >= slow[0] && fast[1] < slow[1];
    }
    case "macdCross": {
      const r = macdFn(bars);
      const m = lastTwo(r.macd, bars);
      const s = lastTwo(r.signal, bars);
      if (!m || !s) return false;
      if (f.op === "crossUp") return m[0] <= s[0] && m[1] > s[1];
      return m[0] >= s[0] && m[1] < s[1];
    }
    case "changePct": {
      return f.op === "above" ? row.changePct > f.value : row.changePct < f.value;
    }
    case "volatilityPct": {
      const p = Math.max(2, f.p1 || 20);
      if (n < p + 2 || row.volatilityPct == null) return false;
      return f.op === "above" ? row.volatilityPct > f.value : row.volatilityPct < f.value;
    }
    case "atrPct": {
      if (row.atrPct == null) return false;
      return f.op === "above" ? row.atrPct > f.value : row.atrPct < f.value;
    }
    case "priceMovePct": {
      const p = Math.max(1, f.p1 || 10);
      if (n < p + 1) return false;
      const move = ((bars[n - 1].close - bars[n - 1 - p].close) / bars[n - 1 - p].close) * 100;
      return f.op === "above" ? move > f.value : move < f.value;
    }
    case "volume": {
      if (row.volume == null) return false;
      return f.op === "above" ? row.volume > f.value : row.volume < f.value;
    }
  }
}

/** Run all filters; a symbol passes when EVERY filter matches (AND). */
export function runScreener(barsBySymbol: Record<string, Bar[]>, filters: ScreenerFilter[]): ScreenerRow[] {
  const rows: ScreenerRow[] = [];
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const inst = getInstrument(symbol);
    if (!inst || bars.length < 60) continue;
    const n = bars.length;
    const prev = bars[n - 2]?.close ?? bars[n - 1].open;
    const changePct = ((bars[n - 1].close - prev) / prev) * 100;
    // volatility: stdev of last-20 log returns, annualized-free simple %
    const rets: number[] = [];
    for (let i = Math.max(1, n - 21); i < n; i++) rets.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length);
    const atrLine = atrFn(bars, 14);
    const lastAtr = atrLine.length ? atrLine[atrLine.length - 1].value : null;
    const row: ScreenerRow = {
      symbol, name: inst.name, assetClass: inst.assetClass,
      price: bars[n - 1].close,
      changePct: Math.round(changePct * 100) / 100,
      rsi: null,
      atrPct: lastAtr != null ? Math.round((lastAtr / bars[n - 1].close) * 10000) / 100 : null,
      volatilityPct: Math.round(sd * 10000) / 100,
      volume: bars[n - 1].volume ?? null,
      passed: true, failed: [],
    };
    for (const f of filters) {
      if (!checkFilter(f, bars, row)) { row.passed = false; row.failed.push(f.kind); }
    }
    rows.push(row);
  }
  return rows.sort((a, b) => Number(b.passed) - Number(a.passed) || b.changePct - a.changePct);
}

// ---- saved configurations ----------------------------------------------------

export interface ScreenerPreset { id: string; name: string; timeframe: Timeframe; filters: ScreenerFilter[]; }

export function newFilter(): ScreenerFilter {
  return { id: Math.random().toString(36).slice(2, 9), kind: "rsi", op: "below", value: 30, p1: 14, p2: 0 };
}
