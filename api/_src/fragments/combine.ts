/**
 * POST /api/fragments/combine
 * Body: { set?: "inspire" | "gold" }  (default: inspire)
 * Burns one fragment of each of the 9 types of the chosen set (verified
 * atomically in a single transaction over the user's inventory) and creates
 * a prop-account claim: 5k$ set → $5,000 account, gold set → $10,000 account.
 */
import crypto from "crypto";
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";
import { CASES, type CaseType } from "../lib/fragments";

function makeReference(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return `${prefix}-${code}`;
}

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const set: CaseType = body.set === "gold" ? "gold" : "inspire";
  const caseDef = CASES[set];
  const fragmentList = caseDef.fragments;

  // Single atomic transaction over the whole inventory: verify all 9 types of
  // the set are present, then burn one of each. The update fn NEVER returns
  // undefined (firebase-admin 12 aborts those instantly on a cold cache — see
  // decrementCounter in lib/firebase.ts). Insufficient inventory = no-op, and
  // success is detected by comparing the post-transaction snapshot.
  const invRef = db.ref(`inventory/${user.uid}`);
  const beforeSnap = (await invRef.get()).val() || {};
  const burn = (inv: any) => {
    const next = JSON.parse(JSON.stringify(inv));
    for (const fragment of fragmentList) {
      next[fragment.id] = {
        ...(next[fragment.id] || {}),
        count: ((next[fragment.id] || {}).count || 0) - 1,
        updatedAt: now,
      };
    }
    return next;
  };
  const hasAll = (inv: any) => fragmentList.every((f) => ((inv || {})[f.id] || {}).count >= 1);
  const tx = await invRef.transaction((current: any) => {
    const inv = current || {};
    return hasAll(inv) ? burn(inv) : inv; // no-op when incomplete
  });
  const after = tx?.snapshot?.val?.() || {};
  if (!tx?.committed || JSON.stringify(after) === JSON.stringify(beforeSnap)) {
    throw new HttpError(400, "MISSING_FRAGMENTS", "You need at least one fragment of every type (9 total)");
  }

  const reference = makeReference(set === "gold" ? "GLD" : "INSP");
  const claimRef = db.ref(`claims/${user.uid}`).push();
  const claim = {
    id: claimRef.key,
    createdAt: now,
    reference,
    status: "pending",
    set,
    accountSize: caseDef.accountSize,
    fragments: Object.fromEntries(fragmentList.map((f) => [f.id, true])),
  };
  await claimRef.set(claim);

  await logLedger({ type: "combine", uid: user.uid, claimId: claimRef.key, reference, set });

  res.status(200).json({ ok: true, claim });
});
