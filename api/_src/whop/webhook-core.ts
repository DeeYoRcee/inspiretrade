/**
 * P45 §4/§5 — pure decision helpers for the Whop webhook + verify flows.
 * Dependency-free (unit-tested in node); the server functions wrap these.
 *
 * Facts from the official Whop SDK (@whop/sdk resources/shared.d.ts):
 *   MembershipStatus = 'trialing' | 'active' | 'past_due' | 'completed' |
 *     'canceled' | 'expired' | 'unresolved' | 'drafted' | 'canceling'
 *   Membership: { id, status, cancel_at_period_end, canceled_at, metadata,
 *     plan: {id, metadata}, product: {id}, renewal_period_start/end,
 *     manage_url, user: {id, email, username} | null }
 */
/**
 * P45 §1 — the OFFICIAL plan ids (spec: exact, do not change). Exactly two
 * public plans: Monthly $4.99 (plan_52Mtr4TTs0xit) and Yearly $49.99
 * (plan_NRZsRwd0VgKR4). The legacy lifetime id stays mapped ONLY so webhook
 * events from existing lifetime memberships keep working (never revoked).
 */
export type WhopPlanKey = "monthly" | "yearly" | "lifetime";

export const WHOP_CHECKOUT_URLS = {
  monthly: "https://whop.com/checkout/plan_52Mtr4TTs0xit",
  yearly: "https://whop.com/checkout/plan_NRZsRwd0VgKR4",
} as const;

export const PLAN_BY_ID: Record<string, WhopPlanKey> = {
  plan_52Mtr4TTs0xit: "monthly", // official Monthly — $4.99/mo
  plan_NRZsRwd0VgKR4: "yearly", // official Yearly — $49.99/yr
  plan_OloGrVT1gLT5y: "lifetime", // LEGACY lifetime — kept for existing users only
};

export interface PublicPlan {
  key: "monthly" | "yearly";
  id: string;
  price: number;
  label: string;
  period: string;
  checkoutUrl: string;
}

/** The ONLY publicly purchasable plans — no lifetime. */
export const PUBLIC_PLANS: PublicPlan[] = [
  { key: "monthly", id: "plan_52Mtr4TTs0xit", price: 4.99, label: "Monthly", period: "/ mo", checkoutUrl: WHOP_CHECKOUT_URLS.monthly },
  { key: "yearly", id: "plan_NRZsRwd0VgKR4", price: 49.99, label: "Yearly", period: "/ yr", checkoutUrl: WHOP_CHECKOUT_URLS.yearly },
];

export const PREMIUM_PRODUCT_ID = "prod_cUlL0SOCTM3S7";

/** statuses that still carry access (past_due = failed-payment grace window) */
export const GRANT_STATUSES: ReadonlySet<string> = new Set([
  "active", "trialing", "completed", "canceling", "past_due",
]);
/** statuses that end access */
export const REVOKE_STATUSES: ReadonlySet<string> = new Set([
  "expired", "canceled", "unresolved", "drafted",
]);

export interface MembershipLike {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  canceled_at?: string | null;
  plan?: { id: string; metadata?: Record<string, unknown> | null } | null;
  product?: { id: string; metadata?: Record<string, unknown> | null } | null;
  user?: { email?: string | null } | null;
  member?: { id: string } | null;
  metadata?: Record<string, unknown> | null;
  renewal_period_start?: string | null;
  renewal_period_end?: string | null;
  manage_url?: string | null;
}

/** plan id → plan key (null for unknown plans — do not guess) */
export function planKeyForPlanId(planId: string | null | undefined): WhopPlanKey | null {
  if (!planId) return null;
  return PLAN_BY_ID[planId] ?? null;
}

/** true when the membership belongs to the InspireTrade Premium product */
export function isPremiumMembership(m: MembershipLike): boolean {
  return m.product?.id === PREMIUM_PRODUCT_ID;
}

export interface EntitlementDecision {
  grant: boolean;
  status: string;
  planKey: WhopPlanKey | null;
}

