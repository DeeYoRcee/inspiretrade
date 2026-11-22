/**
 * terminal-bridge — PHASE 47: a tiny registry where the open chart publishes
 * its live snapshot (symbol, timeframe, closed bars, drawings) and the
 * client-side trading-alert engine reads it. No React state crossing, no
 * re-renders: PriceChart writes, TradingAlertsEngine polls every 5s.
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

let snapshot: TerminalSnapshot | null = null;

export function publishTerminalSnapshot(s: TerminalSnapshot): void {
  snapshot = s;
}

export function readTerminalSnapshot(): TerminalSnapshot | null {
  return snapshot;
}
