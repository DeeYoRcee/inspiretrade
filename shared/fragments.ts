/**
 * Shared fragment / economy definitions.
 * Used by BOTH the client (via @shared alias) and the Vercel API functions
 * (via relative import). Keep this file dependency-free (no imports).
 */

export type Rarity = "common" | "rare" | "epic" | "covert" | "mythic";

export interface FragmentDef {
  id: string;
  name: string;
  /** lucide icon name — mapped to a component on the client */
  icon: string;
  rarity: Rarity;
  /** probability that a case drops this fragment, in percent (all sum to 100) */
  dropPercent: number;
}

/** CS2-inspired rarity palette */
export const RARITY_META: Record<
  Rarity,
  { label: string; color: string; order: number }
> = {
  common: { label: "Common", color: "#b0c3d9", order: 0 },
  rare: { label: "Rare", color: "#4b69ff", order: 1 },
  epic: { label: "Epic", color: "#8847ff", order: 2 },
  covert: { label: "Covert", color: "#eb4b4b", order: 3 },
  mythic: { label: "Mythic", color: "#ffd700", order: 4 },
};

/**
 * The 9 pieces of a $5,000 prop account (dropped by the Inspire Case).
 * Collect one of each to claim. Drop weights are CS2-style: reds are rare,
 * gold is the rarest. Rarity sums: common 70 · rare 16 · epic 10 ·
 * covert 5.999 · mythic 0.001 (weights sum to 102 — the server roll
 * normalizes by the total, the UI displays the per-rarity sums).
 *
 * Naming: pieces are named after the prop account they build —
 * a $5,000 account case drops "5k$ 1" … "5k$ 9" (piece numbers).
 * NOTE: `id` values are stored in RTDB and market listings — never rename them.
 */
export const PROP_ACCOUNT_LABEL = "5k$ Prop"; // matches the $5,000 prop account
export const FRAGMENTS: FragmentDef[] = [
  { id: "discipline",     name: "5k$ 1", icon: "ShieldCheck",   rarity: "common",  dropPercent: 35 },
  { id: "patience",       name: "5k$ 2", icon: "Hourglass",     rarity: "common",  dropPercent: 35 },
  { id: "risk-management",name: "5k$ 3", icon: "Scale",         rarity: "rare",    dropPercent: 8 },
  { id: "backtesting",    name: "5k$ 4", icon: "FlaskConical",  rarity: "rare",    dropPercent: 8 },
  { id: "trading-plan",   name: "5k$ 5", icon: "ClipboardList", rarity: "epic",    dropPercent: 5 },
  { id: "psychology",     name: "5k$ 6", icon: "Brain",         rarity: "epic",    dropPercent: 5 },
  { id: "consistency",    name: "5k$ 7", icon: "Repeat",        rarity: "covert",  dropPercent: 2.9995 },
  { id: "execution",      name: "5k$ 8", icon: "Crosshair",     rarity: "covert",  dropPercent: 2.9995 },
  { id: "master-trader",  name: "5k$ 9", icon: "Crown",         rarity: "mythic",  dropPercent: 0.001 },
];

/**
 * Gold Case — the Day-7 streak reward. Drops the 9 pieces of a $10,000
 * prop account ("10k$ 1" … "10k$ 9"). Same rarity curve as the Inspire Case.
 */
export const GOLD_ACCOUNT_LABEL = "10k$ Prop"; // matches the $10,000 prop account
export const GOLD_FRAGMENTS: FragmentDef[] = [
  { id: "gold-1", name: "10k$ 1", icon: "Gem",     rarity: "common",  dropPercent: 35 },
  { id: "gold-2", name: "10k$ 2", icon: "Zap",     rarity: "common",  dropPercent: 35 },
  { id: "gold-3", name: "10k$ 3", icon: "Star",    rarity: "rare",    dropPercent: 8 },
  { id: "gold-4", name: "10k$ 4", icon: "Target",  rarity: "rare",    dropPercent: 8 },
  { id: "gold-5", name: "10k$ 5", icon: "Medal",   rarity: "epic",    dropPercent: 5 },
  { id: "gold-6", name: "10k$ 6", icon: "Trophy",  rarity: "epic",    dropPercent: 5 },
  { id: "gold-7", name: "10k$ 7", icon: "Rocket",  rarity: "covert",  dropPercent: 2.9995 },
  { id: "gold-8", name: "10k$ 8", icon: "Diamond", rarity: "covert",  dropPercent: 2.9995 },
  { id: "gold-9", name: "10k$ 9", icon: "Crown",   rarity: "mythic",  dropPercent: 0.001 },
];

export type CaseType = "inspire" | "gold" | "trading";

export interface CaseDef {
  id: CaseType;
  name: string;
  /** prop account value this case builds, in USD */
  accountSize: number;
  fragments: FragmentDef[];
}

/**
 * Trading Case — Phase 32. The $25,000 prop account as a 9-piece puzzle
 * ("25k$ 1" … "25k$ 9"), built exactly like the Inspire/Gold cases. It is
 * the Day-7 VIP daily reward and can drop from owner grants. Same rarity
 * curve as the other two cases.
 */
