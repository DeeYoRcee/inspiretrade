/**
 * Phase 57 — Unified Trading Journal: trade source classification.
 *
 * Every journal trade carries an explicit, reliable source:
 *  - "prop"     — executed on an InspireTrade Prop/Demo account, auto-synced
 *                 from the server-authoritative trading system (never user
 *                 selectable — manual entries can never claim it).
 *  - "external" — executed on an outside broker (MT5 / cTrader / TradingView
 *                 connected brokers / …), added manually or via CSV import;
 *                 the broker name is preserved when provided.
 *  - "manual"   — typed in by hand with no broker integration (default for
 *                 legacy entries that predate the source field).
 *
 * Pure helpers only — no Firebase / React imports — so tests can run them
 * directly under node --test.
 */
import type { Trade } from "@/hooks/use-trades";

export type TradeSource = "prop" | "external" | "manual";

export const TRADE_SOURCES: readonly TradeSource[] = ["prop", "external", "manual"];

/** Resolve the effective source of a journal trade (legacy rows → "manual"). */
export function tradeSource(trade: Pick<Trade, "source">): TradeSource {
  return trade.source === "prop" || trade.source === "external" ? trade.source : "manual";
}

/** Broker name for external trades (already trimmed by the writers). */
export function tradeBroker(trade: Pick<Trade, "source" | "brokerName">): string | null {
  return tradeSource(trade) === "external" && trade.brokerName ? trade.brokerName : null;
}

/** Match key used by CSV duplicate detection (time ±2 min tolerance). */
export function tradeMatchKey(
  t: { assetName: string; type: string; entryPrice: number; exitPrice: number; timestamp: number },
  timeToleranceMs = 2 * 60 * 1000,
): (candidate: { assetName: string; type: string; entryPrice: number; exitPrice: number; timestamp: number }) => boolean {
  return (c) =>
    c.assetName.toUpperCase() === t.assetName.toUpperCase() &&
    c.type === t.type &&
    Math.abs(c.entryPrice - t.entryPrice) < Math.max(1e-6, t.entryPrice * 1e-6) &&
    Math.abs(c.exitPrice - t.exitPrice) < Math.max(1e-6, t.exitPrice * 1e-6) &&
    Math.abs(c.timestamp - t.timestamp) <= timeToleranceMs;
}

export interface SourceStats {
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number; // 0..100, 0 when empty
}

export function emptySourceStats(): SourceStats {
  return { count: 0, wins: 0, losses: 0, netPnl: 0, winRate: 0 };
}

function accumulate(list: Pick<Trade, "profit">[]): SourceStats {
  const s = emptySourceStats();
  for (const t of list) {
    s.count += 1;
    s.netPnl += t.profit;
    if (t.profit > 0) s.wins += 1;
    else if (t.profit < 0) s.losses += 1;
  }
  s.winRate = s.count > 0 ? (s.wins / s.count) * 100 : 0;
  return s;
}

export interface JournalSourceStats {
  all: SourceStats;
  prop: SourceStats;
  external: SourceStats;
  manual: SourceStats;
  /** distinct broker names present among external trades */
  brokers: string[];
}

/** Full per-source breakdown. Official Prop performance ALWAYS stays in the
 *  server-authoritative records — this only classifies journal mirrors. */
export function computeSourceStats(trades: Trade[]): JournalSourceStats {
  const brokers = new Set<string>();
  for (const t of trades) {
    const b = tradeBroker(t);
    if (b) brokers.add(b);
  }
  return {
    all: accumulate(trades),
    prop: accumulate(trades.filter((t) => tradeSource(t) === "prop")),
    external: accumulate(trades.filter((t) => tradeSource(t) === "external")),
    manual: accumulate(trades.filter((t) => tradeSource(t) === "manual")),
    brokers: [...brokers].sort(),
  };
}

/** Filter predicate for the journal source filter (incl. broker-specific). */
export function sourceFilterPredicate(filter: string): (t: Trade) => boolean {
  if (filter === "all") return () => true;
  if (filter.startsWith("broker:")) {
    const broker = filter.slice("broker:".length);
    return (t) => tradeSource(t) === "external" && (t.brokerName ?? "") === broker;
  }
  return (t) => tradeSource(t) === filter;
}
