/**
 * POST /api/admin?action=set-username   (owner only)
 * Body: { username }
 * Owner-grade username claim, Telegram-collectible style: the owner can hold
 * MANY usernames at once — each new claim is ADDED to the owner's profile
 * (previous ones stay owned by the owner, not released) and the public
 * profile moves to the newest handle; old public URLs keep working via a
 * lightweight redirect record.
 * Regular users must go through the atomic claim in UsernameDialog; this
 * endpoint deliberately bypasses the "taken" check because the owner IS
 * the platform (e.g. @CEO, @gold, celebrity-style handles).
 *
 * Side effects:
 *   usernames/{key}                  → owner uid (overwrites any owner)
 *   users/{uid}/profile.username     → new primary handle
 *   users/{uid}/profile.usernames/   → { key: { username, at } } accumulation
 *   publicProfiles/{newKey}          ← snapshot copied, + ceo:true
 *   publicProfiles/{oldKey}          → { redirect: newKey } (old URL follows)
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

  // current username of the owner (the primary that moves to the new handle)
  const profileSnap = await db.ref(`users/${admin.uid}/profile`).once("value");
  const profile = profileSnap.val() || {};
  const oldKey = typeof profile.username === "string" ? profile.username.toLowerCase() : "";
  const changedKey = oldKey !== key;

  // claim the handle — the OLD one stays owned (owner accumulates, TG-style)
  if (changedKey) {
    await db.ref(`usernames/${key}`).set(admin.uid);
  }

  // profile — primary username + permanent CEO badge + the held-usernames map
  await db.ref(`users/${admin.uid}/profile`).transaction((p: any) => ({
    ...(p || {}),
    uid: admin.uid,
    username,
    ceo: true,
    usernames: { ...((p && p.usernames) || {}), [key]: { username, at: Date.now() } },
  }));

  // move the public snapshot so the new URL works immediately; the old URL
  // keeps resolving through a redirect record (public profile page follows it)
  if (changedKey && oldKey) {
    const oldSnap = await db.ref(`publicProfiles/${oldKey}`).once("value");
    if (oldSnap.exists()) {
      await db.ref(`publicProfiles/${key}`).set({ ...oldSnap.val(), username: key, usernameKey: key, ceo: true, updatedAt: Date.now() });
      await db.ref(`publicProfiles/${oldKey}`).set({ redirect: key, updatedAt: Date.now() });
    }
  }
  // (re)stamp ceo on whatever snapshot is live under the new key — but NEVER
  // create a bare record. Phase 21 root-cause fix for "the owner cannot create
  // a public profile": for a first-time owner there is no snapshot yet, and
  // the old unconditional set() produced a uid-less {ceo:true} orphan that
  // blocked the client's own publish forever (the rules deny overwriting a
  // record whose uid doesn't match, and the stub purge didn't recognize it).
  // The badge now lands with the snapshot the owner publishes from
  // PublicProfileSettings (the builder carries profile.ceo).
  const live = (await db.ref(`publicProfiles/${key}`).once("value")).val();
  if (live && live.uid) {
    await db.ref(`publicProfiles/${key}/ceo`).set(true);
  }

  // Phase 20: keep the publish settings in sync — the public-profile page
  // saves under settings.publishedUsername; a stale value pointed at the
  // redirect stub left at the old handle and blocked every save with
  // "Profile handle is locked by an incomplete rename"
  await db.ref(`privatePublicProfileSettings/${admin.uid}`).transaction((s: any) => {
    if (!s) return s; // never published — nothing to sync
    return { ...s, publishedUsername: key, updatedAt: Date.now() };
  });

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