export const TRADING_ACCOUNT_LABEL = "25k$ Prop"; // matches the $25,000 prop account
export const TRADING_FRAGMENTS: FragmentDef[] = [
  { id: "trade-1", name: "25k$ 1", icon: "Briefcase", rarity: "common",  dropPercent: 35 },
  { id: "trade-2", name: "25k$ 2", icon: "Gauge",     rarity: "common",  dropPercent: 35 },
  { id: "trade-3", name: "25k$ 3", icon: "LineChart", rarity: "rare",    dropPercent: 8 },
  { id: "trade-4", name: "25k$ 4", icon: "PieChart",  rarity: "rare",    dropPercent: 8 },
  { id: "trade-5", name: "25k$ 5", icon: "Activity",  rarity: "epic",    dropPercent: 5 },
  { id: "trade-6", name: "25k$ 6", icon: "BarChart3", rarity: "epic",    dropPercent: 5 },
  { id: "trade-7", name: "25k$ 7", icon: "Waves",     rarity: "covert",  dropPercent: 2.9995 },
  { id: "trade-8", name: "25k$ 8", icon: "Landmark",  rarity: "covert",  dropPercent: 2.9995 },
  { id: "trade-9", name: "25k$ 9", icon: "Crown",     rarity: "mythic",  dropPercent: 0.001 },
];

/** The case types of the economy. */
export const CASES: Record<CaseType, CaseDef> = {
  inspire: { id: "inspire", name: "Inspire Case", accountSize: 5000, fragments: FRAGMENTS },
  gold:    { id: "gold",    name: "Gold Case",    accountSize: 10000, fragments: GOLD_FRAGMENTS },
  trading: { id: "trading", name: "Trading Case", accountSize: 25000, fragments: TRADING_FRAGMENTS },
};

export const ALL_FRAGMENTS: FragmentDef[] = [...FRAGMENTS, ...GOLD_FRAGMENTS, ...TRADING_FRAGMENTS];

/** One pool row of a custom case: fragment id + raw weight + copy count. */
export interface CasePoolRow {
  id: string;
  weight: number;
  /** copies of this fragment in the pool (1-100, default 1) — P75 */
  qty?: number;
}

/**
 * P75 — expand a custom-case definition into the concrete roll pool.
 * Each row contributes `qty` copies of its fragment at the ROW's weight (the
 * roll normalizes by the total, so qty×weight is the exact share). Copies let
 * the owner express "put 25k$ 9 in nine times" explicitly and keep the saved
 * definition readable. Invalid rows (unknown id, bad weight) are dropped,
 * matching the server's historical behavior.
 */
export function expandCasePool(
  rows: CasePoolRow[],
  all: FragmentDef[] = ALL_FRAGMENTS,
): FragmentDef[] {
  const pool: FragmentDef[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const base = all.find((f) => f.id === row?.id);
    if (!base) continue;
    const weight = Number(row?.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const qty = Math.max(1, Math.min(100, Math.floor(Number(row?.qty) || 1)));
    for (let i = 0; i < qty; i++) pool.push({ ...base, dropPercent: weight });
  }
  return pool;
}

export const FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
export const TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
export const TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
export const TOTAL_DROP_WEIGHT_TRADING = TRADING_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);

// ---- Daily reward cycle (PUBG-style 7-day login calendar) -----------------
export const REWARD_CYCLE_DAYS = 7;        // day 1-6 → Inspire Case, day 7 → Gold Case
export const GOLD_CASE_DAY = REWARD_CYCLE_DAYS;
export const DAILY_CASES = 1;              // cases granted per claim

// ---- Economy tuning -------------------------------------------------------
export const STREAK_BONUS_EVERY = REWARD_CYCLE_DAYS;
export const MARKET_FEE_PERCENT = 10;      // seller fee (burned, CS2-like)
export const MAX_ACTIVE_LISTINGS = 50;     // per user — counts every listing kind
// (fragments + cases + custom cases + username listings), so 50 keeps the
// spam protection while letting a seller list their full inventory
export const MIN_LISTING_PRICE = 0.01;     // INSP (2-decimal precision)
export const MAX_LISTING_PRICE = 1000000;  // INSP

export function getFragment(id: string): FragmentDef | undefined {
  return ALL_FRAGMENTS.find((f) => f.id === id);
}

export function getCase(type: CaseType): CaseDef {
  return CASES[type];
}

/** Seller proceeds after the market fee, cent-accurate (prices are 2-decimal). */
export function sellerReceives(price: number): number {
  const cents = Math.round(price * 100);
  return (cents - Math.round((cents * MARKET_FEE_PERCENT) / 100)) / 100;
}

// ---- Referral milestones (Phase 32) ----------------------------------------
// One-time rewards for reaching an invited count, claimed from the Wallet.
// 3→1 InspireCase · 10→3 InspireCase · 25→5 InspireCase+1 GoldCase ·
// 50→7 InspireCase+3 GoldCase+5 INSP · 100→10 InspireCase+5 GoldCase+10 INSP.
export interface ReferralMilestoneTier { invited: number; cases: number; goldCases: number; insp: number }
export const REFERRAL_MILESTONES: ReferralMilestoneTier[] = [
  { invited: 3,   cases: 1,  goldCases: 0, insp: 0 },
  { invited: 10,  cases: 3,  goldCases: 0, insp: 0 },
  { invited: 25,  cases: 5,  goldCases: 1, insp: 0 },
  { invited: 50,  cases: 7,  goldCases: 3, insp: 5 },
  { invited: 100, cases: 10, goldCases: 5, insp: 10 },
];

/** Cycle day (1…7) for a given streak count AFTER the claim. */
export function cycleDayOf(streak: number): number {
  return ((Math.max(1, streak) - 1) % REWARD_CYCLE_DAYS) + 1;
}

export function caseTypeForCycleDay(day: number): CaseType {
  return day >= GOLD_CASE_DAY ? "gold" : "inspire";
}
