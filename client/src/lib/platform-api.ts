/**
 * Platform management API client (Phase 7) — /api/admin?action=… surface.
 * The server resolves the caller's role and enforces the permission matrix;
 * these helpers only shape the requests.
 */
import { authedFetch } from "./api";

export interface AdminUserRow {
  uid: string;
  email: string;
  displayName: string;
  username: string | null;
  emailVerified: boolean;
  disabled: boolean;
  restricted: boolean;
  creationTime: number;
  lastSignInTime: number | null;
  coins: number | null;
  role: string | null;
}

export interface AdminAccountSummary {
  aid: string;
  label: string;
  type: "DEMO" | "CHALLENGE";
  challengeName: string | null;
  balance: number;
  startingBalance: number;
  profitPct: number;
  status: string;
  adminSuspended: boolean;
  leverage: number;
  stats: { totalTrades: number; wins: number; losses: number };
  tradingDays: number;
  createdAt: number | null;
  rules: Record<string, unknown> | null;
  failedReason: string | null;
}

export interface AdminUserDetail extends AdminUserRow {
  ceo: boolean;
  provider: string[];
  economy: { coins: number | null; cases: number | null; goldCases: number | null; totalClaimed: number | null };
  profileBio: string | null;
  accounts: AdminAccountSummary[];
  challengeProgress: { assigned: number; passed: number; failed: number; active: number; totalTrades: number; wins: number };
  notes: { id: string; at: number; by: string; text: string }[];
  activity: { id: string; at: number; type?: string; amount?: number; note?: string }[];
}

export interface AdminAnalytics {
  users: { total: number; new30d: number; active30d: number; suspended: number; registrationsByDay: { day: string; count: number }[] };
  accounts: { total: number; demo: number; challenge: number; challengeActive: number; challengePassed: number; challengeFailed: number; challengeSuspended: number };
  trading: { closedTrades: number; openPositions: number; volumeUsd: number };
  activity: { tradesByDay: { day: string; count: number }[] };
}

export interface MonitorAccount {
  uid: string;
  aid: string;
  traderName: string;
  label: string;
  type: string;
  challengeName: string | null;
  balance: number;
  startingBalance: number;
  equity: number;
  floatingPnl: number;
  status: string;
  adminSuspended: boolean;
  flags: string[];
  positions: { id: string; symbol: string; side: string; lots: number; entry: number; sl: number | null; tp: number | null; openedAt: number; notionalUsd: number }[];
}

export interface MonitorData {
  accounts: MonitorAccount[];
  exposure: { symbol: string; lots: number; notionalUsd: number }[];
  recentTrades: Record<string, unknown>[];
  openAccounts: number;
}

export interface AdminAlert {
  id: string;
  at: number;
  type: string;
  severity: string;
  text: string;
  uid?: string;
  read?: boolean;
}

export interface PlatformSettingsShape {
  maintenanceMode: boolean;
  registrationOpen: boolean;
  symbolsMode: "all" | "custom";
  customSymbols: string[];
  defaultAccountBalance: number;
  defaultChallenge: { profitTargetPct: number | null; dailyLossLimitPct: number | null; maxDrawdownPct: number | null; minTradingDays: number; maxTradingDays: number | null; maxOpenPositions: number | null };
  allowedLeverages: number[];
  defaultLeverage: number;
  maxLotPerOrder: number | null;
  commissionPerLotUsd: number;
  spreadMultiplier: number;
}

export interface PlatformRoles {
  roles: { uid: string; role: string; name: string | null }[];
  myRole: string | null;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  return q.toString();
};

export const platformApi = {
  usersList: (q = "", status = "all") =>
    authedFetch<{ users: AdminUserRow[]; total: number; filtered: number }>(
      `/api/admin?action=users-list&${qs({ q, status })}`,
    ),
  userDetail: (uid: string) =>
    authedFetch<AdminUserDetail>(`/api/admin?action=user-detail&${qs({ uid })}`),
  setUserState: (uid: string, action: "suspend" | "reactivate" | "restrict" | "unrestrict") =>
    authedFetch<{ ok: boolean }>(`/api/admin?action=user-set-state`, { uid, action }),
  addNote: (uid: string, text: string) =>
    authedFetch<{ ok: boolean; id: string }>(`/api/admin?action=user-note`, { uid, text }),
  createAccount: (uid: string, label: string, startingBalance: number, leverage: number) =>
    authedFetch<{ uid: string; account: { id: string } }>(`/api/admin?action=admin-account-create`, {
      uid, label, startingBalance, leverage,
    }),
  analytics: () => authedFetch<AdminAnalytics>(`/api/admin?action=analytics`),
  liveMonitor: () => authedFetch<MonitorData>(`/api/admin?action=live-monitor`),
  alerts: () => authedFetch<{ alerts: AdminAlert[]; unread: number }>(`/api/admin?action=admin-alerts`),
  markAlertsRead: (ids?: string[]) =>
    authedFetch<{ ok: boolean; marked: number }>(`/api/admin?action=admin-alerts-read`, { ids: ids ?? [] }),
  getSettings: () => authedFetch<{ settings: PlatformSettingsShape }>(`/api/admin?action=admin-settings-get`),
  saveSettings: (settings: Partial<PlatformSettingsShape>) =>
    authedFetch<{ settings: PlatformSettingsShape }>(`/api/admin?action=admin-settings-save`, { settings }),
  getRoles: () => authedFetch<PlatformRoles>(`/api/admin?action=admin-roles-get`),
  setRole: (uid: string, role: string) =>
    authedFetch<{ ok: boolean }>(`/api/admin?action=admin-roles-set`, { uid, role }),
};
