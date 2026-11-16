/**
 * Username marketplace — owner-grade listing management.
 *
 *   ?action=usernameList   POST { username, price } — put a handle up for sale
 *   ?action=usernameUnlist POST { listingId }       — pull a listing
 *
 * Listing rules: the owner may sell any FREE handle or one the owner holds
 * themselves (a previously claimed non-primary collectible). A handle owned
 * by ANOTHER user can never be listed — identities are not stealable from
 * regular users. The listing itself holds nothing physical: on buy the
 * `usernames/{key}` mapping transfers and the buyer's profile switches.
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";
import { MIN_LISTING_PRICE, MAX_LISTING_PRICE } from "../lib/fragments";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const action = new URL(req.url || "/", "http://localhost").searchParams.get("action") || "";
  const db = rtdb();

  if (action === "usernameUnlist") {
    const listingId = String(body.listingId || "");
    const snap = await db.ref(`market/${listingId}`).get();
    const listing = snap.val();
    if (!listing || listing.kind !== "username") throw new HttpError(404, "NO_LISTING", "Listing not found");
    await db.ref(`market/${listingId}`).set(null);
    await logLedger({ type: "username_unlist", listingId, usernameKey: listing.usernameKey, by: admin.email || admin.uid });
    res.status(200).json({ ok: true });
    return;
  }

  // ---- usernameList --------------------------------------------------------
  const username = String(body.username || "").trim();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "INVALID_USERNAME", "3-20 chars: letters, digits, underscore");
  }
  const key = username.toLowerCase();

  const rawPrice = Number(body.price);
  const priceCents = Math.round(rawPrice * 100);
  const price = priceCents / 100;
  if (!Number.isFinite(rawPrice) || Math.abs(rawPrice - price) > 1e-9 || price < MIN_LISTING_PRICE || price > MAX_LISTING_PRICE) {
    throw new HttpError(400, "BAD_PRICE", `Price must be between ${MIN_LISTING_PRICE} and ${MAX_LISTING_PRICE} INSP (up to 2 decimals)`);
  }

  // a handle owned by ANOTHER user is off-limits
  const ownerUid = (await db.ref(`usernames/${key}`).get()).val() || null;
  if (ownerUid && ownerUid !== admin.uid) {
    throw new HttpError(409, "USERNAME_TAKEN", "That username belongs to another user");
  }
  if (ownerUid === admin.uid) {
    // the owner holds it — only non-primary handles may be sold directly
    const profile = (await db.ref(`users/${admin.uid}/profile`).get()).val() || {};
    if (String(profile.username || "").toLowerCase() === key) {
      throw new HttpError(409, "PRIMARY_HANDLE", "Switch to another username first — the primary handle can't be sold from under the profile");
    }
  }

  // replace any earlier listing of the same username
  const all = (await db.ref("market").get()).val() || {};
  for (const [id, l] of Object.entries<any>(all)) {
    if (l && l.kind === "username" && l.usernameKey === key) await db.ref(`market/${id}`).set(null);
  }

  const listingRef = db.ref("market").push();
  const listing = {
    id: listingRef.key,
    kind: "username",
    username,
    usernameKey: key,
    sellerUid: admin.uid,
    sellerName: "InspireTrade",
    itemName: `@${username}`,
    fragmentId: "",
    price,
    status: "active",
    listedAt: Date.now(),
  };
  await listingRef.set(listing);

  await logLedger({ type: "username_list", listingId: listingRef.key, usernameKey: key, price, by: admin.email || admin.uid });

  res.status(200).json({ ok: true, listing });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
