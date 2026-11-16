const RARITY_META = {
  common: { label: "Common", color: "#b0c3d9", order: 0 },
  rare: { label: "Rare", color: "#4b69ff", order: 1 },
  epic: { label: "Epic", color: "#8847ff", order: 2 },
  covert: { label: "Covert", color: "#eb4b4b", order: 3 },
  mythic: { label: "Mythic", color: "#ffd700", order: 4 }
};
const PROP_ACCOUNT_LABEL = "5k$ Prop";
const FRAGMENTS = [
  { id: "discipline", name: "5k$ 1", icon: "ShieldCheck", rarity: "common", dropPercent: 35 },
  { id: "patience", name: "5k$ 2", icon: "Hourglass", rarity: "common", dropPercent: 35 },
  { id: "risk-management", name: "5k$ 3", icon: "Scale", rarity: "rare", dropPercent: 8 },
  { id: "backtesting", name: "5k$ 4", icon: "FlaskConical", rarity: "rare", dropPercent: 8 },
  { id: "trading-plan", name: "5k$ 5", icon: "ClipboardList", rarity: "epic", dropPercent: 5 },
  { id: "psychology", name: "5k$ 6", icon: "Brain", rarity: "epic", dropPercent: 5 },
  { id: "consistency", name: "5k$ 7", icon: "Repeat", rarity: "covert", dropPercent: 2.9995 },
  { id: "execution", name: "5k$ 8", icon: "Crosshair", rarity: "covert", dropPercent: 2.9995 },
  { id: "master-trader", name: "5k$ 9", icon: "Crown", rarity: "mythic", dropPercent: 1e-3 }
];
const GOLD_ACCOUNT_LABEL = "10k$ Prop";
const GOLD_FRAGMENTS = [
  { id: "gold-1", name: "10k$ 1", icon: "Gem", rarity: "common", dropPercent: 35 },
  { id: "gold-2", name: "10k$ 2", icon: "Zap", rarity: "common", dropPercent: 35 },
  { id: "gold-3", name: "10k$ 3", icon: "Star", rarity: "rare", dropPercent: 8 },
  { id: "gold-4", name: "10k$ 4", icon: "Target", rarity: "rare", dropPercent: 8 },
  { id: "gold-5", name: "10k$ 5", icon: "Medal", rarity: "epic", dropPercent: 5 },
  { id: "gold-6", name: "10k$ 6", icon: "Trophy", rarity: "epic", dropPercent: 5 },
  { id: "gold-7", name: "10k$ 7", icon: "Rocket", rarity: "covert", dropPercent: 2.9995 },
  { id: "gold-8", name: "10k$ 8", icon: "Diamond", rarity: "covert", dropPercent: 2.9995 },
  { id: "gold-9", name: "10k$ 9", icon: "Crown", rarity: "mythic", dropPercent: 1e-3 }
];
const CASES = {
  inspire: { id: "inspire", name: "Inspire Case", accountSize: 5e3, fragments: FRAGMENTS },
  gold: { id: "gold", name: "Gold Case", accountSize: 1e4, fragments: GOLD_FRAGMENTS }
};
const ALL_FRAGMENTS = [...FRAGMENTS, ...GOLD_FRAGMENTS];
const FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
const TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
const TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
const REWARD_CYCLE_DAYS = 7;
const GOLD_CASE_DAY = REWARD_CYCLE_DAYS;
const DAILY_CASES = 1;
const STREAK_BONUS_EVERY = REWARD_CYCLE_DAYS;
const MARKET_FEE_PERCENT = 10;
const MAX_ACTIVE_LISTINGS = 20;
const MIN_LISTING_PRICE = 0.01;
const MAX_LISTING_PRICE = 1e6;
function getFragment(id) {
  return ALL_FRAGMENTS.find((f) => f.id === id);
}
function getCase(type) {
  return CASES[type];
}
function sellerReceives(price) {
  const cents = Math.round(price * 100);
  return (cents - Math.round(cents * MARKET_FEE_PERCENT / 100)) / 100;
}
function cycleDayOf(streak) {
  return (Math.max(1, streak) - 1) % REWARD_CYCLE_DAYS + 1;
}
function caseTypeForCycleDay(day) {
  return day >= GOLD_CASE_DAY ? "gold" : "inspire";
}
export {
  ALL_FRAGMENTS,
  CASES,
  DAILY_CASES,
  FRAGMENTS,
  FRAGMENT_IDS,
  GOLD_ACCOUNT_LABEL,
  GOLD_CASE_DAY,
  GOLD_FRAGMENTS,
  MARKET_FEE_PERCENT,
  MAX_ACTIVE_LISTINGS,
  MAX_LISTING_PRICE,
  MIN_LISTING_PRICE,
  PROP_ACCOUNT_LABEL,
  RARITY_META,
  REWARD_CYCLE_DAYS,
  STREAK_BONUS_EVERY,
  TOTAL_DROP_WEIGHT,
  TOTAL_DROP_WEIGHT_GOLD,
  caseTypeForCycleDay,
  cycleDayOf,
  getCase,
  getFragment,
  sellerReceives
};
