/**
 * P45 §4 — Whop webhook handler: POST /api/whop?action=webhook
 *
 * Security model (from the official Whop docs + SDK):
 *  - Whop sends Standard Webhooks: HMAC-SHA256 over "{webhook-id}.
 *    {webhook-timestamp}.{raw body}", base64, header `webhook-signature:
 *    v1,<sig>`; secret is the `ws_...` WHOP_WEBHOOK_SECRET env var.
 *  - PRIMARY verification is the official SDK helper `whop.webhooks.unwrap`
 *    (it wraps the standardwebhooks package). A manual fallback in
 *    webhook-core covers runtimes where the JSON stream was pre-parsed by
 *    the platform — an unverifiable delivery is ALWAYS rejected (401),
 *    never processed.
 *  - The client is NEVER trusted: entitlements are granted/revoked only
 *    from verified server-side events + live Whop API status.
 *  - Idempotency: Whop retries use the same `webhook-id` — processed ids
 *    are recorded in `whopEvents/{id}` and duplicates answer 200/no-op.
 *  - Must answer 2xx within ~5s; heavy work is a single memberships
 *    retrieve + a few RTDB writes.
 */
import Whop from "@whop/sdk";
import { rtdb, logLedger } from "../lib/firebase";
import { grantVipWelcomeBundle } from "./welcome";
import {
  PREMIUM_PRODUCT_ID, decideEntitlement, isPremiumMembership,
  extractUidCandidates, extractEmail, verifyWebhookSignature,
  type MembershipLike,
} from "./webhook-core";

const COMPANY_ID = process.env.WHOP_COMPANY_ID || "biz_lYc5Z0SFSvie4m";

/** read the raw request body when the stream is still available */
async function readRawBody(req: any): Promise<string | null> {
  try {
    if (typeof req.body === "string" && req.body) return req.body;
    if (req.body === undefined || req.body === null) {
      if (req.readableEnded) return null;
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    }
    return null; // parsed object — caller uses JSON.stringify fallback
  } catch {
    return null;
  }
}

