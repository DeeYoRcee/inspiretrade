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

  // 1) Reserve the listing. (Warm the cache first — an `undefined`-aborting
  // transaction on a fresh instance would otherwise abort on the locally-null
  // value without consulting the server. See cases/open.ts.)
  const listingRef = db.ref(`market/${listingId}`);
  await listingRef.get();
  const tx = await listingRef.transaction((current: any) => {
    if (!current) return undefined;
    if (current.status !== "active") return undefined;
    if (current.sellerUid === user.uid) return undefined; // can't buy own listing
    return { ...current, status: "sold", buyerUid: user.uid, soldAt: now };
  }, undefined, false); // applyLocally=false: fetch server value first
  if (!tx.committed) {
    const current = tx.snapshot.val();
    if (current && current.sellerUid === user.uid) {
      throw new HttpError(400, "OWN_LISTING", "You can't buy your own listing");
    }
    throw new HttpError(400, "NOT_AVAILABLE", "Listing is no longer available");
  }
  const listing = tx.snapshot.val();

  // 2) Deduct buyer coins (abort + revert if insufficient).
  const coinsRef = db.ref(`economy/${user.uid}/coins`);
  await coinsRef.get();
  const payTx = await coinsRef.transaction((current: any) => {
      const coins = current || 0;
      if (coins < listing.price) return undefined;
      return coins - listing.price;
    }, undefined, false); // applyLocally=false: fetch server value first
  if (!payTx.committed) {
    await db.ref(`market/${listingId}`).transaction((current: any) => {
      if (current && current.status === "sold" && current.buyerUid === user.uid) {
        return { ...current, status: "active", buyerUid: null, soldAt: null };
      }
      return current; // someone else changed it, leave as-is
    });
    throw new HttpError(400, "INSUFFICIENT_COINS", "Not enough INSP coins");
  }

  // 3) Credit seller and deliver the fragment.
  const sellerReceives = Math.floor(listing.price * (1 - MARKET_FEE_PERCENT / 100));
  const fee = listing.price - sellerReceives;
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
    listing: tx.snapshot.val(),
    coinsLeft: payTx.snapshot.val(),
  });
});
