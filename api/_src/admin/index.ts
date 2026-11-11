/**
 * /api/admin?action=gift|withdrawals|chat-delete   (owner only)
 *
 * Single owner/admin serverless function (Vercel Hobby = max 12 functions).
 *
 *   ?action=gift            POST { uid?|username?, coins?, cases?, note? }
 *   ?action=withdrawals     GET  — list withdrawal requests (newest first)
 *                           POST { uid, id, action: "paid"|"rejected" }
 *   ?action=chat-delete     POST { messageId }
 */
import gift from "./gift";
import withdrawals from "./withdrawals";
import chatDelete from "./chat-delete";

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
    case "gift":
      return gift(req, res);
    case "withdrawals":
      // GET lists requests, POST marks one paid/rejected (handled inside).
      return withdrawals(req, res);
    case "chat-delete":
      return chatDelete(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown admin action (use ?action=gift|withdrawals|chat-delete)" });
  }
}
