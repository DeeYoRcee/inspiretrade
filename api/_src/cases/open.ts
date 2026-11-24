/**
 * POST /api/cases/open
 * Body: { type?: "inspire" | "gold" | "<custom-case-id>" }  (default: inspire)
 * Consumes one case of the given type and rolls a fragment server-side
 * (crypto RNG). The client only animates the reveal — the outcome is
 * decided here. Custom cases are defined by the owner in economyConfig/cases
 * (see api/_src/admin/cases.ts) and roll from their own weight pool.
 */
import crypto from "crypto";
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger, decrementCounter } from "../lib/firebase";
import { CASES, TOTAL_DROP_WEIGHT, TOTAL_DROP_WEIGHT_GOLD, BLACK_DROP_PERCENT, expandCasePool, type FragmentDef } from "../lib/fragments";

export function rollFragment(list: FragmentDef[], totalWeight: number) {
  let roll = crypto.randomInt(totalWeight * 100) / 100; // 0 .. total-0.01
  for (const fragment of list) {
    roll -= fragment.dropPercent;
    if (roll < 0) return fragment;
  }
  return list[0];
}

const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;

/** P77 — black-drop claim reference, mirrors combine's INSP/GLD/TRD + suffix. */
function makeBlackReference(set: string): string {
  const prefix = set === "gold" ? "GLD-B" : set === "trading" ? "TRD-B" : "INSP-B";
  return `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const caseType = String(body.type || "inspire");

  // Case definition: built-in (Inspire / Gold) or a custom one from economyConfig.
  let fragments: FragmentDef[];
  let counterRef: any;
  let caseName: string;
  let noCasesError: HttpError;

  if (caseType === "inspire" || caseType === "gold" || caseType === "trading") {
    const caseDef = CASES[caseType];
    fragments = caseDef.fragments;
    caseName = caseDef.name;
    counterRef =
      caseType === "gold"
        ? db.ref(`economy/${user.uid}/goldCases`)
        : caseType === "trading"
          ? db.ref(`economy/${user.uid}/tradingCases`)
          : db.ref(`economy/${user.uid}/cases`);
    noCasesError = new HttpError(
      400,
      caseType === "gold" ? "NO_GOLD_CASES" : caseType === "trading" ? "NO_TRADING_CASES" : "NO_CASES",
      caseType === "gold" ? "You have no Gold Cases to open" : caseType === "trading" ? "You have no Trading Cases to open" : "You have no cases to open",
    );
  } else {
    // custom case — validate the id shape and that the definition still exists
    if (!CASE_ID_RE.test(caseType)) throw new HttpError(400, "BAD_CASE", "Unknown case");
    const def = (await db.ref(`economyConfig/cases/${caseType}`).get()).val();
    if (!def || !Array.isArray(def.fragments) || def.fragments.length === 0) {
      throw new HttpError(404, "CASE_NOT_FOUND", "This case no longer exists");
    }
    // Build the roll pool from the custom weights — fragment metadata (name,
    // icon, rarity) comes from the canonical definitions. Weights are raw and
    // normalized by the roll total, so they don't need to sum to 100.
    // P75: each row also carries a copy count (qty, default 1) — the pool is
    // the EXPANDED list, so "25k$ 9" with qty 9 occupies its exact share.
    fragments = expandCasePool(def.fragments) as FragmentDef[];
    if (fragments.length === 0) {
      throw new HttpError(409, "CASE_EMPTY", "This case has no valid fragments left");
    }
    caseName = String(def.name || caseType);
    counterRef = db.ref(`economy/${user.uid}/customCases/${caseType}`);
    noCasesError = new HttpError(400, "NO_CASES", "You have no cases of this type to open");
  }

  // Atomically consume one case of the requested type (see decrementCounter
  // for why the transaction update fn must never return undefined).
  await decrementCounter(counterRef, noCasesError);

  // P77 — the BLACK special drop: 0.00000001% odds on every built-in case.
  // A hit never touches the fragment pool: the case is consumed and a
  // pending PROP ACCOUNT claim (the same claims/{uid} path the combine flow
  // uses) is deposited instantly. The client renders it as the black card.
  const blackDef = caseType === "inspire" || caseType === "gold" || caseType === "trading"
    ? CASES[caseType].blackDrop
    : null;
  if (blackDef && Math.random() < BLACK_DROP_PERCENT / 100) {
    const reference = makeBlackReference(caseType);
    const claimRef = db.ref(`claims/${user.uid}`).push();
    const claim = {
      id: claimRef.key,
      createdAt: now,
      reference,
      status: "pending",
      set: caseType,
      accountSize: blackDef.accountSize,
      source: "black-drop",
      fragments: {},
    };
    await claimRef.set(claim);
    await logLedger({ type: "case_open_black", uid: user.uid, caseType, caseName, claimId: claimRef.key, accountSize: blackDef.accountSize });
    return res.status(200).json({ ok: true, caseType, caseName, black: { label: blackDef.label, accountSize: blackDef.accountSize, set: caseType, claimId: claimRef.key, reference } });
  }

  const totalWeight = fragments.reduce((s, f) => s + f.dropPercent, 0);
  const fragment = rollFragment(fragments, totalWeight);

  await db
    .ref(`inventory/${user.uid}/${fragment.id}/count`)
    .transaction((current: any) => (current || 0) + 1);
  await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);

  await logLedger({ type: "case_open", uid: user.uid, caseType, caseName, fragmentId: fragment.id, rarity: fragment.rarity });

  res.status(200).json({ ok: true, caseType, caseName, fragment });
});
