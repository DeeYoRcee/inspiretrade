/**
 * POST /api/market?action=list   { fragmentId, price }  — list a fragment
 *                            OR  { kind: "case", caseId, price } — list a case
 * Creates a market listing. The item is escrowed: it leaves the seller's
 * inventory (or case counters) immediately and is only returned on cancel.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger, decrementCounter } from "../lib/firebase";
import { getFragment, CASES, MAX_ACTIVE_LISTINGS, MIN_LISTING_PRICE, MAX_LISTING_PRICE } from "../lib/fragments";

const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { fragmentId, caseId, price } = req.body || {};
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const kind = body.kind === "case" ? "case" : "fragment";

  // Resolve WHAT is being sold → the escrow counter ref + a friendly name.
  let escrowRef: any;
  let itemName: string;
  let insufficientError: HttpError;
  let listingItem: Record<string, unknown>;

  if (kind === "case") {
    const id = String(caseId || "");
    if (id === "inspire" || id === "gold") {
      escrowRef = id === "gold"
        ? rtdb().ref(`economy/${user.uid}/goldCases`)
        : rtdb().ref(`economy/${user.uid}/cases`);
      itemName = CASES[id].name;
      insufficientError = new HttpError(400, "NO_CASES", "You don't own this case");
      listingItem = { kind: "case", caseId: id };
    } else {
      if (!CASE_ID_RE.test(id)) throw new HttpError(400, "BAD_CASE", "Unknown case");
      const def = (await rtdb().ref(`economyConfig/cases/${id}`).get()).val();
      if (!def) throw new HttpError(400, "BAD_CASE", "Unknown case");
      escrowRef = rtdb().ref(`economy/${user.uid}/customCases/${id}`);
      itemName = String(def.name || id);
      insufficientError = new HttpError(400, "NO_CASES", "You don't own this case");
      listingItem = { kind: "case", caseId: id };
    }
  } else {
    const fragment = getFragment(String(fragmentId || ""));
    if (!fragment) throw new HttpError(400, "BAD_FRAGMENT", "Unknown fragment");
    escrowRef = rtdb().ref(`inventory/${user.uid}/${fragment.id}/count`);
    itemName = fragment.name;
    insufficientError = new HttpError(400, "NO_FRAGMENT", "You don't own this fragment");
    listingItem = { kind: "fragment", fragmentId: fragment.id };
  }

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

  // Escrow: atomically take the item out of the seller's inventory / cases.
  // (See decrementCounter — the update fn must never return undefined.)
  await decrementCounter(escrowRef, insufficientError);

  // Cap the number of active listings per user (refund escrow if exceeded).
  const allListings = (await db.ref("market").get()).val() || {};
  const activeMine = Object.values<any>(allListings).filter(
    (l) => l && l.sellerUid === user.uid && l.status === "active",
  ).length;
  if (activeMine >= MAX_ACTIVE_LISTINGS) {
    await escrowRef.transaction((c: any) => (c || 0) + 1);
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
  const listing: Record<string, any> = {
    id: listingRef.key,
    sellerUid: user.uid,
    sellerName,
    itemName,
    ...listingItem,
    price: normalizedPrice,
    status: "active",
    listedAt: now,
  };
  await listingRef.set(listing);

  await logLedger({ type: "market_list", uid: user.uid, listingId: listingRef.key, kind, caseId: listing.caseId, fragmentId: listing.fragmentId, price: normalizedPrice });

  res.status(200).json({ ok: true, listing });
});
