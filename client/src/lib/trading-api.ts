/**
 * Trading API client — typed access to the server-authoritative trading
 * engine (/api/trading). Every call carries the caller's Firebase ID token
 * (via authedFetch); the server verifies it and enforces account ownership.
 * Clients have NO direct Firestore access to the trading domain.
 */
import { authedFetch } from "@/lib/api";
import type { Quote, Side, OrderKind, PropRules, RuleEvaluation, AccountStatus } from "@shared/trading-engine";

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
  /** trailing-stop distance in % of price (0 = off) — P54 §4 */
  tsPct?: number;
  openedAt: number;
  /** accumulated overnight swap (USD, signed) — server-settled */
  swapAccrued?: number;
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
  tsPct?: number;
  expiryAt?: number | null;
  createdAt: number;
}

export interface ServerAccount {
  id: string;
  label: string;
  type: "DEMO" | "CHALLENGE";
  /** challenge template this account was assigned from (admin-managed) */
  challengeTypeId: string | null;
  challengeName: string | null;
  balance: number;
  startingBalance: number;
  leverage: number;
  createdAt: number;
  /** challenge period start (admin reset restarts it) */
  startedAt: number | null;
  status: AccountStatus;
  rules: PropRules | null;
  failedReason: string | null;
  /** admin freeze — trading blocked while set */
  adminSuspended: boolean;
  peakEquity: number;
  /** distinct UTC days with closed trades */
  tradingDays: number;
  /** running win/loss counters (server-side) */
  stats: { totalTrades: number; wins: number; losses: number };
  dayStart: Record<string, number>;
  /** live rule evaluation (null for DEMO accounts) */
  ruleState: RuleEvaluation | null;
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
  /** overnight swap charged over the life of the position (USD) */
  swap: number;
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
  /** P54 §2 — optional pending-order expiry (UNIX ms); GTC omits it */
  expiryAt?: number | null;
  comment?: string;
}

export interface CreateAccountArgs {
  label?: string;
  startingBalance?: number;
  /** leverage for margin math (clamped server-side, default 100) */
  leverage?: number;
  /** prop-firm rules → CHALLENGE account; omit for a plain DEMO */
  rules?: PropRules | null;
}

