/**
 * /api/whop?action=plans|checkout|verify
 *
 * Single Whop premium serverless function (Vercel Hobby = max 12 functions).
 *
 *   ?action=plans    GET  — static plan catalog
 *   ?action=checkout POST { planKey, firebaseUid } — create checkout session
 *   ?action=verify   POST { firebaseUid } — check premium membership
 */
import checkout from "./checkout";
import verify from "./verify";

const PLANS = {
  monthly: { id: "plan_uAJSe5gvChYEy", price: 3.99, label: "Monthly", period: "/ mo" },
  yearly: { id: "plan_s3vO6JEWy2ruA", price: 24.99, label: "Yearly", period: "/ yr" },
  lifetime: { id: "plan_OloGrVT1gLT5y", price: 109.99, label: "Lifetime", period: "" },
};

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
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown whop action (use ?action=plans|checkout|verify)" });
  }
}
