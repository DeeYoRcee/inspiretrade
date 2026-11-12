/**
 * POST /api/cases/open
 * Body: { type?: "inspire" | "gold" }  (default: inspire)
 * Consumes one case of the given type and rolls a fragment server-side
 * (crypto RNG). The client only animates the reveal — the outcome is
 * decided here.
 */
import crypto from "crypto";
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger, decrementCounter } from "../lib/firebase";
import { CASES, TOTAL_DROP_WEIGHT, TOTAL_DROP_WEIGHT_GOLD, type FragmentDef } from "../lib/fragments";

export function rollFragment(list: FragmentDef[], totalWeight: number) {
  let roll = crypto.randomInt(totalWeight * 100) / 100; // 0 .. 99.99
  for (const fragment of list) {
    roll -= fragment.dropPercent;
    if (roll < 0) return fragment;
  }
  return list[0];
}

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const caseType = body.type === "gold" ? "gold" : "inspire";
  const caseDef = CASES[caseType];

  // Atomically consume one case of the requested type (see decrementCounter
  // for why the transaction update fn must never return undefined).
  const counterRef =
    caseType === "gold"
      ? db.ref(`economy/${user.uid}/goldCases`)
      : db.ref(`economy/${user.uid}/cases`);
  await decrementCounter(
    counterRef,
    new HttpError(
      400,
      caseType === "gold" ? "NO_GOLD_CASES" : "NO_CASES",
      caseType === "gold" ? "You have no Gold Cases to open" : "You have no cases to open",
    ),
  );

  const fragment = rollFragment(
    caseDef.fragments,
    caseType === "gold" ? TOTAL_DROP_WEIGHT_GOLD : TOTAL_DROP_WEIGHT,
  );

  await db
    .ref(`inventory/${user.uid}/${fragment.id}/count`)
    .transaction((current: any) => (current || 0) + 1);
  await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);

  await logLedger({ type: "case_open", uid: user.uid, caseType, fragmentId: fragment.id, rarity: fragment.rarity });

  res.status(200).json({ ok: true, caseType, caseName: caseDef.name, fragment });
});
