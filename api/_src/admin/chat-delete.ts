/**
 * POST /api/admin?action=chat-delete   (owner only)
 * Body: { messageId }
 * Removes a message from the global chat (moderation).
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError } from "../lib/firebase";

export default handle(async (req, res) => {
  assertPost(req);
  await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const messageId = String(body.messageId || "").trim();
  if (!messageId || !/^[A-Za-z0-9_-]{1,64}$/.test(messageId)) {
    throw new HttpError(400, "INVALID_ID", "Provide a valid messageId");
  }
  await rtdb().ref(`chat/global/${messageId}`).remove();
  res.status(200).json({ ok: true });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
