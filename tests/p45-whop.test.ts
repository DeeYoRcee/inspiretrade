/**
 * P45 — Whop payment integration tests:
 *  1. the OFFICIAL webhook verification path (whop.webhooks.unwrap /
 *     standardwebhooks HMAC) — accepts valid deliveries, rejects tampered,
 *     stale (>5 min tolerance) and forged ones;
 *  2. the pure entitlement/plan/mapping decision logic;
 *  3. the manual Standard Webhooks fallback verifier in webhook-core.
 * Run: node --test tests/p45-whop.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Whop from "@whop/sdk";
import { Webhook } from "standardwebhooks";
import {
  PLAN_BY_ID, WHOP_CHECKOUT_URLS, PUBLIC_PLANS, PREMIUM_PRODUCT_ID,
  planKeyForPlanId, decideEntitlement, isPremiumMembership,
  extractUidCandidates, extractEmail, verifyWebhookSignature, yearlySavings,
  type MembershipLike,
} from "../api/_src/whop/webhook-core.ts";

// whsec_<base64> is the Standard Webhooks canonical secret format the installed
// standardwebhooks lib accepts directly; ws_ secrets are covered by the manual
// fallback in webhook-core (secretCandidates tries stripped/raw derivations).
const SECRET = "whsec_" + Buffer.from("p45-test-webhook-secret-key-0001").toString("base64");

function makeEvent(): string {
  return JSON.stringify({
    id: "msg_45TEST0000000000000000000",
    type: "payment.succeeded",
    api_version: "v1",
    timestamp: new Date().toISOString(),
    account_id: "biz_test",
    data: { id: "pay_1", membership: { id: "mem_1", status: "active" } },
  });
}

test("official unwrap accepts a correctly-signed Whop delivery", () => {
  const body = makeEvent();
  const wh = new Webhook(SECRET);
  const sig = wh.sign("msg_45TEST0000000000000000000", new Date(), body);
  const client = new Whop({ apiKey: "test-key", webhookKey: SECRET });
  const event = client.webhooks.unwrap(body, {
    headers: { "webhook-id": "msg_45TEST0000000000000000000", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": sig },
    key: SECRET,
  }) as { type: string };
  assert.equal(event.type, "payment.succeeded");
});

test("official unwrap REJECTS a tampered body", () => {
  const body = makeEvent();
  const wh = new Webhook(SECRET);
  const sig = wh.sign("msg_x", new Date(), body);
  const client = new Whop({ apiKey: "test-key", webhookKey: SECRET });
  const tampered = body.replace("payment.succeeded", "payment.failed");
  assert.throws(() => client.webhooks.unwrap(tampered, {
    headers: { "webhook-id": "msg_x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": sig },
    key: SECRET,
  }));
});

test("official unwrap REJECTS a stale timestamp (> 5 min tolerance)", () => {
  const body = makeEvent();
  const wh = new Webhook(SECRET);
  const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
  const sig = wh.sign("msg_x", new Date(Date.now() - 6 * 60 * 1000), body);
  const client = new Whop({ apiKey: "test-key", webhookKey: SECRET });
  assert.throws(() => client.webhooks.unwrap(body, {
    headers: { "webhook-id": "msg_x", "webhook-timestamp": stale, "webhook-signature": sig },
    key: SECRET,
  }));
});

test("official unwrap REJECTS a forged secret", () => {
  const body = makeEvent();
  const wh = new Webhook("whsec_" + Buffer.from("attacker-controlled-secret").toString("base64"));
  const sig = wh.sign("msg_x", new Date(), body);
  const client = new Whop({ apiKey: "test-key", webhookKey: SECRET });
  assert.throws(() => client.webhooks.unwrap(body, {
    headers: { "webhook-id": "msg_x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": sig },
    key: SECRET,
  }));
});

test("plan catalog: exactly two public plans with the official ids/URLs", () => {
  assert.equal(PUBLIC_PLANS.length, 2);
  assert.deepEqual(PUBLIC_PLANS.map((p) => p.key), ["monthly", "yearly"]);
  assert.equal(PUBLIC_PLANS.find((p) => p.key === "monthly")?.id, "plan_52Mtr4TTs0xit");
  assert.equal(PUBLIC_PLANS.find((p) => p.key === "yearly")?.id, "plan_NRZsRwd0VgKR4");
  assert.equal(WHOP_CHECKOUT_URLS.monthly, "https://whop.com/checkout/plan_52Mtr4TTs0xit");
  assert.equal(WHOP_CHECKOUT_URLS.yearly, "https://whop.com/checkout/plan_NRZsRwd0VgKR4");
  assert.equal(PUBLIC_PLANS.find((p) => p.key === "monthly")?.price, 4.99);
  assert.equal(PUBLIC_PLANS.find((p) => p.key === "yearly")?.price, 49.99);
});

test("plan mapping: official ids map, legacy lifetime maps, unknown → null", () => {
  assert.equal(planKeyForPlanId("plan_52Mtr4TTs0xit"), "monthly");
  assert.equal(planKeyForPlanId("plan_NRZsRwd0VgKR4"), "yearly");
  assert.equal(planKeyForPlanId("plan_OloGrVT1gLT5y"), "lifetime"); // legacy kept
  assert.equal(planKeyForPlanId("plan_UNKNOWN"), null);
  assert.equal(planKeyForPlanId(undefined), null);
  assert.ok(PLAN_BY_ID["plan_OloGrVT1gLT5y"] === "lifetime");
});

function membership(status: string, extra: Partial<MembershipLike> = {}): MembershipLike {
  return {
    id: "mem_1", status,
    plan: { id: "plan_52Mtr4TTs0xit" },
    product: { id: PREMIUM_PRODUCT_ID },
    user: { email: " Trader@Example.COM " },
    metadata: { firebaseUid: "uid-123" },
    cancel_at_period_end: false, canceled_at: null,
    renewal_period_start: null, renewal_period_end: null, manage_url: null,
    ...extra,
  };
}

test("entitlement decision per the official status enum", () => {
  // grant statuses
  for (const s of ["active", "trialing", "completed", "canceling", "past_due"]) {
    const d = decideEntitlement(membership(s));
    assert.equal(d.grant, true, s);
    assert.equal(d.planKey, "monthly");
  }
  // revoke statuses
  for (const s of ["expired", "canceled", "unresolved", "drafted"]) {
    assert.equal(decideEntitlement(membership(s)).grant, false, s);
  }
});

test("isPremiumMembership only accepts the premium product", () => {
  assert.equal(isPremiumMembership(membership("active")), true);
  assert.equal(isPremiumMembership(membership("active", { product: { id: "prod_other" } })), false);
});

test("uid/email mapping extraction normalizes safely", () => {
  assert.deepEqual(extractUidCandidates(membership("active")), ["uid-123"]);
  assert.deepEqual(extractUidCandidates(membership("active", { metadata: { firebaseUid: 42 } })), []);
  assert.equal(extractEmail(membership("active")), "trader@example.com");
  assert.equal(extractEmail(membership("active", { user: null })), null);
  assert.equal(extractEmail(membership("active", { user: { email: "not-an-email" } })), null);
});

test("manual Standard Webhooks fallback: verifies correct, rejects tampered/stale/missing", () => {
  const body = makeEvent();
  const id = "msg_x";
  const ts = String(Math.floor(Date.now() / 1000));
  const wh = new Webhook(SECRET);
  const sig = wh.sign(id, new Date(), body);
  const headers = { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig };

  const ok = verifyWebhookSignature(body, headers, SECRET);
  assert.ok(ok, "valid signature must verify");
  assert.equal(ok?.type, "payment.succeeded");

  assert.equal(verifyWebhookSignature(body.replace("payment.succeeded", "payment.failed"), headers, SECRET), null);
  const staleHeaders = { ...headers, "webhook-timestamp": String(Math.floor(Date.now() / 1000) - 6 * 60) };
  assert.equal(verifyWebhookSignature(body, staleHeaders, SECRET), null);
  assert.equal(verifyWebhookSignature(body, { ...headers, "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, SECRET), null);
  assert.equal(verifyWebhookSignature(body, undefined, SECRET), null);
  assert.equal(verifyWebhookSignature("", headers, SECRET), null);
});

test("yearly savings are computed exactly (12×4.99 = 59.88 → save 9.89 / 17%)", () => {
  const s = yearlySavings(4.99, 49.99);
  assert.equal(s.amount, 9.89);
  assert.equal(s.percent, 17);
});
