/**
 * Professional trading calculators. Pure functions — the UI only renders
 * results. Contract specs come from shared/terminal.ts INSTRUMENTS (reference
 * CFD conventions documented there). For instruments whose quote currency is
 * not USD the functions accept `quoteToUsd` (quote-currency units per 1 USD)
 * so pip/margin values convert honestly; when not provided results are
 * returned in the QUOTE currency and the UI labels them as such.
 */
import { getInstrument, type InstrumentSpec } from "@shared/terminal";

export interface PipValueResult { valuePerLot: number; valueTotal: number; currency: string; converted: boolean }

/** Pip value per 1.00 lot and total, for a symbol. */
export function pipValue(symbol: string, lots: number, quoteToUsd = 1): PipValueResult {
  const inst = getInstrument(symbol);
  if (!inst) return { valuePerLot: 0, valueTotal: 0, currency: "USD", converted: false };
  const perLot = inst.pipSize * inst.contractSize; // quote currency
  const converted = inst.quote !== "USD" && quoteToUsd > 0;
  const v = converted ? perLot / quoteToUsd : perLot;
  return { valuePerLot: v, valueTotal: v * lots, currency: converted ? "USD" : inst.quote, converted };
}

/** Position size from risk: lots = riskUSD / (slPips × pipValuePerLot). */
export function positionSize(symbol: string, balance: number, riskPct: number, slPips: number, quoteToUsd = 1): { lots: number; riskUsd: number; pipValuePerLot: number } {
  const riskUsd = (balance * riskPct) / 100;
  const pv = pipValue(symbol, 1, quoteToUsd);
  const lots = pv.valuePerLot > 0 && slPips > 0 ? Math.floor((riskUsd / (slPips * pv.valuePerLot)) * 100) / 100 : 0;
  return { lots, riskUsd, pipValuePerLot: pv.valuePerLot };
}

/** Margin required: notional / leverage (quote ccy → USD when convertible). */
export function margin(symbol: string, lots: number, price: number, leverage: number, quoteToUsd = 1): { notional: number; margin: number; currency: string } {
  const inst = getInstrument(symbol);
  if (!inst) return { notional: 0, margin: 0, currency: "USD" };
  const notional = price * inst.contractSize * lots; // quote ccy
  const conv = inst.quote !== "USD" && quoteToUsd > 0 ? 1 / quoteToUsd : 1;
  return {
    notional: notional * conv,
    margin: leverage > 0 ? (notional * conv) / leverage : 0,
    currency: conv !== 1 ? "USD" : inst.quote,
  };
}

/** Profit/loss for a closed position (quote ccy → USD when convertible). */
export function profitLoss(symbol: string, side: "buy" | "sell", entry: number, exit: number, lots: number, quoteToUsd = 1): { pnl: number; pips: number; currency: string } {
  const inst = getInstrument(symbol);
  if (!inst) return { pnl: 0, pips: 0, currency: "USD" };
  const diff = side === "buy" ? exit - entry : entry - exit;
  const conv = inst.quote !== "USD" && quoteToUsd > 0 ? 1 / quoteToUsd : 1;
  return {
    pnl: diff * lots * inst.contractSize * conv,
    pips: diff / inst.pipSize,
    currency: conv !== 1 ? "USD" : inst.quote,
  };
}

export interface FibLevel { level: number; price: number; kind: "retracement" | "extension" }
export type FibLevels = FibLevel[];

/** Fibonacci retracement + extension levels from a swing low→high. */
export function fibonacci(low: number, high: number): FibLevels {
  const diff = high - low;
  const retr = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const ext = [1.272, 1.618, 2.0, 2.618];
  const out: FibLevels = [];
  for (const r of retr) out.push({ level: r, price: high - diff * r, kind: "retracement" });
  for (const e of ext) out.push({ level: e, price: high + diff * (e - 1), kind: "extension" });
  return out;
}

/** Max drawdown from an equity series (peak-to-trough, abs + % of peak). */
export function drawdown(equity: number[]): { maxDD: number; maxDDPct: number; peak: number; trough: number } {
  let peak = equity[0] ?? 0, maxDD = 0, maxPct = 0, p = 0, tr = 0;
  for (const v of equity) {
    if (v > peak) { peak = v; }
    const dd = peak - v;
    if (dd > maxDD) { maxDD = dd; maxPct = peak > 0 ? (dd / peak) * 100 : 0; p = peak; tr = v; }
  }
  return { maxDD, maxDDPct: maxPct, peak: p, trough: tr };
}

/** Compounding: balance after n periods of r% each (or with additions). */
export function compounding(start: number, ratePct: number, periods: number, perPeriodAdd = 0): number[] {
  const out = [start];
  let v = start;
  for (let i = 0; i < periods; i++) {
    v = v * (1 + ratePct / 100) + perPeriodAdd;
    out.push(v);
  }
  return out;
}

/** Risk/reward for a setup. */
export function riskReward(entry: number, sl: number, tp: number): { risk: number; reward: number; rr: number } {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return { risk, reward, rr: risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0 };
}

export interface SpecInfo { inst: InstrumentSpec; pipLabel: string }

/** Contract-spec summary for the calculators UI. */
export function specInfo(symbol: string): SpecInfo | null {
  const inst = getInstrument(symbol);
  if (!inst) return null;
  const pipLabel = inst.assetClass === "forex" ? `pip (${inst.pipSize})` : inst.assetClass === "crypto" ? `point (${inst.pipSize})` : inst.assetClass === "metal" ? `tick (${inst.pipSize})` : `index point (${inst.pipSize})`;
  return { inst, pipLabel };
}
