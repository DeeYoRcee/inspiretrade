/**
 * POST /api/market?action=list   { fragmentId, price }
 * Creates a market listing. The fragment is escrowed: it leaves the seller's
 * inventory immediately and is only returned on cancel.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger, decrementCounter } from "../lib/firebase";
import { getFragment, MAX_ACTIVE_LISTINGS, MIN_LISTING_PRICE, MAX_LISTING_PRICE } from "../lib/fragments";

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { fragmentId, price } = req.body || {};

  const fragment = getFragment(String(fragmentId || ""));
  if (!fragment) throw new HttpError(400, "BAD_FRAGMENT", "Unknown fragment");

  // Prices are decimal INSP with 2-digit precision (e.g. 0.03). Normalize to
  // cents and reject anything that isn't an exact 2-decimal value.
  const rawPrice = Number(price);
  const priceCents = Math.round(rawPrice * 100);
  const normalizedPrice = priceCents / 100;
  if (
    !Number.isFinite(rawPrice) ||
    Math.abs(rawPrice - normalizedPrice) > 1e-9 ||
    normalizedPrice < MIN_LISTING_PRICE ||
    normalizedPrice > MAX_LISTING_PRICE
  ) {
    throw new HttpError(400, "BAD_PRICE", `Price must be between ${MIN_LISTING_PRICE} and ${MAX_LISTING_PRICE} INSP (up to 2 decimals)`);
  }

  const db = rtdb();
  const now = Date.now();

  // Escrow: atomically take the fragment out of the seller's inventory.
  // (See decrementCounter — the update fn must never return undefined.)
  const countRef = db.ref(`inventory/${user.uid}/${fragment.id}/count`);
  await decrementCounter(countRef, new HttpError(400, "NO_FRAGMENT", "You don't own this fragment"));

  // Cap the number of active listings per user (refund escrow if exceeded).
  const allListings = (await db.ref("market").get()).val() || {};
  const activeMine = Object.values<any>(allListings).filter(
    (l) => l && l.sellerUid === user.uid && l.status === "active",
  ).length;
  if (activeMine >= MAX_ACTIVE_LISTINGS) {
    await db.ref(`inventory/${user.uid}/${fragment.id}/count`).transaction((c: any) => (c || 0) + 1);
    throw new HttpError(400, "TOO_MANY_LISTINGS", `You can have at most ${MAX_ACTIVE_LISTINGS} active listings`);
  }

  let sellerName = "Trader";
  try {
    const snap = await db.ref(`users/${user.uid}/profile/username`).get();
    if (snap.exists() && typeof snap.val() === "string") sellerName = snap.val();
  } catch {
    // fall back to generic name
  }

  const listingRef = db.ref("market").push();
  const listing = {
    id: listingRef.key,
    sellerUid: user.uid,
    sellerName,
    fragmentId: fragment.id,
    price: normalizedPrice,
    status: "active",
    listedAt: now,
  };
  await listingRef.set(listing);
  await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);

  await logLedger({ type: "market_list", uid: user.uid, listingId: listingRef.key, fragmentId: fragment.id, price: normalizedPrice });

  res.status(200).json({ ok: true, listing });
});
