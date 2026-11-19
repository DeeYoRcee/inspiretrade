/**
 * POST /api/admin?action=repair-profile-stub   (any authenticated user)
 * Body: { key?: string }  — optional handle; default repairs every handle the
 * caller provably owns.
 *
 * Self-service public-profile repair (Phase 19). Admin username moves leave
 * uid-less { redirect } stubs at old handles; the RTDB rules deny the OWNER
 * any write where such a record exists (the data.uid check fails on a stub),
 * so publishing/enabling the public profile dies with PERMISSION_DENIED and
 * the client used to demand an admin repair. The admin purge endpoint needs
 * an admin ROLE — which the CEO flag does NOT grant — leaving the CEO (and
 * any user) stuck.
 *
 * This endpoint lets the user fix it themselves, with server-side ownership
 * proof — no client trust:
 *   - a handle is provably owned when usernames/{key} === caller.uid OR the
 *     permanent held-username map users/{uid}/profile.usernames/{key} exists;
 *   - ONLY a uid-less stub (or a broken self-snapshot) at such a handle is
 *     removed — another user's live snapshot is never touched;
 *   - every purge is audited.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";

const KEY_RE = /^[a-z0-9_]{3,20}$/;

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const uid = user.uid;
  const db = rtdb();

  const requested = String(body?.key || "").toLowerCase();
  if (requested && !KEY_RE.test(requested)) {
    throw new HttpError(400, "INVALID_KEY", "handle must be 3-20 chars: a-z 0-9 _");
  }

  // ownership proof — registry (current owner) + permanent held-usernames map
  const [registrySnap, heldSnap, settingsSnap] = await Promise.all([
    db.ref("usernames").once("value"),
    db.ref(`users/${uid}/profile/usernames`).once("value"),
    db.ref(`privatePublicProfileSettings/${uid}`).once("value"),
  ]);
  const registry = registrySnap.val() || {};
  const held = Object.keys(heldSnap.val() || {});
  const published = String(settingsSnap.val()?.publishedUsername || "").toLowerCase();

  const ownedKeys = new Set(
    [
      ...Object.entries(registry).filter(([, owner]) => owner === uid).map(([k]) => k),
      ...held,
      ...(published ? [published] : []),
    ].map((k) => String(k).toLowerCase()),
  );

  const targets = requested ? [requested] : [...ownedKeys];
  const purged: string[] = [];
  for (const key of targets) {
    if (!KEY_RE.test(key) || !ownedKeys.has(key)) continue; // not provably theirs
    const snap = await db.ref(`publicProfiles/${key}`).once("value");
    if (!snap.exists()) continue;
    const val = snap.val() || {};
    if (val.uid && val.uid !== uid) continue; // another user's live snapshot — never touch
    const isStub = typeof val.redirect === "string" && !val.uid;
    const brokenOwnSnapshot = !!val.uid && !(val.username && val.usernameKey && val.displayName);
    if (isStub || brokenOwnSnapshot) {
      await db.ref(`publicProfiles/${key}`).remove();
      purged.push(key);
    }
  }

  await logLedger({ type: "profile_stub_repair", target: uid, purged, by: user.email || uid });
  res.status(200).json({ ok: true, uid, purged });
});

function safeParse(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}