export const tradingApi = {
  getAccounts: () => authedFetch<{ accounts: ServerAccount[] }>("/api/trading?action=accounts").then((r) => r.accounts),

  createAccount: (args: CreateAccountArgs = {}) =>
    authedFetch<{ account: ServerAccount }>("/api/trading?action=create", args).then((r) => r.account),

  placeOrder: (args: PlaceOrderArgs) =>
    authedFetch<{ position: ServerPosition | null; order: ServerOrder | null; entry: number; quote: Quote }>(
      "/api/trading?action=order",
      args as unknown as Record<string, unknown>,
    ),

  closePosition: (accountId: string, positionId: string, lots?: number) =>
    authedFetch<{ closed: ServerTrade; metrics: TradingMetrics }>(
      "/api/trading?action=close", { accountId, positionId, lots: lots ?? null },
    ),

  closeAll: (accountId: string) =>
    authedFetch<{ closed: ServerTrade[]; metrics: TradingMetrics }>(
      "/api/trading?action=close-all", { accountId },
    ),

  modifyPosition: (accountId: string, positionId: string, patch: { sl?: number | null; tp?: number | null; tsPct?: number }) =>
    authedFetch<{ ok: boolean }>("/api/trading?action=modify", { accountId, positionId, ...patch }),

  modifyOrder: (accountId: string, orderId: string, patch: { price?: number; lots?: number; sl?: number | null; tp?: number | null; tsPct?: number }) =>
    authedFetch<{ ok: boolean }>("/api/trading?action=modify-order", { accountId, orderId, ...patch }),

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

// ---------------------------------------------------------------------------
// Prop-firm platform (Phase 6) — challenge types, leaderboard, admin
// ---------------------------------------------------------------------------

export interface ChallengeTypeInfo {
  id: string;
  name: string;
  size: number;
  profitTargetPct: number | null;
  dailyLossLimitPct: number | null;
  maxDrawdownPct: number | null;
  minTradingDays: number;
  maxTradingDays: number | null;
  maxLotsPerOrder: number | null;
  maxLotsTotal: number | null;
  maxOpenPositions: number | null;
  leverage: number;
  active: boolean;
  description: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface LeaderboardRow {
  rank: number;
  name: string;
  profitPct: number;
  profitUsd: number;
  winRate: number | null;
  trades: number;
  status: string;
  size: number;
  challengeName: string | null;
}

export interface AdminAccountRow {
  uid: string;
  aid: string;
  label: string;
  challengeName: string | null;
  challengeTypeId: string | null;
  balance: number;
  startingBalance: number;
  profitPct: number;
  status: AccountStatus;
  adminSuspended: boolean;
  failedReason: string | null;
  stats: { totalTrades: number; wins: number; losses: number };
  tradingDays: number;
  startedAt: number | null;
  createdAt: number;
  traderName: string;
}

export interface AdminAuditEntry {
  id: string;
  at: number;
  by: string;
  action: string;
  uid?: string;
  aid?: string;
  challengeTypeId?: string;
  name?: string;
  size?: number;
  enabled?: boolean;
  closed?: number;
}

export const propApi = {
  listChallengeTypes: () =>
    authedFetch<{ types: ChallengeTypeInfo[] }>("/api/trading?action=challenge-types").then((r) => r.types),

  getLeaderboard: (period: string) =>
    authedFetch<{ enabled: boolean; period: string; rows: LeaderboardRow[] }>(
      `/api/trading?action=leaderboard&period=${encodeURIComponent(period)}`,
    ),

  // ---- admin ----
  adminListChallengeTypes: () =>
    authedFetch<{ types: ChallengeTypeInfo[] }>("/api/trading?action=admin-challenge-types").then((r) => r.types),

  adminSaveChallengeType: (body: Partial<ChallengeTypeInfo> & { id?: string }) =>
    authedFetch<ChallengeTypeInfo>("/api/trading?action=admin-challenge-type-save", body),

  adminDeleteChallengeType: (id: string) =>
    authedFetch<{ ok: boolean }>("/api/trading?action=admin-challenge-type-delete", { id }),

  adminAssignAccount: (args: { target?: string; uid?: string; username?: string; typeId: string }) =>
    authedFetch<{ uid: string; account: { id: string; label: string } }>("/api/trading?action=admin-assign", args),

  adminListAccounts: (status = "all") =>
    authedFetch<{ accounts: AdminAccountRow[] }>(`/api/trading?action=admin-accounts&status=${encodeURIComponent(status)}`)
      .then((r) => r.accounts),

  adminAccountDetail: (uid: string, aid: string) =>
    authedFetch<any>(`/api/trading?action=admin-account-detail&uid=${encodeURIComponent(uid)}&aid=${encodeURIComponent(aid)}`),

  adminAccountAction: (uid: string, aid: string, action: "suspend" | "reactivate" | "reset") =>
    authedFetch<{ ok: boolean }>("/api/trading?action=admin-account-action", { uid, aid, action }),

  adminLeaderboardToggle: (enabled: boolean) =>
    authedFetch<{ enabled: boolean }>("/api/trading?action=admin-leaderboard-toggle", { enabled }),

  adminAudit: (filter: { uid?: string; aid?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.uid) q.set("uid", filter.uid);
    if (filter.aid) q.set("aid", filter.aid);
    return authedFetch<{ entries: AdminAuditEntry[] }>(`/api/trading?action=admin-audit&${q.toString()}`).then((r) => r.entries);
  },

  adminTrades: (uid: string, aid: string, limit = 200) =>
    authedFetch<{ trades: ServerTrade[] }>(
      `/api/trading?action=admin-trades&uid=${encodeURIComponent(uid)}&aid=${encodeURIComponent(aid)}&limit=${limit}`,
    ).then((r) => r.trades),
};
