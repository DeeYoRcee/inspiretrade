/**
 * POST /api/cases/open
 * Consumes one case and rolls a fragment server-side (crypto RNG).
 * The client only animates the reveal — the outcome is decided here.
 */
import crypto from "crypto";
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger, decrementCounter } from "../lib/firebase";
import { FRAGMENTS, TOTAL_DROP_WEIGHT, getFragment } from "../lib/fragments";

export function rollFragment() {
  let roll = crypto.randomInt(TOTAL_DROP_WEIGHT * 100) / 100; // 0 .. 99.99
  for (const fragment of FRAGMENTS) {
    roll -= fragment.dropPercent;
    if (roll < 0) return fragment;
  }
  return FRAGMENTS[0];
}

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();

  const casesRef = db.ref(`economy/${user.uid}/cases`);
  // Atomically consume one case (see decrementCounter for why the transaction
  // update fn must never return undefined).
  await decrementCounter(casesRef, new HttpError(400, "NO_CASES", "You have no cases to open"));

  const fragment = rollFragment();

  await db
    .ref(`inventory/${user.uid}/${fragment.id}/count`)
    .transaction((current: any) => (current || 0) + 1);
  await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);

  await logLedger({ type: "case_open", uid: user.uid, fragmentId: fragment.id, rarity: fragment.rarity });

  res.status(200).json({ ok: true, fragment });
});
