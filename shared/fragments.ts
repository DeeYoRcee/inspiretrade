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
 * gold is the rarest. Sum of dropPercent must equal exactly 100.
 *
 * Naming: pieces are named after the prop account they build —
 * a $5,000 account case drops "5k$ 1" … "5k$ 9" (piece numbers).
 * NOTE: `id` values are stored in RTDB and market listings — never rename them.
 */
export const PROP_ACCOUNT_LABEL = "5k$"; // matches the $5,000 prop account
export const FRAGMENTS: FragmentDef[] = [
  { id: "discipline",     name: "5k$ 1", icon: "ShieldCheck",   rarity: "common",  dropPercent: 20 },
  { id: "patience",       name: "5k$ 2", icon: "Hourglass",     rarity: "common",  dropPercent: 20 },
  { id: "risk-management",name: "5k$ 3", icon: "Scale",         rarity: "rare",    dropPercent: 14 },
  { id: "backtesting",    name: "5k$ 4", icon: "FlaskConical",  rarity: "rare",    dropPercent: 14 },
  { id: "trading-plan",   name: "5k$ 5", icon: "ClipboardList", rarity: "epic",    dropPercent: 9 },
  { id: "psychology",     name: "5k$ 6", icon: "Brain",         rarity: "epic",    dropPercent: 9 },
  { id: "consistency",    name: "5k$ 7", icon: "Repeat",        rarity: "covert",  dropPercent: 5 },
  { id: "execution",      name: "5k$ 8", icon: "Crosshair",     rarity: "covert",  dropPercent: 5 },
  { id: "master-trader",  name: "5k$ 9", icon: "Crown",         rarity: "mythic",  dropPercent: 2 },
];

/**
 * Gold Case — the Day-7 streak reward. Drops the 9 pieces of a $10,000
 * prop account ("10k$ 1" … "10k$ 9"). Same CS2-style rarity curve.
 */
export const GOLD_ACCOUNT_LABEL = "10k$"; // matches the $10,000 prop account
export const GOLD_FRAGMENTS: FragmentDef[] = [
  { id: "gold-1", name: "10k$ 1", icon: "Gem",     rarity: "common",  dropPercent: 20 },
  { id: "gold-2", name: "10k$ 2", icon: "Zap",     rarity: "common",  dropPercent: 20 },
  { id: "gold-3", name: "10k$ 3", icon: "Star",    rarity: "rare",    dropPercent: 14 },
  { id: "gold-4", name: "10k$ 4", icon: "Target",  rarity: "rare",    dropPercent: 14 },
  { id: "gold-5", name: "10k$ 5", icon: "Medal",   rarity: "epic",    dropPercent: 9 },
  { id: "gold-6", name: "10k$ 6", icon: "Trophy",  rarity: "epic",    dropPercent: 9 },
  { id: "gold-7", name: "10k$ 7", icon: "Rocket",  rarity: "covert",  dropPercent: 5 },
  { id: "gold-8", name: "10k$ 8", icon: "Diamond", rarity: "covert",  dropPercent: 5 },
  { id: "gold-9", name: "10k$ 9", icon: "Crown",   rarity: "mythic",  dropPercent: 2 },
];

export type CaseType = "inspire" | "gold";

export interface CaseDef {
  id: CaseType;
  name: string;
  /** prop account value this case builds, in USD */
  accountSize: number;
  fragments: FragmentDef[];
}

/** The two case types of the economy. */
export const CASES: Record<CaseType, CaseDef> = {
  inspire: { id: "inspire", name: "Inspire Case", accountSize: 5000, fragments: FRAGMENTS },
  gold:    { id: "gold",    name: "Gold Case",    accountSize: 10000, fragments: GOLD_FRAGMENTS },
};

export const ALL_FRAGMENTS: FragmentDef[] = [...FRAGMENTS, ...GOLD_FRAGMENTS];

export const FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
export const TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
export const TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);

// ---- Daily reward cycle (PUBG-style 7-day login calendar) -----------------
export const REWARD_CYCLE_DAYS = 7;        // day 1-6 → Inspire Case, day 7 → Gold Case
export const GOLD_CASE_DAY = REWARD_CYCLE_DAYS;
export const DAILY_CASES = 1;              // cases granted per claim

// ---- Economy tuning -------------------------------------------------------
export const STREAK_BONUS_EVERY = REWARD_CYCLE_DAYS;
export const MARKET_FEE_PERCENT = 10;      // seller fee (burned, CS2-like)
export const MAX_ACTIVE_LISTINGS = 20;     // per user
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

/** Cycle day (1…7) for a given streak count AFTER the claim. */
export function cycleDayOf(streak: number): number {
  return ((Math.max(1, streak) - 1) % REWARD_CYCLE_DAYS) + 1;
}

export function caseTypeForCycleDay(day: number): CaseType {
  return day >= GOLD_CASE_DAY ? "gold" : "inspire";
}
