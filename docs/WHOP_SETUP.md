# Whop Premium Setup (P45) — owner instructions

This document lists exactly what the owner must configure. **No secrets are committed to the repo** — everything sensitive lives in Vercel Environment Variables.

## 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Required | Purpose |
|---|---|---|
| `WHOP_API_KEY` | ✅ (already in use) | Whop server API key — `memberships.list/retrieve` + checkout creation. Needs `member:email:read` permission so the email-based payer→user mapping works. |
| `WHOP_WEBHOOK_SECRET` | ✅ **NEW — required** | The signing secret of the webhook endpoint you create in Whop (step 2). Format `ws_…` or `whsec_…` — both work (the manual verifier handles either derivation). Never commit it. |
| `WHOP_COMPANY_ID` | ✅ (already in use) | Whop company id, default `biz_lYc5Z0SFSvie4m`. |
| `APP_URL` | ✅ (already in use) | Production origin (`https://…`) — used as the checkout redirect target (`/?premium=success`). |
| `FIREBASE_SERVICE_ACCOUNT` (or `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) | ✅ (already in use) | firebase-admin credentials — entitlement writes bypass RTDB rules by design. |
| `FIREBASE_DATABASE_URL` | optional | Overrides the derived RTDB URL. |

## 2. Create the webhook in the Whop dashboard

1. Whop Dashboard → Developer → Webhooks → **Create endpoint**.
2. URL: `https://<your-domain>/api/whop?action=webhook`
3. Subscribe to events (the handler uses these; extra events are answered 200 and ignored):
   - `membership.activated`
   - `membership.deactivated`
   - `membership.updated`
   - `payment.succeeded`
   - `payment.failed`
   - `refund.created`
4. Copy the endpoint's signing secret → set it as `WHOP_WEBHOOK_SECRET` in Vercel → redeploy.

Verification is done with the official `@whop/sdk` `webhooks.unwrap` (Standard Webhooks HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, 5-minute timestamp tolerance, constant-time compare). Unverifiable deliveries are answered **401 and never processed**.

## 3. Plans

Only these two are publicly sold (official links, fixed by spec — `api/_src/whop/plans.ts` + `client/src/lib/whop.ts`):

- Monthly $4.99/mo — https://whop.com/checkout/plan_52Mtr4TTs0xit
- Yearly $49.99/yr — https://whop.com/checkout/plan_NRZsRwd0VgKR4

Both plan ids must belong to the Premium product `prod_cUlL0SOCTM3S7`. **Lifetime ($109.99, `plan_OloGrVT1gLT5y`) is no longer sold or displayed anywhere**, but its id is still mapped server-side so existing lifetime memberships keep working — do not delete that plan inside Whop, just don't link it.

## 4. How activation works

- Webhook (primary): signed event → live `memberships.retrieve` → status decides grant/revoke (`active/trialing/completed/canceling/past_due` grant; `expired/canceled/unresolved/drafted` revoke) → Firebase admin write: `users/{uid}/profile` (`isPremium`, `premiumPlan`, `premiumSince` kept, `premiumSource: "whop"`, `whopMembershipId`) + `whopMemberships/{uid}` (status, plan, renewal dates, `manageUrl`).
- Verify endpoint (self-heal): the logged-in client polls `POST /api/whop?action=verify`; the server matches memberships by checkout metadata **or** the verified account email and persists the entitlement — this covers the "paid but webhook not here yet" state, which the UI shows as *Verifying payment…* (never as "active").
- Auto-revoke on verify happens **only** for whop-sourced recurring plans (`premiumSource: "whop"` + monthly/yearly). Admin-granted and legacy-lifetime users carry no marker and can never be auto-revoked.
- Payer→user mapping: checkout-session metadata `firebaseUid` first, payer email (via `member:email:read`) second; unmapped members are parked in `whopUnlinked/{membershipId}` for manual linking — never granted blindly.
- Idempotency: every processed delivery id is stored in `whopEvents/{webhook-id}`; retries answer 200/no-op. Failed processing is NOT recorded, so Whop retries it (~12 attempts over 3 days).

## 5. RTDB rules deployed with this phase

- `users/$uid/profile`: `premiumSource` + `whopMembershipId` are now owner-immutable (same pattern as `isPremium` — a client can never self-grant).
- `whopMemberships/{uid}`: owner-read only, no client write (admin SDK only).
- `whopEvents`, `whopUnlinked`: fully server-only.

## 6. Testing checklist (what needs a live pass after deploy)

1. Buy Monthly on a test account via the official link → webhook → premium appears ≤ 1 min (or immediately after the verify poll).
2. Buy Yearly likewise; check the renewal date + "Manage on Whop" link (Whop's official per-membership `manage_url`).
3. Cancel from Whop → `membership.deactivated` (after period end) → premium flips off; journal/trades untouched.
4. Re-buy → premium returns; `premiumSince` keeps the FIRST purchase date.
5. Duplicate webhook delivery (Whop dashboard "send test") → answered as duplicate, no double effects.
6. Existing lifetime account → still premium; verify poll does not revoke it.
7. Tampered curl POST to the webhook URL → 401, nothing written.
