/**
 * POST /api/market?action=buy   { listingId }
 * Buys an active listing:
 *   1) atomically reserve the listing (status -> sold)
 *   2) atomically deduct buyer coins (revert listing if insufficient)
 *   3) credit seller (price minus 10% fee), deliver fragment to buyer
 * All state changes are logged to /ledger.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";
import { MARKET_FEE_PERCENT } from "../lib/fragments";

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { listingId } = req.body || {};
  if (!listingId || typeof listingId !== "string") throw new HttpError(400, "BAD_LISTING", "listingId required");

  const db = rtdb();
  const now = Date.now();

  // 1) Reserve the listing.
  // (The update fn NEVER returns undefined — firebase-admin 12 aborts those
  // transactions instantly on a cold cache. Instead it no-ops by returning
  // the current listing unchanged, and success is detected from the
  // post-transaction snapshot. See decrementCounter in lib/firebase.ts.)
  const listingRef = db.ref(`market/${listingId}`);
  const tx = await listingRef.transaction((current: any) => {
    if (current && current.status === "active" && current.sellerUid !== user.uid) {
      return { ...current, status: "sold", buyerUid: user.uid, soldAt: now };
    }
    return current; // no-op: missing / sold / own listing
  });
  const reserved = tx.snapshot.val();
  if (!tx.committed || !reserved || reserved.status !== "sold" || reserved.buyerUid !== user.uid) {
    if (reserved && reserved.sellerUid === user.uid) {
      throw new HttpError(400, "OWN_LISTING", "You can't buy your own listing");
    }
    throw new HttpError(400, "NOT_AVAILABLE", "Listing is no longer available");
  }
  const listing = reserved;

  // 2) Deduct buyer coins (no-op + refund if insufficient).
  const coinsRef = db.ref(`economy/${user.uid}/coins`);
  const before = (await coinsRef.get()).val() || 0;
  const payTx = await coinsRef.transaction((c: any) => {
    const v = c || 0;
    return v >= listing.price ? v - listing.price : v; // never undefined
  });
  const coinsAfter = payTx?.snapshot?.val?.() ?? 0;
  if (!payTx?.committed || coinsAfter >= before) {
    // Could not pay — revert the listing reservation.
    await db.ref(`market/${listingId}`).transaction((current: any) => {
      if (current && current.status === "sold" && current.buyerUid === user.uid) {
        return { ...current, status: "active", buyerUid: null, soldAt: null };
      }
      return current; // someone else changed it, leave as-is
    });
    throw new HttpError(400, "INSUFFICIENT_COINS", "Not enough INSP coins");
  }

  // 3) Credit seller and deliver the fragment (cent-accurate fee, 2-decimal prices).
  const priceCents = Math.round(listing.price * 100);
  const feeCents = Math.round((priceCents * MARKET_FEE_PERCENT) / 100);
  const sellerReceives = (priceCents - feeCents) / 100;
  const fee = feeCents / 100;
  await db.ref(`economy/${listing.sellerUid}/coins`).transaction((c: any) => (c || 0) + sellerReceives);
  await db
    .ref(`inventory/${user.uid}/${listing.fragmentId}/count`)
    .transaction((c: any) => (c || 0) + 1);
  await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);

  await logLedger({
    type: "market_buy",
    buyerUid: user.uid,
    sellerUid: listing.sellerUid,
    listingId,
    fragmentId: listing.fragmentId,
    price: listing.price,
    fee,
    sellerReceives,
  });

  res.status(200).json({
    ok: true,
    listing: reserved,
    coinsLeft: coinsAfter,
  });
});