/** collect the raw-body candidates the signature may verify against */
function bodyCandidates(req: any, raw: string | null): string[] {
  const out: string[] = [];
  if (raw) out.push(raw);
  if (req.body && typeof req.body === "object") {
    const s = JSON.stringify(req.body);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** official verifier first (standardwebhooks), documented fallback second */
function verifyEvent(body: string, headers: Record<string, string>): { id: string; type: string; data: any } | null {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) return null; // unconfigured → nothing is ever trusted
  try {
    const whop = new Whop({ apiKey: process.env.WHOP_API_KEY || "unset", webhookKey: secret });
    const event = whop.webhooks.unwrap(body, {
      headers: {
        "webhook-id": headers["webhook-id"],
        "webhook-timestamp": headers["webhook-timestamp"],
        "webhook-signature": headers["webhook-signature"],
      },
      key: secret,
    }) as { id: string; type: string; data: any };
    if (event && typeof event.type === "string") return event;
    return null;
  } catch (primaryError) {
    // fallback: manual Standard Webhooks verification (safe direction: only
    // a correct HMAC accepts; any derivation mismatch means reject)
    const parsed = verifyWebhookSignature(body, headers, secret);
    if (!parsed && process.env.DEBUG) {
      console.warn("[whop-webhook] signature verification failed:", primaryError instanceof Error ? primaryError.message : primaryError);
    }
    return parsed;
  }
}

function webhookHeaders(req: any): Record<string, string> {
  const h = req.headers || {};
  return {
    "webhook-id": String(h["webhook-id"] ?? ""),
    "webhook-timestamp": String(h["webhook-timestamp"] ?? ""),
    "webhook-signature": String(h["webhook-signature"] ?? ""),
  };
}

/** map a membership to the InspireTrade user: metadata uid (checkout
 *  session) first, then the payer email via Firebase Auth */
async function resolveUid(whop: Whop, m: MembershipLike): Promise<string | null> {
  const db = rtdb();
  for (const uid of extractUidCandidates(m)) {
    try {
      const snap = await db.ref(`users/${uid}/profile/uid`).get();
      if (snap.exists()) return uid;
    } catch { /* fall through */ }
  }
  const email = extractEmail(m);
  if (email) {
    try {
      const { adminAuth } = await import("../lib/firebase");
      const user = await adminAuth().getUserByEmail(email);
      if (user?.uid) return user.uid;
    } catch { /* no user with that email */ }
  }
  return null;
}

async function fetchMembership(whop: Whop, id: string): Promise<MembershipLike | null> {
  try {
    const m = await (whop as any).memberships.retrieve(id);
    return m ?? null;
  } catch (e) {
    console.error("[whop-webhook] memberships.retrieve failed:", e);
    return null;
  }
}

/** write the entitlement decision for one membership (idempotent by nature) */
async function applyMembership(m: MembershipLike, uid: string | null, lastEvent: string): Promise<void> {
  const db = rtdb();
  const decision = decideEntitlement(m);
  if (!uid) {
    // unmapped: park it so the owner can inspect/link later — never grant blindly
    if (decision.grant && isPremiumMembership(m)) {
      await db.ref(`whopUnlinked/${m.id}`).set({
        membershipId: m.id, planId: m.plan?.id ?? null, status: decision.status,
        email: extractEmail(m), metadata: m.metadata ?? null, lastEvent, updatedAt: Date.now(),
      });
    }
    return;
  }
  const rec = {
    membershipId: m.id,
    planId: m.plan?.id ?? null,
    planKey: decision.planKey,
    status: decision.status,
    valid: decision.grant,
    cancelAtPeriodEnd: m.cancel_at_period_end === true,
    canceledAt: m.canceled_at ?? null,
    renewalPeriodStart: m.renewal_period_start ?? null,
    renewalPeriodEnd: m.renewal_period_end ?? null,
    manageUrl: m.manage_url ?? null,
    email: extractEmail(m),
    lastEvent,
    updatedAt: Date.now(),
  };
  await db.ref(`whopMemberships/${uid}`).update(rec);
  // profile: premiumSince is preserved (first-grant date), never regressed
  if (decision.grant) {
    const sinceSnap = await db.ref(`users/${uid}/profile/premiumSince`).get();
    const since = typeof sinceSnap.val() === "number" ? sinceSnap.val() : Date.now();
    await db.ref(`users/${uid}/profile`).update({
      isPremium: true,
      premiumPlan: decision.planKey ?? "monthly",
      premiumSince: since,
      premiumSource: "whop",
      whopMembershipId: m.id,
    });
    await logLedger({ type: "whop_entitlement", action: "grant", uid, membershipId: m.id, status: decision.status, planKey: decision.planKey, event: lastEvent, at: Date.now() });
    // P64R — one-time welcome bundle (Inspire + Gold + Trading case) on the first grant
    await grantVipWelcomeBundle(uid, m.id).catch(() => { /* bundle must never break the entitlement write */ });
  } else {
    // revoke — journal/trades/personal data live on separate nodes and are
    // NOT touched; only the premium flags flip off
    await db.ref(`users/${uid}/profile`).update({
      isPremium: false,
      premiumSource: "whop",
      whopMembershipId: m.id,
    });
    await logLedger({ type: "whop_entitlement", action: "revoke", uid, membershipId: m.id, status: decision.status, event: lastEvent, at: Date.now() });
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    // configuration missing — never process unverified deliveries
    return res.status(503).json({ error: "WHOP_WEBHOOK_SECRET not configured" });
  }

  const raw = await readRawBody(req);
  const candidates = bodyCandidates(req, raw);
  const headers = webhookHeaders(req);
  if (!headers["webhook-id"] || !headers["webhook-signature"]) {
    return res.status(401).json({ error: "Missing webhook signature headers" });
  }

  let event: { id: string; type: string; data: any } | null = null;
  let verifiedBody: string | null = null;
  for (const body of candidates) {
    event = verifyEvent(body, headers);
    if (event) { verifiedBody = body; break; }
  }
  if (!event) {
    console.error("[whop-webhook] UNVERIFIED delivery rejected (headers:", headers["webhook-id"], ")");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // idempotency — Whop retries reuse the same webhook-id
  const db = rtdb();
  const eventId = headers["webhook-id"] || event.id || `evt_${(event as any).timestamp || Date.now()}`;
  const evRef = db.ref(`whopEvents/${eventId}`);
  try {
    const dup = await evRef.once("value");
    if (dup.exists()) return res.status(200).json({ ok: true, duplicate: true });
  } catch { /* read failure → process anyway (writes are idempotent) */ }

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "WHOP_API_KEY not configured" });
  const whop = new Whop({ apiKey });

  try {
    const type = event.type;
    const data = event.data || {};

    // membership events carry the full Membership object
    if (type === "membership.activated" || type === "membership.deactivated" || type === "membership.updated" || type === "membership.cancel_at_period_end_changed") {
      const mid = data?.id;
      if (typeof mid === "string" && mid) {
        // re-read the LIVE membership (ordering is not guaranteed by webhooks)
        const m = await fetchMembership(whop, mid);
        if (m && isPremiumMembership(m)) {
          const uid = await resolveUid(whop, m);
          await applyMembership(m, uid, type);
        }
      }
    } else if (type === "payment.succeeded" || type === "payment.failed" || type === "payment.pending" || type === "payment.canceled") {
      const mid = data?.membership?.id;
      const productId = data?.product?.id;
      if (typeof mid === "string" && mid && (productId == null || productId === PREMIUM_PRODUCT_ID)) {
        const m = await fetchMembership(whop, mid);
        if (m && isPremiumMembership(m)) {
          const uid = await resolveUid(whop, m);
          await applyMembership(m, uid, type);
          if (uid) {
            await db.ref(`whopMemberships/${uid}/lastPayment`).set({
              eventId: eventId, paymentType: type, amount: data.amount ?? null,
              currency: data.currency ?? null, at: Date.now(),
            }).catch(() => { /* non-critical */ });
          }
        }
      }
    } else if (type === "refund.created" || type === "refund.updated") {
      const mid = data?.membership?.id;
      if (typeof mid === "string" && mid) {
        const m = await fetchMembership(whop, mid);
        if (m && isPremiumMembership(m)) {
          const uid = await resolveUid(whop, m);
          await applyMembership(m, uid, type);
        }
      }
    }
    // other event types: acknowledged, ignored

    await evRef.set({ type, processedAt: Date.now() });
    return res.status(200).json({ ok: true });
  } catch (error) {
    // do NOT record the event id — Whop will retry this delivery
    console.error("[whop-webhook] processing failed (will be retried):", error);
    return res.status(500).json({ error: "Processing failed" });
  }
}
