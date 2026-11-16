/**
 * Trading API client — typed access to the server-authoritative trading
 * engine (/api/trading). Every call carries the caller's Firebase ID token
 * (via authedFetch); the server verifies it and enforces account ownership.
 * Clients have NO direct Firestore access to the trading domain.
 */
import { authedFetch } from "@/lib/api";
import type { Quote, Side, OrderKind } from "@shared/trading-engine";

export interface TradingMetrics {
  balance: number;
  floatingPnl: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number | null;
  openCount: number;
  updatedAt?: number;
}

export interface ServerPosition {
  id: string;
  symbol: string;
  side: Side;
  lots: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;
  comment?: string | null;
}

export interface ServerOrder {
  id: string;
  symbol: string;
  side: Side;
  kind: "limit" | "stop";
  lots: number;
  price: number;
  sl: number | null;
  tp: number | null;
  createdAt: number;
}

export interface ServerAccount {
  id: string;
  label: string;
  type: "DEMO";
  balance: number;
  startingBalance: number;
  leverage: number;
  createdAt: number;
  dayStart: Record<string, number>;
  positions: ServerPosition[];
  orders: ServerOrder[];
  metrics: TradingMetrics;
  quotes: Record<string, Quote>;
}

export interface ServerTrade {
  id: string;
  positionId: string;
  symbol: string;
  side: Side;
  lots: number;
  entry: number;
  exit: number;
  pnl: number;
  reason: string;
  openedAt: number;
  closedAt: number;
}

export interface PlaceOrderArgs {
  accountId: string;
  symbol: string;
  side: Side;
  lots: number;
  kind: OrderKind;
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
  comment?: string;
}

export const tradingApi = {
  getAccounts: () => authedFetch<{ accounts: ServerAccount[] }>("/api/trading?action=accounts").then((r) => r.accounts),

  createAccount: (label?: string, startingBalance?: number) =>
    authedFetch<{ account: ServerAccount }>("/api/trading?action=create", { label, startingBalance }).then((r) => r.account),

  placeOrder: (args: PlaceOrderArgs) =>
    authedFetch<{ position: ServerPosition | null; order: ServerOrder | null; entry: number; quote: Quote }>(
      "/api/trading?action=order",
      args as unknown as Record<string, unknown>,
    ),

  closePosition: (accountId: string, positionId: string, lots?: number) =>
    authedFetch<{ closed: ServerTrade; metrics: TradingMetrics }>(
      "/api/trading?action=close", { accountId, positionId, lots: lots ?? null },
    ),

  modifyPosition: (accountId: string, positionId: string, patch: { sl?: number | null; tp?: number | null }) =>
    authedFetch<{ ok: boolean }>("/api/trading?action=modify", { accountId, positionId, ...patch }),

  cancelOrder: (accountId: string, orderId: string) =>
    authedFetch<{ ok: boolean }>("/api/trading?action=cancel", { accountId, orderId }),

  evaluate: (accountId: string) =>
    authedFetch<{ metrics: TradingMetrics; realized: number; closed: ServerTrade[] }>(
      "/api/trading?action=evaluate", { accountId },
    ),

  resetAccount: (accountId: string) =>
    authedFetch<{ balance: number }>("/api/trading?action=reset", { accountId }),

  getHistory: (accountId: string, limit = 100) =>
    authedFetch<{ trades: ServerTrade[] }>(`/api/trading?action=history&accountId=${encodeURIComponent(accountId)}&limit=${limit}`)
      .then((r) => r.trades),
};
