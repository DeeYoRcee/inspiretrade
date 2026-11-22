/**
 * terminal-bridge — PHASE 47/48: a tiny registry where open charts publish
 * their live snapshots (symbol, timeframe, closed bars, drawings) and the
 * client-side trading-alert engine reads them. No React state crossing, no
 * re-renders: PriceChart writes, TradingAlertsEngine polls every 5s.
 *
 * PHASE 48: multi-chart workspaces mount several charts — snapshots live in
 * a map keyed symbol:timeframe so each panel's alert conditions are always
 * evaluated against the RIGHT chart's data.
 */

import type { Bar, Timeframe } from "@shared/terminal";
import type { Drawing } from "@/lib/drawings";

export interface TerminalSnapshot {
  symbol: string;
  timeframe: Timeframe;
  /** the LIVE bar series the chart currently renders (replay-aware) */
  bars: Bar[];
  drawings: Drawing[];
  /** replay sessions must never trigger alerts — the future is hidden */
  replay: boolean;
  at: number;
}

const snapshots = new Map<string, TerminalSnapshot>();

const keyOf = (symbol: string, timeframe: Timeframe) => `${symbol}:${timeframe}`;

export function publishTerminalSnapshot(s: TerminalSnapshot): void {
  snapshots.set(keyOf(s.symbol, s.timeframe), s);
}

/** The snapshot for a symbol/timeframe, or — when omitted — the freshest one. */
export function readTerminalSnapshot(symbol?: string, timeframe?: Timeframe): TerminalSnapshot | null {
  if (symbol) {
    if (timeframe) return snapshots.get(keyOf(symbol, timeframe)) ?? null;
    for (const s of snapshots.values()) if (s.symbol === symbol) return s;
    return null;
  }
  let freshest: TerminalSnapshot | null = null;
  for (const s of snapshots.values()) if (!freshest || s.at > freshest.at) freshest = s;
  return freshest;
}
