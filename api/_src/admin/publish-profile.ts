/**
 * POST /api/admin?action=publish-profile   (admin only)
 *   Body { key, snapshot, settings } — publishes the caller's public-profile
 *   snapshot via the admin SDK. WHY: the client-side publish writes through
 *   the RTDB per-user rules, whose `.validate` tree rejected snapshots that
 *   carry the `vip` badge (no rule existed; root `$other: false`) and the
 *   `ceo` badge on a FIRST publish (`newData.val() === data.val()` is false
 *   when no record exists yet). Exactly the owner/CEO account was locked out
 *   of "enable public profile" while regular users kept publishing. The
 *   admin SDK write bypasses those rules — this endpoint is the escape hatch
 *   that works TODAY; the rules file is also fixed for the direct path.
 *
 *   Safety: the snapshot must be the ADMIN'S OWN (uid match) and the handle
 *   must be provably theirs (profile.username or profile.usernames).
 */
import { handle, assertPost, requireAdmin, rtdb } from "../lib/firebase";
import { logLedger } from "../lib/firebase";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function safeParse(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const key = String(body?.key || "").toLowerCase();
  const snapshot = body?.snapshot || {};
  const settings = body?.settings || {};

  if (!USERNAME_RE.test(key)) return res.status(400).json({ ok: false, error: "BAD_KEY" });
  if (snapshot.uid !== admin.uid) return res.status(403).json({ ok: false, error: "NOT_YOUR_SNAPSHOT" });
  if (snapshot.usernameKey !== key || String(snapshot.username).toLowerCase() !== key) {
    return res.status(400).json({ ok: false, error: "KEY_MISMATCH" });
  }

  // handle ownership: the admin's primary username or one of the held ones
  const profile = (await rtdb().ref(`users/${admin.uid}/profile`).once("value")).val() || {};
  const primary = String(profile.username || "").toLowerCase();
  const held = profile.usernames && typeof profile.usernames === "object" ? Object.keys(profile.usernames) : [];
  if (primary !== key && !held.includes(key)) {
    return res.status(403).json({ ok: false, error: "HANDLE_NOT_OWNED" });
  }

  const now = Date.now();
  const updates: Record<string, unknown> = {
    [`privatePublicProfileSettings/${admin.uid}`]: {
      ...(typeof settings === "object" ? settings : {}),
      publishedUsername: snapshot.enabled === false ? null : key,
      updatedAt: now,
    },
  };
  if (snapshot.enabled === false) {
    updates[`publicProfiles/${key}`] = null; // disable — clear the live snapshot
  } else {
    updates[`publicProfiles/${key}`] = { ...snapshot, updatedAt: now };
  }
  await rtdb().ref().update(updates);
  await logLedger({ type: "admin_publish_profile", target: admin.uid, username: key, by: admin.email || admin.uid });
  res.status(200).json({ ok: true, key, enabled: snapshot.enabled !== false });
});
