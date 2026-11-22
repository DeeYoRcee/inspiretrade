/**
 * Phase 7 — platform administration core (PURE, no Firebase imports so the
 * test runner can exercise it directly).
 *
 * Role model: analyst < moderator < admin < super_admin. The matrix below is
 * the SINGLE source of truth enforced server-side on every admin action
 * (frontend checks are cosmetic only — never trusted).
 */

export type AdminRole = "analyst" | "moderator" | "admin" | "super_admin";

export const ROLE_RANK: Record<AdminRole, number> = {
  analyst: 1,
  moderator: 2,
  admin: 3,
  super_admin: 4,
};

export const ADMIN_ROLES: AdminRole[] = ["analyst", "moderator", "admin", "super_admin"];

/** Minimum role rank required per action (server-side enforced). */
export const ACTION_MIN_RANK: Record<string, number> = {
  // read-only surface — every admin role
  "users.read": 1,
  "analytics.read": 1,
  "monitor.read": 1,
  "audit.read": 1,
  "alerts.read": 1,
  "trades.read": 1,
  "settings.read": 1,
  "roles.read": 1,
  // moderator-level — account freezes + notes
  "account.suspend": 2,
  "user.note": 2,
  "alerts.manage": 2,
  // admin-level — mutations, assignments, destructive resets
  "user.suspend": 3,
  "account.assign": 3,
  "account.create": 3,
  "account.reset": 3,
  "challenge.write": 3,
  "leaderboard.toggle": 3,
  "settings.write": 3,
  // super-admin only — role management
  "roles.write": 4,
};

export function roleAtLeast(role: AdminRole | null | undefined, minRank: number): boolean {
  if (!role) return false;
  return (ROLE_RANK[role] || 0) >= minRank;
}

/** Can `role` perform `action`? Unknown actions default to super_admin only. */
export function can(role: AdminRole | null | undefined, action: string): boolean {
  const min = ACTION_MIN_RANK[action];
  return roleAtLeast(role, min === undefined ? 99 : min);
}

