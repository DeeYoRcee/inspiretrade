/**
 * POST /api/fragments/combine
 * Burns one fragment of each of the 9 types (verified atomically in a single
 * transaction over the user's inventory) and creates a prop-account claim.
 */
import crypto from "crypto";
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../_firebase";
import { FRAGMENTS } from "../_fragments";

function makeReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return `INSP-${code}`;
}

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();

  // Single atomic transaction over the whole inventory: verify all 9 types
  // are present, then burn one of each.
  const tx = await db.ref(`inventory/${user.uid}`).transaction((current: any) => {
    const inventory = current || {};
    for (const fragment of FRAGMENTS) {
      if (!((inventory[fragment.id] || {}).count >= 1)) return undefined;
    }
    const next = JSON.parse(JSON.stringify(inventory));
    for (const fragment of FRAGMENTS) {
      next[fragment.id] = {
        ...(next[fragment.id] || {}),
        count: (next[fragment.id].count || 0) - 1,
        updatedAt: now,
      };
    }
    return next;
  });
  if (!tx.committed) {
    throw new HttpError(400, "MISSING_FRAGMENTS", "You need at least one fragment of every type (9 total)");
  }

  const reference = makeReference();
  const claimRef = db.ref(`claims/${user.uid}`).push();
  const claim = {
    id: claimRef.key,
    createdAt: now,
    reference,
    status: "pending",
    fragments: Object.fromEntries(FRAGMENTS.map((f) => [f.id, true])),
  };
  await claimRef.set(claim);

  await logLedger({ type: "combine", uid: user.uid, claimId: claimRef.key, reference });

  res.status(200).json({ ok: true, claim });
});
