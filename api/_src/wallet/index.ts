/**
 * POST /api/wallet?action=withdraw
 * Body: { amount: number, method: "crypto"|"telegram"|"other", details: string }
 *
 * Single wallet serverless function (Vercel Hobby = max 12 functions).
 * Atomically reserves INSP from the user's balance and stores a pending
 * withdrawal request. The owner processes it manually and marks it paid or
 * rejected (rejected = coins refunded) via /api/admin?action=withdrawals.
 * Deposits are handled manually via Telegram (owner gifts coins with
 * /api/admin?action=gift), so no deposit endpoint is needed.
 */
import withdraw from "./withdraw";

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
  return String(body?.action || "withdraw");
}

export default async function handler(req: any, res: any) {
  const action = getAction(req);
  switch (action) {
    case "withdraw":
      return withdraw(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown wallet action (use ?action=withdraw)" });
  }
}
