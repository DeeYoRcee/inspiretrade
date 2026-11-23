/**
 * POST /api/admin?action=support   (owner only)
 * Body: { op: "threads" } → all support threads (per user) with last message.
 * Body: { op: "reply", uid, text } → push a support reply INTO the user's
 * private thread (`supportInbox/{uid}`) stamped from:"support".
 *
 * Users write their own thread directly through RTDB rules
 * (supportInbox/$uid: read/write only auth.uid === $uid) — one user's support
 * conversation is never visible to another. The OWNER cannot read other
 * users' threads through client rules; the admin SDK here bypasses them.
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError } from "../lib/firebase";

interface SupportMsg {
  uid?: string;
  name?: string;
  text?: string;
  at?: number;
  from?: "user" | "support";
}

export default handle(async (req, res) => {
  assertPost(req);
  await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const op = String(body.op || "threads");

  if (op === "threads") {
    const snap = await rtdb().ref("supportInbox").get();
    const val = (snap.val() || {}) as Record<string, Record<string, SupportMsg>>;
    const threads: Array<{
      uid: string; name: string | null; lastText: string; lastAt: number;
      fromLast: string | null; total: number; awaitingReply: boolean;
    }> = [];
    for (const [uid, msgs] of Object.entries(val)) {
      const list = Object.values(msgs || {}).filter((m) => m && typeof m.text === "string");
      if (!list.length) continue;
      list.sort((a, b) => (a.at || 0) - (b.at || 0));
      const last = list[list.length - 1];
      // awaiting reply = the newest message came FROM the user
      threads.push({
        uid,
        name: last.from === "user" ? (last.name || null) : null,
        lastText: String(last.text || "").slice(0, 160),
        lastAt: last.at || 0,
        fromLast: last.from || null,
        total: list.length,
        awaitingReply: last.from === "user",
      });
    }
    threads.sort((a, b) => b.lastAt - a.lastAt);
    return res.status(200).json({ ok: true, threads });
  }

  if (op === "thread") {
    const uid = String(body.uid || "").trim();
    if (!uid) throw new HttpError(400, "BAD_INPUT", "uid is required");
    const snap = await rtdb().ref(`supportInbox/${uid}`).get();
    const val = (snap.val() || {}) as Record<string, SupportMsg>;
    const msgs = Object.entries(val)
      .map(([id, m]) => ({ id, ...m }))
      .filter((m) => m.text)
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(-200);
    return res.status(200).json({ ok: true, uid, messages: msgs });
  }

  if (op === "reply") {
    const uid = String(body.uid || "").trim();
    const text = String(body.text || "").trim().slice(0, 1000);
    if (!uid || !text) throw new HttpError(400, "BAD_INPUT", "uid and text are required");
    // verify the thread exists — never create stray mailboxes
    const exists = await rtdb().ref(`supportInbox/${uid}`).limitToFirst(1).get();
    if (!exists.exists()) throw new HttpError(404, "NO_THREAD", "No support thread for this uid");
    await rtdb().ref(`supportInbox/${uid}`).push({
      uid,
      name: "InspireTrade Support",
      text,
      at: Date.now(),
      from: "support",
    });
    return res.status(200).json({ ok: true });
  }

  throw new HttpError(400, "BAD_OP", "op must be threads|thread|reply");
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
