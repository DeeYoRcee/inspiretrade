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
  const snap = await rtdb().ref(`users/${admin.uid}/profile`).transaction((profile: any) => ({
    ...(profile || {}),
    uid: admin.uid,
    ceo: true,
  }));
  // stamp the claimed handle so chat rows can link to the public profile —
  // without it every CEO-message click handler was a silent no-op
  const username = typeof (snap.value as any)?.username === "string" ? (snap.value as any).username : undefined;

  // P39 — optional Telegram-style reply quote (sanitized; absent = plain)
  const rtRaw = (body as any)?.replyTo;
  const replyTo = rtRaw && typeof rtRaw === "object"
    ? {
        id: String(rtRaw.id ?? "").slice(0, 40),
        author: String(rtRaw.author ?? "CEO").slice(0, 60) || "CEO",
        text: String(rtRaw.text ?? "").slice(0, 120),
      }
    : null;

  const message = {
    uid: admin.uid,
    name: "CEO",
    ...(username ? { username } : {}),
    ceo: true,
    text,
    at: Date.now(),
    ...(replyTo && replyTo.id ? { replyTo } : {}),
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
