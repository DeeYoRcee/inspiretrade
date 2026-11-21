/**
 * POST /api/admin?action=media-upload   (admin only)
 *   Body { data } — a "data:<mime>;base64,…" data URL (≤ 6 MB decoded).
 *   Owner-grade profile background upload: the user picks a real video/image
 *   FILE in the background picker instead of pasting a link. The file is
 *   stored content-addressed in RTDB (publicMedia/{sha256}) via the admin
 *   SDK (rules do not apply to admin writes), and the profile background id
 *   becomes `media:{hash}`.
 *
 * GET /api/admin?action=media-get&id={hash}   (PUBLIC — no auth)
 *   Streams the stored bytes back so animated profile backgrounds render for
 *   signed-out visitors on /@username pages. This one action intentionally
 *   bypasses the dispatcher's auth (media is non-sensitive, hash-addressed
 *   and write-access is admin-only).
 */
import { createHash } from "crypto";
import { handle, assertPost, requireAdmin, requireUser, rtdb, HttpError } from "../lib/firebase";

const MAX_BYTES = 6 * 1024 * 1024;
const MIME_ALLOWED = new Set(["video/mp4", "image/png", "image/jpeg", "image/webp", "image/gif"]);
const DATAURL_RE = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

function safeParse(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Phase 33: profile media upload — the OWNER (admin) or a VIP member.
 * VIP check mirrors rewards/claim.ts: profile.isPremium / premiumPlan / ceo
 * or the admins/{uid} flag.
 */
export async function mediaUpload(req: any, res: any): Promise<void> {
  assertPost(req);
  let uploader: string = "admin";
  try {
    const admin = await requireAdmin(req);
    uploader = String(admin?.uid || "admin");
  } catch {
    const user = await requireUser(req);
    const [profile, adminFlag] = await Promise.all([
      rtdb().ref(`users/${user.uid}/profile`).get(),
      rtdb().ref(`admins/${user.uid}`).get(),
    ]);
    const p = profile.val() || {};
    const isVip = p.isPremium === true || !!p.premiumPlan || p.ceo === true || adminFlag.val() === true;
    if (!isVip) throw new HttpError(403, "VIP_ONLY", "Profile media upload is a VIP feature");
    uploader = user.uid;
  }
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const data = String(body?.data || "");
  const m = DATAURL_RE.exec(data);
  if (!m) return res.status(400).json({ ok: false, error: "BAD_DATA_URL" });
  const mime = m[1].toLowerCase();
  if (!MIME_ALLOWED.has(mime)) return res.status(400).json({ ok: false, error: "UNSUPPORTED_TYPE", mime });
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length) return res.status(400).json({ ok: false, error: "EMPTY" });
  if (buf.length > MAX_BYTES) return res.status(413).json({ ok: false, error: "TOO_LARGE", max: MAX_BYTES });
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 32);
  await rtdb().ref(`publicMedia/${hash}`).set(`data:${mime};base64,${buf.toString("base64")}`);
  await rtdb().ref(`publicMediaIndex/${hash}`).set({
    mime,
    bytes: buf.length,
    by: uploader,
    at: Date.now(),
  });
  res.status(200).json({ ok: true, id: hash, mime, bytes: buf.length });
}

/** Public read — stream the bytes (backgrounds render for signed-out users). */
export async function mediaGet(req: any, res: any): Promise<void> {
  const id = String(new URL(req.url || "/", "http://localhost").searchParams.get("id") || "");
  if (!/^[a-f0-9]{8,64}$/.test(id)) return res.status(400).json({ ok: false, error: "BAD_ID" });
  const dataUrl = (await rtdb().ref(`publicMedia/${id}`).once("value")).val();
  if (typeof dataUrl !== "string") return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  const m = DATAURL_RE.exec(dataUrl);
  if (!m) return res.status(500).json({ ok: false, error: "CORRUPT" });
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Content-Length", String(buf.length));
  // content-addressed — safe to cache hard
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).send(buf);
}
