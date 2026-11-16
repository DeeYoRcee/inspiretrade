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
import { CASES, ALL_FRAGMENTS } from "../lib/fragments";
export function rollFragment(list, totalWeight) {
    let roll = crypto.randomInt(totalWeight * 100) / 100; // 0 .. total-0.01
    for (const fragment of list) {
        roll -= fragment.dropPercent;
        if (roll < 0)
            return fragment;
    }
    return list[0];
}
const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
export default handle(async (req, res) => {
    assertPost(req);
    const user = await requireUser(req);
    const db = rtdb();
    const now = Date.now();
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const caseType = String(body.type || "inspire");
    // Case definition: built-in (Inspire / Gold) or a custom one from economyConfig.
    let fragments;
    let counterRef;
    let caseName;
    let noCasesError;
    if (caseType === "inspire" || caseType === "gold") {
        const caseDef = CASES[caseType];
        fragments = caseDef.fragments;
        caseName = caseDef.name;
        counterRef =
            caseType === "gold"
                ? db.ref(`economy/${user.uid}/goldCases`)
                : db.ref(`economy/${user.uid}/cases`);
        noCasesError = new HttpError(400, caseType === "gold" ? "NO_GOLD_CASES" : "NO_CASES", caseType === "gold" ? "You have no Gold Cases to open" : "You have no cases to open");
    }
    else {
        // custom case — validate the id shape and that the definition still exists
        if (!CASE_ID_RE.test(caseType))
            throw new HttpError(400, "BAD_CASE", "Unknown case");
        const def = (await db.ref(`economyConfig/cases/${caseType}`).get()).val();
        if (!def || !Array.isArray(def.fragments) || def.fragments.length === 0) {
            throw new HttpError(404, "CASE_NOT_FOUND", "This case no longer exists");
        }
        // Build the roll pool from the custom weights — fragment metadata (name,
        // icon, rarity) comes from the canonical definitions. Weights are raw and
        // normalized by the roll total, so they don't need to sum to 100.
        fragments = def.fragments
            .map((row) => {
            const base = ALL_FRAGMENTS.find((f) => f.id === row?.id);
            if (!base)
                return null;
            const weight = Number(row?.weight);
            if (!Number.isFinite(weight) || weight <= 0)
                return null;
            return { ...base, dropPercent: weight };
        })
            .filter(Boolean);
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
    const totalWeight = fragments.reduce((s, f) => s + f.dropPercent, 0);
    const fragment = rollFragment(fragments, totalWeight);
    await db
        .ref(`inventory/${user.uid}/${fragment.id}/count`)
        .transaction((current) => (current || 0) + 1);
    await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);
    await logLedger({ type: "case_open", uid: user.uid, caseType, caseName, fragmentId: fragment.id, rarity: fragment.rarity });
    res.status(200).json({ ok: true, caseType, caseName, fragment });
});
