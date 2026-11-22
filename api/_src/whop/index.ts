/**
 * /api/whop?action=plans|checkout|verify
 *
 * Single Whop premium serverless function (Vercel Hobby = max 12 functions).
 *
 *   ?action=plans    GET  — static plan catalog
 *   ?action=checkout POST { planKey, firebaseUid } — create checkout session
 *   ?action=verify   POST (Bearer ID token) — verify + sync premium entitlement
 *   ?action=webhook  POST (Whop servers, HMAC-signed) — P45 §4 lifecycle events
 */
import checkout from "./checkout";
import verify from "./verify";
import webhook from "./webhook";
import { PUBLIC_PLANS } from "./plans";

// P45 §1/§2 — official plans only (Monthly $4.99 / Yearly $49.99); lifetime
// is no longer a public plan.
const PLANS = PUBLIC_PLANS.map((p) => ({ key: p.key, id: p.id, price: p.price, label: p.label, period: p.period, checkoutUrl: p.checkoutUrl }));

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getAction(req: any): string {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
    // fall through to body
  }
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return String(body?.action || "");
}

export default async function handler(req: any, res: any) {
  const action = getAction(req);
  switch (action) {
    case "plans":
      return res.status(200).json(PLANS);
    case "checkout":
      return checkout(req, res);
    case "verify":
      return verify(req, res);
    case "webhook":
      return webhook(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown whop action (use ?action=plans|checkout|verify|webhook)" });
  }
}
