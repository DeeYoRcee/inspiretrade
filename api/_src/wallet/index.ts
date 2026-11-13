/**
 * POST /api/wallet?action=withdraw|deposit
 *
 * Single wallet serverless function (Vercel Hobby = max 12 functions).
 *
 * withdraw — atomically reserves INSP from the user's balance and stores a
 *            pending withdrawal request (processed via /api/admin?action=withdrawals).
 * deposit  — in-app deposit REQUEST (no balance change): the user submits
 *            amount + payment details, the owner approves via
 *            /api/admin?action=deposits and the coins are credited then.
 *            Replaces the old "contact the owner on Telegram" flow.
 */
import withdraw from "./withdraw";
import deposit from "./deposit";

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
    case "deposit":
      return deposit(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown wallet action (use ?action=withdraw|deposit)" });
  }
}