/**
 * The single source of truth for grant/revoke: the LIVE membership status
 * (per the official status enum). canceling keeps access until the period
 * ends (Whop flips it to canceled/expired then); past_due keeps access
 * during the payment-retry window; expired/canceled end it.
 */
export function decideEntitlement(m: MembershipLike): EntitlementDecision {
  const status = String(m.status || "");
  const planKey = planKeyForPlanId(m.plan?.id);
  return { grant: GRANT_STATUSES.has(status), status, planKey };
}

/** uid candidates from the membership metadata (checkout-session mapping) */
export function extractUidCandidates(m: MembershipLike): string[] {
  const out: string[] = [];
  const raw = m.metadata?.firebaseUid;
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 128) out.push(raw);
  return out;
}

/** payer email (lowercased) — the fallback mapping key */
export function extractEmail(m: MembershipLike): string | null {
  const e = m.user?.email;
  return typeof e === "string" && e.includes("@") ? e.trim().toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// P45 §4 — signature verification fallback (Standard Webhooks spec, exactly
// as documented by Whop): HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.
// {raw body}", base64-encoded, compared constant-time; the primary verifier
// is the official `whop.webhooks.unwrap` (standardwebhooks package). This
// fallback covers runtimes where the raw stream was already consumed.
// ---------------------------------------------------------------------------

import * as crypto from "crypto";

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60; // official: reject > 5 minutes skew

function signContent(id: string, timestamp: string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

function hmacBase64(secretCandidate: Buffer, content: string): string {
  return crypto.createHmac("sha256", secretCandidate).update(content).digest("base64");
}

/** key derivations: the standardwebhooks lib base64-decodes the whole secret
 *  string when there is no whsec_ prefix; also try stripped variants + raw. */
function secretCandidates(secret: string): Buffer[] {
  const out: Buffer[] = [];
  const push = (s: string) => {
    try { const b = Buffer.from(s, "base64"); if (b.length > 0) out.push(b); } catch { /* not base64 */ }
    out.push(Buffer.from(s, "utf8"));
  };
  push(secret);
  if (secret.startsWith("ws_")) push(secret.slice(3));
  if (secret.startsWith("whsec_")) push(secret.slice(6));
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface VerifyHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

/**
 * Verify a webhook per the Standard Webhooks spec (Whop's documented HMAC
 * scheme). Returns the parsed event envelope, or null when unverifiable —
 * callers MUST reject unverifiable deliveries.
 */
export function verifyWebhookSignature(
  body: string,
  headers: Partial<VerifyHeaders> | Record<string, string> | undefined,
  secret: string,
): { id: string; type: string; data: unknown } | null {
  if (!body || !headers || !secret) return null;
  const id = String(headers["webhook-id"] ?? "");
  const ts = String(headers["webhook-timestamp"] ?? "");
  const sigHeader = String(headers["webhook-signature"] ?? "");
  if (!id || !ts || !sigHeader) return null;

  // freshness (official tolerance: 5 minutes)
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > TIMESTAMP_TOLERANCE_SECONDS) return null;

  const expected = secretCandidates(secret).map((k) => hmacBase64(k, signContent(id, ts, body)));
  const provided = sigHeader.split(" ").flatMap((part) => part.startsWith("v1,") ? [part.slice(3)] : []);
  if (!provided.length || !expected.length) return null;
  const ok = expected.some((exp) => provided.some((sig) => safeEqual(exp, sig)));
  if (!ok) return null;

  try {
    const parsed = JSON.parse(body) as { id?: string; type?: string; data?: unknown };
    if (!parsed || typeof parsed.type !== "string") return null;
    return parsed as { id: string; type: string; data: unknown };
  } catch {
    return null;
  }
}

/** exact annual savings of Yearly vs 12 × Monthly (computed, not guessed) */
export function yearlySavings(monthlyPrice: number, yearlyPrice: number): { amount: number; percent: number } {
  const full = Math.round(monthlyPrice * 12 * 100) / 100;
  const amount = Math.round((full - yearlyPrice) * 100) / 100;
  const percent = full > 0 ? Math.round((amount / full) * 100) : 0;
  return { amount, percent };
}
