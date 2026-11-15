/**
 * POST /api/admin?action=chat-send   (owner only)
 * Body: { text }
 * Posts a global-chat message AS THE CEO: the message is stamped server-side
 * (name "CEO" + ceo:true) so every client renders the CEO badge — clients
 * cannot forge the flag because they never write this message themselves.
 * The owner's own profile is badged ceo:true as well, so the public profile
 * shows "CEO" instead of the plain handle.
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError } from "../lib/firebase";

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const text = String(body.text || "").trim().slice(0, 300);
  if (!text) throw new HttpError(400, "EMPTY_TEXT", "Provide a message text");

  // badge the owner's profile once — the public page reads this flag
  await rtdb().ref(`users/${admin.uid}/profile`).transaction((profile: any) => ({
    ...(profile || {}),
    ...(profile || {}),
    uid: admin.uid,
    ceo: true,
  }));

  const message = {
    uid: admin.uid,
    name: "CEO",
    ceo: true,
    text,
    at: Date.now(),
  };
  await rtdb().ref("chat/global").push(message);
  res.status(200).json({ ok: true, message });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
