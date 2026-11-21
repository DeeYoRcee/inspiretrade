/**
 * POST /api/market?action=buy   { listingId }
 * Buys an active listing:
 *   1) atomically reserve the listing (status -> sold)
 *   2) atomically deduct buyer coins (revert listing if insufficient)
 *   3) credit seller (price minus 10% fee), deliver the item — a fragment to
 *      the buyer's inventory, or a case to their economy counters.
 * All state changes are logged to /ledger.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";
import { MARKET_FEE_PERCENT } from "../lib/fragments";

const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;

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

  // revert the reservation (payment failure / undeliverable item)
  const revertListing = async () => {
    await db.ref(`market/${listingId}`).transaction((current: any) => {
      if (current && current.status === "sold" && current.buyerUid === user.uid) {
        return { ...current, status: "active", buyerUid: null, soldAt: null };
      }
      return current; // someone else changed it, leave as-is
    });
  };

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
    await revertListing();
    throw new HttpError(400, "INSUFFICIENT_COINS", "Not enough INSP coins");
  }

  // 3) Credit seller and deliver the item (cent-accurate fee, 2-decimal prices).
  const priceCents = Math.round(listing.price * 100);
  const feeCents = Math.round((priceCents * MARKET_FEE_PERCENT) / 100);
  const sellerReceives = (priceCents - feeCents) / 100;
  const fee = feeCents / 100;
  await db.ref(`economy/${listing.sellerUid}/coins`).transaction((c: any) => (c || 0) + sellerReceives);

  if (listing.kind === "username") {
    await deliverUsername(db, user.uid, listing, revertListing, sellerReceives);
    res.status(200).json({ ok: true, listing: reserved, coinsLeft: coinsAfter, username: listing.username });
    return;
  }

  if (listing.kind === "case") {
    // Case listing — deliver to the matching economy counter. A custom case
    // whose definition was deleted by the owner is undeliverable: revert.
    const caseId = String(listing.caseId || "");
    let deliverRef: any;
    if (caseId === "inspire" || caseId === "gold" || caseId === "trading") {
      deliverRef = caseId === "gold"
        ? db.ref(`economy/${user.uid}/goldCases`)
        : caseId === "trading"
          ? db.ref(`economy/${user.uid}/tradingCases`)
          : db.ref(`economy/${user.uid}/cases`);
    } else if (CASE_ID_RE.test(caseId) && (await db.ref(`economyConfig/cases/${caseId}`).get()).exists()) {
      deliverRef = db.ref(`economy/${user.uid}/customCases/${caseId}`);
    } else {
      await revertListing();
      // refund the buyer's coins (the deduction above is already committed)
      await db.ref(`economy/${user.uid}/coins`).transaction((c: any) => (c || 0) + listing.price);
      throw new HttpError(409, "CASE_UNAVAILABLE", "This case was removed by the owner — your coins are refunded");
    }
    await deliverRef.transaction((c: any) => (c || 0) + 1);
  } else {
    await db
      .ref(`inventory/${user.uid}/${listing.fragmentId}/count`)
      .transaction((c: any) => (c || 0) + 1);
    await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);
  }

  await logLedger({
    type: "market_buy",
    buyerUid: user.uid,
    sellerUid: listing.sellerUid,
    listingId,
    kind: listing.kind || "fragment",
    caseId: listing.caseId,
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

/**
 * Username delivery — Telegram-collectible style transfer.
 * The mapping moves atomically; the buyer's primary handle switches to the
 * purchased username and it joins the buyer's held-usernames map. The buyer's
 * previous handle: released when it was an original claim, KEPT when it was a
 * collectible the buyer already owns. Old public URLs keep working via
 * redirect records. On a lost race (someone claimed the handle meanwhile)
 * everything is reverted and refunded.
 */
