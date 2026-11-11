/**
 * POST /api/market?action=cancel   { listingId }
 * Cancels the caller's own active listing and returns the escrowed fragment.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { listingId } = req.body || {};
  if (!listingId || typeof listingId !== "string") throw new HttpError(400, "BAD_LISTING", "listingId required");

  const db = rtdb();
  const now = Date.now();

  // (The update fn never returns undefined — see decrementCounter in
  // lib/firebase.ts. Success is detected from the post-transaction snapshot.)
  const listingRef = db.ref(`market/${listingId}`);
  const tx = await listingRef.transaction((current: any) => {
    if (current && current.status === "active" && current.sellerUid === user.uid) {
      return { ...current, status: "canceled", canceledAt: now };
    }
    return current; // no-op: not active or not ours
  });
  const listing = tx.snapshot.val();
  if (!tx.committed || !listing || listing.status !== "canceled") {
    throw new HttpError(400, "CANNOT_CANCEL", "Listing is not active or not yours");
  }
  await db
    .ref(`inventory/${user.uid}/${listing.fragmentId}/count`)
    .transaction((c: any) => (c || 0) + 1);
  await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);

  await logLedger({ type: "market_cancel", uid: user.uid, listingId, fragmentId: listing.fragmentId });

  res.status(200).json({ ok: true });
});
