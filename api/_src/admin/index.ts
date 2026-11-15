/**
 * /api/admin?action=gift|withdrawals|deposits|chat-delete   (owner only)
 *
 * Single owner/admin serverless function (Vercel Hobby = max 12 functions).
 *
 *   ?action=gift            POST { uid?|username?, coins?, cases?, note? }
 *   ?action=withdrawals     GET  — list withdrawal requests (newest first)
 *                           POST { uid, id, action: "paid"|"rejected" }
 *   ?action=deposits        GET  — list deposit requests (newest first)
 *                           POST { uid, id, action: "approve"|"reject" }
 *                           approve credits the coins atomically.
 *   ?action=chat-delete     POST { messageId }
 *   ?action=chat-send       POST { text } — posts AS the CEO (stamped server-side)
 *   ?action=set-username    POST { username } — owner claims ANY handle (CEO badge)
 */
import gift from "./gift";
import withdrawals from "./withdrawals";
import deposits from "./deposits";
import chatDelete from "./chat-delete";
import chatSend from "./chat-send";
import setUsername from "./set-username";

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
    case "deposits":
      // GET lists requests, POST approves (credits coins) / rejects one.
      return deposits(req, res);
    case "chat-delete":
      return chatDelete(req, res);
    case "chat-send":
      return chatSend(req, res);
    case "set-username":
      return setUsername(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown admin action (use ?action=gift|withdrawals|deposits|chat-delete|chat-send|set-username)" });
  }
}