async function deliverUsername(db: any, buyerUid: string, listing: any, revertListing: () => Promise<void>, sellerReceives: number) {
  const key = String(listing.usernameKey || "");
  const username = String(listing.username || "");
  const sellerUid = String(listing.sellerUid || "");

  // Phase 32 — collectible handle CAP: the buyer may hold at most
  // VIP 5 / regular 2 usernames (the primary + purchased collectibles,
  // Telegram-style). VIP = premium profile flag, a premium plan, the CEO
  // profile or the owner node in admins/{uid}. Checked BEFORE the handle
  // moves so a rejected buy never leaves a half-delivered state.
  const [buyerProfileSnap, buyerAdminSnap] = await Promise.all([
    db.ref(`users/${buyerUid}/profile`).once("value"),
    db.ref(`admins/${buyerUid}`).once("value"),
  ]);
  const buyerProfile = buyerProfileSnap.val() || {};
  const buyerVip =
    buyerProfile.isPremium === true || !!buyerProfile.premiumPlan ||
    buyerProfile.ceo === true || buyerAdminSnap.val() === true;
  const USERNAME_CAP = buyerVip ? 5 : 2;
  const heldBefore: Record<string, unknown> = { ...((buyerProfile.usernames as Record<string, unknown>) || {}) };
  const primaryBefore = typeof buyerProfile.username === "string" ? buyerProfile.username.toLowerCase() : "";
  const willHold = new Set([...Object.keys(heldBefore), primaryBefore, key].filter(Boolean));
  if (willHold.size > USERNAME_CAP) {
    await revertListing();
    throw new HttpError(
      409,
      "USERNAME_CAP_REACHED",
      buyerVip
        ? `VIP accounts can hold at most ${USERNAME_CAP} usernames`
        : `Accounts can hold at most ${USERNAME_CAP} usernames (VIP raises the cap to 5)`,
    );
  }

  // 1) transfer the handle mapping atomically (free OR held by the seller)
  const mapTx = await db.ref(`usernames/${key}`).transaction((current: any) => {
    if (current === null || current === sellerUid) return buyerUid;
    return current; // someone else owns it — no-op
  });
  const mapOwner = mapTx?.snapshot?.val?.();
  if (!mapTx?.committed || mapOwner !== buyerUid) {
    await revertListing();
    await db.ref(`economy/${buyerUid}/coins`).transaction((c: any) => (c || 0) + listing.price);
    await db.ref(`economy/${sellerUid}/coins`).transaction((c: any) => (c || 0) - sellerReceives);
    throw new HttpError(409, "USERNAME_TAKEN", "That username was just taken by someone else — your coins are refunded");
  }

  // 2) buyer profile: primary switch + accumulate the held-usernames map
  const profileSnap = await db.ref(`users/${buyerUid}/profile`).once("value");
  const profile = profileSnap.val() || {};
  const oldKey = typeof profile.username === "string" ? profile.username.toLowerCase() : "";
  const held: Record<string, unknown> = { ...((profile.usernames as Record<string, unknown>) || {}) };
  const oldWasCollectible = !!held[oldKey];

  if (oldKey && oldKey !== key) {
    if (oldWasCollectible) {
      // keep the old collectible handle owned by the buyer
      await db.ref(`usernames/${oldKey}`).set(buyerUid);
    } else {
      // original handle — release it back to the pool
      await db.ref(`usernames/${oldKey}`).set(null);
    }
  }
  await db.ref(`users/${buyerUid}/profile`).transaction((p: any) => ({
    ...(p || {}),
    uid: buyerUid,
    username,
    usernames: { ...(((p || {}).usernames as Record<string, unknown>) || {}), [key]: { username, at: Date.now() } },
  }));

  // 3) if the seller HELD this collectible, remove it from their map
  const sellerHeldSnap = await db.ref(`users/${sellerUid}/profile/usernames/${key}`).get();
  if (sellerHeldSnap.exists()) await db.ref(`users/${sellerUid}/profile/usernames/${key}`).set(null);

  // 4) move the public snapshot so the new URL works; old URL follows via redirect
  if (oldKey && oldKey !== key) {
    const oldSnap = await db.ref(`publicProfiles/${oldKey}`).once("value");
    if (oldSnap.exists()) {
      const snap = oldSnap.val();
      await db.ref(`publicProfiles/${key}`).set({
        ...snap,
        username,
        usernameKey: key,
        updatedAt: Date.now(),
        usernames: buildUsernamesList(held, { [key]: { username } }),
      });
      await db.ref(`publicProfiles/${oldKey}`).set({ redirect: key, updatedAt: Date.now() });
    }
  }

  await logLedger({
    type: "username_transfer",
    buyerUid,
    sellerUid,
    listingId: listing.id,
    usernameKey: key,
    price: listing.price,
  });
}

/** Merge a held-usernames map into the snapshot's compact list shape. */
function buildUsernamesList(
  held: Record<string, unknown>,
  extra: Record<string, { username: string }>,
): { username: string; key: string }[] {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(held)) {
    const name = (v as any)?.username || k;
    merged[k.toLowerCase()] = name;
  }
  for (const [k, v] of Object.entries(extra)) merged[k.toLowerCase()] = v.username;
  return Object.entries(merged)
    .slice(0, 20)
    .map(([k, name]) => ({ username: name, key: k }));
}