/** Mask an email for read-only roles: keep the first char + domain. */
export function maskEmail(email: string | null | undefined): string {
  const e = String(email || "");
  if (!e || !e.includes("@")) return "hidden";
  const [local, domain] = e.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, Math.min(8, local.length - 1)))}@${domain}`;
}

// ---------------------------------------------------------------------------
// Platform settings (Firestore platformSettings/global) — sanitized here so
// the server never trusts admin-supplied shapes.
// ---------------------------------------------------------------------------

export interface PlatformSettings {
  maintenanceMode: boolean;
  registrationOpen: boolean;
  /** "all" = every catalog instrument; "custom" = customSymbols only */
  symbolsMode: "all" | "custom";
  customSymbols: string[];
  defaultAccountBalance: number;
  defaultChallenge: {
    profitTargetPct: number | null;
    dailyLossLimitPct: number | null;
    maxDrawdownPct: number | null;
    minTradingDays: number;
    maxTradingDays: number | null;
    maxOpenPositions: number | null;
  };
  allowedLeverages: number[];
  defaultLeverage: number;
  maxLotPerOrder: number | null;
  /** USD commission charged per closed lot (round turn) */
  commissionPerLotUsd: number;
  /** multiplies the base per-instrument spread (0.5–5) */
  spreadMultiplier: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export const PLATFORM_SETTINGS_DEFAULTS: PlatformSettings = {
  maintenanceMode: false,
  registrationOpen: true,
  symbolsMode: "all",
  customSymbols: [],
  defaultAccountBalance: 10000,
  defaultChallenge: {
    profitTargetPct: 10,
    dailyLossLimitPct: 5,
    maxDrawdownPct: 10,
    minTradingDays: 3,
    maxTradingDays: 30,
    maxOpenPositions: 10,
  },
  allowedLeverages: [10, 20, 30, 50, 100, 200, 500],
  defaultLeverage: 100,
  maxLotPerOrder: null,
  commissionPerLotUsd: 0,
  spreadMultiplier: 1,
  updatedAt: null,
  updatedBy: null,
};

const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const optNum = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

const KNOWN_LEVERAGES = [10, 20, 30, 50, 100, 200, 500];

/** Sanitize an admin-supplied settings patch onto the current settings. */
export function sanitizePlatformSettings(raw: any, current?: PlatformSettings): PlatformSettings {
  const base = current || PLATFORM_SETTINGS_DEFAULTS;
  const allowed = Array.isArray(raw?.allowedLeverages)
    ? KNOWN_LEVERAGES.filter((l) => raw.allowedLeverages.includes(l))
    : base.allowedLeverages;
  const custom = Array.isArray(raw?.customSymbols)
    ? (Array.from(new Set<string>((raw.customSymbols as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean))) as string[]).slice(0, 60)
    : base.customSymbols;
  const dc = raw?.defaultChallenge || {};
  return {
    maintenanceMode: raw?.maintenanceMode === undefined ? base.maintenanceMode : !!raw.maintenanceMode,
    registrationOpen: raw?.registrationOpen === undefined ? base.registrationOpen : !!raw.registrationOpen,
    symbolsMode: raw?.symbolsMode === "custom" ? "custom" : raw?.symbolsMode === "all" ? "all" : base.symbolsMode,
    customSymbols: custom,
    defaultAccountBalance: num(raw?.defaultAccountBalance, 5_000, 1_000_000, base.defaultAccountBalance),
    defaultChallenge: {
      profitTargetPct: dc.profitTargetPct === undefined ? base.defaultChallenge.profitTargetPct : optNum(dc.profitTargetPct, 0.5, 100),
      dailyLossLimitPct: dc.dailyLossLimitPct === undefined ? base.defaultChallenge.dailyLossLimitPct : optNum(dc.dailyLossLimitPct, 0.5, 50),
      maxDrawdownPct: dc.maxDrawdownPct === undefined ? base.defaultChallenge.maxDrawdownPct : optNum(dc.maxDrawdownPct, 0.5, 50),
      minTradingDays: num(dc.minTradingDays, 0, 60, base.defaultChallenge.minTradingDays),
      maxTradingDays: dc.maxTradingDays === undefined ? base.defaultChallenge.maxTradingDays : optNum(dc.maxTradingDays, 0, 365),
      maxOpenPositions: dc.maxOpenPositions === undefined ? base.defaultChallenge.maxOpenPositions : optNum(dc.maxOpenPositions, 1, 30),
    },
    allowedLeverages: allowed.length ? allowed : base.allowedLeverages,
    defaultLeverage: allowed.includes(Number(raw?.defaultLeverage))
      ? Number(raw.defaultLeverage)
      : allowed.includes(base.defaultLeverage) ? base.defaultLeverage : base.defaultLeverage,
    maxLotPerOrder: raw?.maxLotPerOrder === undefined ? base.maxLotPerOrder : optNum(raw.maxLotPerOrder, 0.01, 100),
    commissionPerLotUsd: num(raw?.commissionPerLotUsd, 0, 100, base.commissionPerLotUsd),
    spreadMultiplier: num(raw?.spreadMultiplier, 0.5, 5, base.spreadMultiplier),
    updatedAt: Date.now(),
    updatedBy: null,
  };
}

// ---------------------------------------------------------------------------
// Analytics bucketing — registrations/trades per local-UTC day.
// ---------------------------------------------------------------------------

/** Bucket timestamps into the last `days` UTC days (oldest → newest, 0-filled). */
export function bucketByDay(timestamps: number[], days: number, now = Date.now()): { day: string; count: number }[] {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const buckets: { day: string; count: number; from: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = start.getTime() - i * 86_400_000;
    buckets.push({
      day: new Date(from).toISOString().slice(5, 10),
      count: 0,
      from,
    });
  }
  for (const ts of timestamps) {
    const t = Number(ts);
    if (!Number.isFinite(t)) continue;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const until = i + 1 < buckets.length ? buckets[i + 1].from : b.from + 86_400_000;
      if (t >= b.from && t < until) {
        b.count += 1;
        break;
      }
    }
  }
  return buckets.map(({ day, count }) => ({ day, count }));
}
