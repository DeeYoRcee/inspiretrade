/**
 * POST /api/admin?action=set-username   (owner only)
 * Body: { username }
 * Owner-grade username claim: takes ANY handle — even one that is already
 * taken or was released — and moves the owner's public profile to it.
 * Regular users must go through the atomic claim in UsernameDialog; this
 * endpoint deliberately bypasses the "taken" check because the owner IS
 * the platform (e.g. @CEO, @gold, celebrity-style handles).
 *
 * Side effects:
 *   usernames/{key}              → owner uid (overwrites the previous owner)
 *   users/{uid}/profile          → username + ceo:true
 *   usernames/{oldKey}           → released (null)
 *   publicProfiles/{newKey}      ← old snapshot copied, + ceo:true
 *   publicProfiles/{oldKey}      → removed (the old URL stops resolving)
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const username = String(body.username || "").trim();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "INVALID_USERNAME", "3-20 chars: letters, digits, underscore");
  }
  const key = username.toLowerCase();
  const db = rtdb();

  // current username of the owner (to release + move the public snapshot)
  const profileSnap = await db.ref(`users/${admin.uid}/profile`).once("value");
  const profile = profileSnap.val() || {};
  const oldKey = typeof profile.username === "string" ? profile.username.toLowerCase() : "";
  const changedKey = oldKey !== key;

  if (changedKey) {
    // steal the handle: overwrite whatever mapping is there (owner override)
    await db.ref(`usernames/${key}`).set(admin.uid);
    await db.ref(`usernames/${oldKey}`).set(null);
  }

  // profile — username + permanent CEO badge
  await db.ref(`users/${admin.uid}/profile`).transaction((p: any) => ({
    ...(p || {}),
    uid: admin.uid,
    username,
    ceo: true,
  }));

  // move the public snapshot so the new URL works immediately
  if (changedKey && oldKey) {
    const oldSnap = await db.ref(`publicProfiles/${oldKey}`).once("value");
    if (oldSnap.exists()) {
      await db.ref(`publicProfiles/${key}`).set({ ...oldSnap.val(), username, usernameKey: key, ceo: true, updatedAt: Date.now() });
      await db.ref(`publicProfiles/${oldKey}`).set(null);
    }
  }
  // (re)stamp ceo on whatever snapshot is live under the new key
  await db.ref(`publicProfiles/${key}/ceo`).set(true);

  await logLedger({ type: "owner_set_username", target: admin.uid, username, by: admin.email || admin.uid });

  res.status(200).json({ ok: true, username, key });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
