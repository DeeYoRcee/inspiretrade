/**
 * P45 — Whop client constants + helpers. The checkout URLs are the OFFICIAL
 * public links (spec §1 — never change them); prices match. The client never
 * confirms payments itself — it only opens Whop and tracks a PENDING state;
 * activation comes exclusively from the verified webhook / server verify.
 */

export const WHOP_CHECKOUT_URLS = {
  monthly: "https://whop.com/checkout/plan_52Mtr4TTs0xit",
  yearly: "https://whop.com/checkout/plan_NRZsRwd0VgKR4",
} as const;

export const WHOP_PLAN_IDS = {
  monthly: "plan_52Mtr4TTs0xit",
  yearly: "plan_NRZsRwd0VgKR4",
} as const;

export const WHOP_PRICES = { monthly: 4.99, yearly: 49.99 } as const;

/** 12 × $4.99 = $59.88 → yearly saves $9.89 (≈16.5%, shown as 17%) */
export const YEARLY_SAVINGS = { amount: 9.89, percent: 17 } as const;

export type WhopPlanKey = "monthly" | "yearly" | "lifetime";

export interface WhopSubscription {
  isPremium: boolean;
  plan: WhopPlanKey | null;
  status: string | null;
  currentPeriodEnd: string | null;
  /** epoch ms — when premium was first obtained (null = unknown) */
  premiumSince: number | null;
  manageUrl: string | null;
  source: "whop" | "admin" | null;
  /** true when the Whop API could not be reached (persisted profile used) */
  degraded?: boolean;
  configured?: boolean;
}

export function parseWhopSubscription(data: unknown): WhopSubscription {
  const d = (data ?? {}) as Record<string, unknown>;
  const plan = typeof d.plan === "string" && ["monthly", "yearly", "lifetime"].includes(d.plan)
    ? (d.plan as WhopPlanKey)
    : null;
  return {
    isPremium: d.isPremium === true,
    plan,
    status: typeof d.status === "string" ? d.status : null,
    currentPeriodEnd: typeof d.currentPeriodEnd === "string" ? d.currentPeriodEnd : null,
    premiumSince: typeof d.premiumSince === "number" ? d.premiumSince : null,
    manageUrl: typeof d.manageUrl === "string" && d.manageUrl.startsWith("https://") ? d.manageUrl : null,
    source: d.source === "whop" || d.source === "admin" ? d.source : null,
    degraded: d.degraded === true,
    configured: d.configured !== false,
  };
}

// ---------------------------------------------------------------------------
// PENDING-VERIFICATION state (§6): after the user clicks Subscribe we record
// a timestamp; while the profile is not premium yet but a recent pending
// click exists, the UI shows "verifying payment" instead of a plan card.
// Auto-expires after 30 minutes.
// ---------------------------------------------------------------------------

const PENDING_PREFIX = "it_whop_pending_";
const PENDING_TTL_MS = 30 * 60 * 1000;

export function setWhopPending(uid: string): void {
  if (!uid) return;
  try { localStorage.setItem(PENDING_PREFIX + uid, String(Date.now())); } catch { /* private mode */ }
}

export function whopPendingMs(uid: string): number | null {
  if (!uid) return null;
  try {
    const raw = localStorage.getItem(PENDING_PREFIX + uid);
    if (!raw) return null;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return null;
    const age = Date.now() - ts;
    if (age < 0 || age > PENDING_TTL_MS) { clearWhopPending(uid); return null; }
    return age;
  } catch { return null; }
}

export function clearWhopPending(uid: string): void {
  if (!uid) return;
  try { localStorage.removeItem(PENDING_PREFIX + uid); } catch { /* private mode */ }
}

/** localized date for renewal/expiration display */
export function whopFormatDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try { return new Intl.DateTimeFormat(lang === "uz" ? "en-GB" : lang, { year: "numeric", month: "short", day: "numeric" }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}
