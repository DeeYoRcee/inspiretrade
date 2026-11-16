/**
 * Legacy types + challenge metric math for the trading domain.
 *
 * The old client-side DEMO execution adapter (orders filled in the browser,
 * balances written to terminalDemo/{uid}) has been REMOVED — execution is now
 * server-authoritative (see hooks/use-trading.ts and api/_src/trading).
 * This file keeps the DemoPosition shape that prop-analytics consumes and
 * the challenge metric rules (target 8% / daily DD 5% / max DD 10%) computed
 * from SERVER account state.
 */
import { getInstrument } from "@shared/terminal";
import { exitPriceFor, quoteFromMid, type Quote } from "@shared/trading-engine";

export interface DemoAccount {
  label: string;
  balance: number;
  startingBalance: number;
  createdAt: number;
  dayStart: Record<string, number>;
}

export interface DemoPosition {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;
  status: "open" | "closed";
  exit?: number;
  profit?: number;
  closedAt?: number;
  comment?: string;
}

/** Server account subset needed by the challenge metrics. */
export interface ChallengeAccountInput {
  balance: number;
  startingBalance: number;
  leverage: number;
  dayStart: Record<string, number>;
  metrics: { floatingPnl: number; equity: number; usedMargin: number; openCount: number };
  positions: { symbol: string; side: "buy" | "sell"; lots: number; entry: number; sl: number | null }[];
}

export interface ChallengeMetrics {
  balance: number;
  equity: number;
  startingBalance: number;
  profit: number;
  profitPct: number;
  profitTargetPct: number;
  profitTarget: number;
  dailyDrawdownLimit: number;
  maxDrawdownLimit: number;
  currentDailyDD: number;
  currentMaxDD: number;
  remainingDaily: number;
  remainingMax: number;
  breached: boolean;
  targetReached: boolean;
  openRisk: number;
}

/** Floating P/L in USD for one position against a live mid price.
 *  Exact for USD-quoted instruments; non-USD quotes are a reference
 *  approximation — the server settles the authoritative number. */
export function floatingProfit(pos: { symbol: string; side: "buy" | "sell"; lots: number; entry: number }, price: number): number {
  const inst = getInstrument(pos.symbol);
  if (!inst) return 0;
  const q: Quote = quoteFromMid(price, inst, "live-client", true);
  const diff = pos.side === "buy" ? exitPriceFor("buy", q) - pos.entry : pos.entry - exitPriceFor("sell", q);
  return diff * pos.lots * inst.contractSize;
}

/** Challenge metrics from SERVER account state (authoritative numbers). */
export function computeChallengeMetrics(
  account: ChallengeAccountInput,
  prices: Record<string, number>,
  opts: { profitTargetPct?: number; dailyDDPct?: number; maxDDPct?: number } = {},
): ChallengeMetrics {
  const profitTargetPct = opts.profitTargetPct ?? 8;
  const dailyDDPct = opts.dailyDDPct ?? 5;
  const maxDDPct = opts.maxDDPct ?? 10;

  const starting = account.startingBalance || 1;
  const today = new Date().toISOString().slice(0, 10);
  const dayStartBalance = account.dayStart?.[today] ?? account.balance;

  // open risk: distance to SL (USD, reference — quote ccy conversion approximated)
  let openRisk = 0;
  for (const p of account.positions) {
    const inst = getInstrument(p.symbol);
    if (p.sl) openRisk += Math.abs(p.entry - p.sl) * p.lots * (inst?.contractSize ?? 1);
  }

  const equity = account.metrics.equity;
  const profit = equity - starting;
  const currentMaxDD = Math.max(0, starting - equity);
  const currentDailyDD = Math.max(0, dayStartBalance - equity);
  const profitTarget = starting * (profitTargetPct / 100);

  return {
    balance: account.balance,
    equity,
    startingBalance: starting,
    profit,
    profitPct: (profit / starting) * 100,
    profitTargetPct,
    profitTarget,
    dailyDrawdownLimit: starting * (dailyDDPct / 100),
    maxDrawdownLimit: starting * (maxDDPct / 100),
    currentDailyDD,
    currentMaxDD,
    remainingDaily: Math.max(0, starting * (dailyDDPct / 100) - currentDailyDD),
    remainingMax: Math.max(0, starting * (maxDDPct / 100) - currentMaxDD),
    breached: currentDailyDD >= starting * (dailyDDPct / 100) || currentMaxDD >= starting * (maxDDPct / 100),
    targetReached: profit >= profitTarget,
    openRisk,
  };
}
