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
 * The 9 pieces of a prop account. Collect one of each to claim.
 * Drop weights are CS2-style: reds are rare, gold is the rarest.
 * Sum of dropPercent must equal exactly 100.
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

export const FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
export const TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);

// ---- Economy tuning -------------------------------------------------------
export const DAILY_COINS = 1;              // INSP granted per claim
export const STREAK_BONUS_EVERY = 7;       // every 7th consecutive day…
export const STREAK_BONUS_COINS = 2;       // …bonus INSP
export const STREAK_BONUS_CASES = 1;       // …bonus case
export const MARKET_FEE_PERCENT = 10;      // seller fee (burned, CS2-like)
export const MAX_ACTIVE_LISTINGS = 20;     // per user
export const MIN_LISTING_PRICE = 1;        // INSP
export const MAX_LISTING_PRICE = 1000000;  // INSP

export function getFragment(id: string): FragmentDef | undefined {
  return FRAGMENTS.find((f) => f.id === id);
}

export function sellerReceives(price: number): number {
  return Math.floor(price * (1 - MARKET_FEE_PERCENT / 100));
}
