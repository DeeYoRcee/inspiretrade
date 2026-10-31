import type { Trade } from "@/hooks/use-trades";

export type PublicProfileSection = "statistics" | "strategy" | "winRate" | "history" | "notes";

export interface PublicProfileVisibility {
  statistics: boolean;
  strategy: boolean;
  winRate: boolean;
  history: boolean;
  notes: boolean;
}

export interface PublicProfileSettings {
  enabled: boolean;
  visibility: PublicProfileVisibility;
  strategy: string;
  notes: string;
  publishedUsername: string | null;
}

export interface PublicProfileStats {
  netPnl: number;
  totalTrades: number;
  profitFactor: number | null;
  maxDrawdown: number;
}

export interface PublicProfileTrade {
  id: string;
  assetName: string;
  type: "BUY" | "SELL";
  timestamp: number;
  profit: number;
}

export interface PublicProfileSnapshot {
  uid: string;
  username: string;
  usernameKey: string;
  displayName: string;
  updatedAt: number;
  statistics?: PublicProfileStats;
  winRate?: {
    rate: number;
    wins: number;
    total: number;
  };
  strategy?: string;
  history?: PublicProfileTrade[];
  notes?: string;
}

export function createDefaultPublicProfileSettings(): PublicProfileSettings {
  return {
    enabled: false,
    visibility: {
      statistics: false,
      strategy: false,
      winRate: false,
      history: false,
      notes: false,
    },
    strategy: "",
    notes: "",
    publishedUsername: null,
  };
}

export function normalizePublicProfileSettings(value: unknown): PublicProfileSettings {
  if (!value || typeof value !== "object") return createDefaultPublicProfileSettings();

  const raw = value as Record<string, unknown>;
  const visibility = raw.visibility && typeof raw.visibility === "object"
    ? raw.visibility as Record<string, unknown>
    : {};

  return {
    enabled: raw.enabled === true,
    visibility: {
      statistics: visibility.statistics === true,
      strategy: visibility.strategy === true,
      winRate: visibility.winRate === true,
      history: visibility.history === true,
      notes: visibility.notes === true,
    },
    strategy: typeof raw.strategy === "string" ? raw.strategy : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    publishedUsername: typeof raw.publishedUsername === "string"
      ? raw.publishedUsername.toLowerCase()
      : null,
  };
}

function calculateStatistics(trades: Trade[]): PublicProfileStats {
  const chronologicalTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const netPnl = chronologicalTrades.reduce((total, trade) => total + trade.profit, 0);
  const grossProfit = chronologicalTrades.reduce(
    (total, trade) => total + (trade.profit > 0 ? trade.profit : 0),
    0,
  );
  const grossLoss = chronologicalTrades.reduce(
    (total, trade) => total + (trade.profit < 0 ? Math.abs(trade.profit) : 0),
    0,
  );

  let runningPnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  for (const trade of chronologicalTrades) {
    runningPnl += trade.profit;
    peakPnl = Math.max(peakPnl, runningPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - runningPnl);
  }

  return {
    netPnl,
    totalTrades: chronologicalTrades.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdown,
  };
}

export function createPublicProfileSnapshot({
  uid,
  username,
  displayName,
  trades,
  settings,
}: {
  uid: string;
  username: string;
  displayName: string;
  trades: Trade[];
  settings: PublicProfileSettings;
}): PublicProfileSnapshot {
  const usernameKey = username.trim().toLowerCase();
  const snapshot: PublicProfileSnapshot = {
    uid,
    username: username.trim(),
    usernameKey,
    displayName: displayName.trim() || username.trim(),
    updatedAt: Date.now(),
  };

  if (settings.visibility.statistics) {
    snapshot.statistics = calculateStatistics(trades);
  }

  if (settings.visibility.winRate) {
    const wins = trades.filter((trade) => trade.profit > 0).length;
    snapshot.winRate = {
      rate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      wins,
      total: trades.length,
    };
  }

  if (settings.visibility.strategy && settings.strategy.trim()) {
    snapshot.strategy = settings.strategy.trim();
  }

  if (settings.visibility.history) {
    snapshot.history = [...trades]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10)
      .map((trade) => ({
        id: trade.id,
        assetName: trade.assetName,
        type: trade.type,
        timestamp: trade.timestamp,
        profit: trade.profit,
      }));
  }

  if (settings.visibility.notes && settings.notes.trim()) {
    snapshot.notes = settings.notes.trim();
  }

  return snapshot;
}

export function formatPublicMoney(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Math.abs(value));

  return `${value < 0 ? "−" : "+"}${formatted}`;
}
