/**
 * P45 §4/§5/§6 — POST /api/whop?action=verify
 *
 * Server-side membership verification for the LOGGED-IN user:
 *  - the caller's uid comes from a verified Firebase ID token (the client
 *    body uid is ignored) — nobody can verify someone else's entitlement;
 *  - matches Whop memberships by checkout-session metadata (firebaseUid)
 *    OR by the verified account email — the fallback for payments made
 *    through the direct official checkout links;
 *  - when a valid membership is found the entitlement is PERSISTED to
 *    Firebase (self-heal for the "webhook has not arrived yet" case) and
 *    the full subscription detail is returned for the UI;
 *  - a whop-sourced entitlement whose membership has disappeared is revoked
 *    here (only when the Whop API answered successfully — API failures
 *    never revoke). Admin-granted and legacy-lifetime users carry no
 *    whop-source marker and are never touched by this path.
 */
import Whop from "@whop/sdk";
import { requireUser, rtdb, logLedger, HttpError } from "../lib/firebase";
import {
  PREMIUM_PRODUCT_ID, decideEntitlement, isPremiumMembership,
  extractUidCandidates, extractEmail, type MembershipLike,
} from "./webhook-core";

const COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_lYc5Z0SFSvie4m";

/** collect every valid premium membership for the company (all pages) */
async function listValidMemberships(whop: Whop): Promise<MembershipLike[]> {
  const out: MembershipLike[] = [];
  const memberships = await (whop as any).memberships.list({
    company_id: COMPANY_ID,
    product_id: PREMIUM_PRODUCT_ID,
    valid: true,
  });
  for await (const m of memberships) {
    if (m) out.push(m as MembershipLike);
  }
  return out;
}

function matchesUser(m: MembershipLike, uid: string, email: string | undefined): boolean {
  const byMeta = extractUidCandidates(m).includes(uid);
  const byEmail = !!email && !!extractEmail(m) && extractEmail(m) === String(email).trim().toLowerCase();
  return byMeta || byEmail;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ isPremium: false, error: "Method not allowed" });
  }

  const user = await requireUser(req).catch((e) => {
    if (e instanceof HttpError) return null;
    throw e;
  });
  if (!user) return res.status(401).json({ isPremium: false, error: "Auth required" });
  const uid = user.uid;
  const email = user.email;

  const db = rtdb();
  const profileSnap = await db.ref(`users/${uid}/profile`).once("value");
  const profile = (profileSnap.val() || {}) as Record<string, unknown>;

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    // not configured — trust the persisted profile only, never fabricate
    return res.status(200).json({
      isPremium: profile.isPremium === true,
      plan: typeof profile.premiumPlan === "string" ? profile.premiumPlan : null,
      status: null, currentPeriodEnd: null, manageUrl: null,
      source: profile.premiumSource === "whop" ? "whop" : "admin",
      configured: false,
    });
  }

  try {
    const whop = new Whop({ apiKey });
    const memberships = await listValidMemberships(whop);
    const mine = memberships.filter((m) => matchesUser(m, uid, email));

    if (mine.length > 0) {
      // prefer the most recently updated membership
      const best = mine.sort((a, b) => String((b as any).updated_at ?? "").localeCompare(String((a as any).updated_at ?? "")))[0];
      const decision = decideEntitlement(best);
      const sinceSnap = await db.ref(`users/${uid}/profile/premiumSince`).once("value");
      const since = typeof sinceSnap.val() === "number" ? sinceSnap.val() : Date.now();
      await db.ref(`whopMemberships/${uid}`).update({
        membershipId: best.id,
        planId: best.plan?.id ?? null,
        planKey: decision.planKey,
        status: decision.status,
        valid: decision.grant,
        cancelAtPeriodEnd: best.cancel_at_period_end === true,
        canceledAt: best.canceled_at ?? null,
        renewalPeriodStart: best.renewal_period_start ?? null,
        renewalPeriodEnd: best.renewal_period_end ?? null,
        manageUrl: best.manage_url ?? null,
        email: extractEmail(best),
        lastEvent: "verify_sync",
        updatedAt: Date.now(),
      });
      await db.ref(`users/${uid}/profile`).update({
        isPremium: true,
        premiumPlan: decision.planKey ?? "monthly",
        premiumSince: since,
        premiumSource: "whop",
        whopMembershipId: best.id,
      });
      return res.status(200).json({
        isPremium: true,
        plan: decision.planKey,
        status: decision.status,
        currentPeriodEnd: best.renewal_period_end ?? null,
        manageUrl: best.manage_url ?? null,
        source: "whop",
        configured: true,
      });
    }

    // no valid membership found — the API answered successfully, so this is
    // authoritative. Only whop-sourced RECURRING entitlements auto-revoke;
    // admin grants and legacy lifetime memberships carry no marker.
    const whopOwned = profile.premiumSource === "whop"
      && typeof profile.whopMembershipId === "string"
      && profile.whopMembershipId !== "";
    const recurring = profile.premiumPlan === "monthly" || profile.premiumPlan === "yearly";
    if (whopOwned && recurring && profile.isPremium === true) {
      await db.ref(`users/${uid}/profile`).update({ isPremium: false });
      await db.ref(`whopMemberships/${uid}`).update({ valid: false, status: "missing", lastEvent: "verify_sync_revoked", updatedAt: Date.now() });
      await logLedger({ type: "whop_auto_revoke", uid, reason: "verify_no_valid_membership", at: Date.now() });
    }

    return res.status(200).json({
      isPremium: profile.isPremium === true,
      plan: typeof profile.premiumPlan === "string" ? profile.premiumPlan : null,
      status: null,
      currentPeriodEnd: null,
      manageUrl: null,
      source: profile.premiumSource === "whop" ? "whop" : profile.isPremium === true ? "admin" : null,
      configured: true,
    });
  } catch (error) {
    // Whop API failure — NEVER revoke on it; fall back to the persisted profile
    console.error("Whop membership verification failed:", error);
    return res.status(200).json({
      isPremium: profile.isPremium === true,
      plan: typeof profile.premiumPlan === "string" ? profile.premiumPlan : null,
      status: null, currentPeriodEnd: null, manageUrl: null,
      source: profile.premiumSource === "whop" ? "whop" : profile.isPremium === true ? "admin" : null,
      configured: true, degraded: true,
    });
  }
}
