/**
 * Case management for the owner — dispatched through /api/admin?action=caseCreate|caseDelete|caseGrant
 * (Vercel Hobby allows max 12 functions, so it lives inside the admin function).
 *
 *   ?action=caseCreate  POST { name, caseId?, fragments: [{ id, weight }] }
 *                       Defines a custom case in economyConfig/cases/<caseId>.
 *                       The pool is any mix of the existing fragments with
 *                       free weights — the roll normalizes them.
 *   ?action=caseDelete  POST { caseId }
 *                       Removes the definition. Users keep unopened counts —
 *                       /api/cases/open answers CASE_NOT_FOUND for those.
 *   ?action=caseGrant   POST { caseId, uid?|username?, count }
 *                       Grants N cases of ANY type (inspire / gold / custom).
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";
import { ALL_FRAGMENTS, CASES } from "../../../shared/fragments";

const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getBody(req: any): any {
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return body || {};
}

function getAction(req: any): string {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
    // fall through to body
  }
  return String(getBody(req)?.action || "");
}

function slugifyCaseId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug.length >= 3 ? slug : `case-${Math.random().toString(36).slice(2, 7)}`;
}

/** economy counter path for a case type + the friendly name. */
export async function caseCounterRef(db: any, uid: string, caseId: string) {
  if (caseId === "inspire") return { ref: db.ref(`economy/${uid}/cases`), name: CASES.inspire.name };
  if (caseId === "gold") return { ref: db.ref(`economy/${uid}/goldCases`), name: CASES.gold.name };
  if (!CASE_ID_RE.test(caseId)) throw new HttpError(400, "BAD_CASE", "Unknown case id");
  const def = (await db.ref(`economyConfig/cases/${caseId}`).get()).val();
  if (!def) throw new HttpError(404, "CASE_NOT_FOUND", `Case "${caseId}" does not exist`);
  return { ref: db.ref(`economy/${uid}/customCases/${caseId}`), name: String(def.name || caseId) };
}

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);
  const db = rtdb();
  const action = getAction(req);
  const body = getBody(req);
  const now = Date.now();

  if (action === "caseCreate") {
    const name = String(body.name || "").trim().slice(0, 40);
    if (name.length < 2) throw new HttpError(400, "BAD_NAME", "Case name must be 2-40 characters");

    const caseId = slugifyCaseId(String(body.caseId || name));
    if (!CASE_ID_RE.test(caseId)) throw new HttpError(400, "BAD_CASE_ID", "Case id must be 3-24 chars of a-z 0-9 -");
    if ((await db.ref(`economyConfig/cases/${caseId}`).get()).exists()) {
      throw new HttpError(409, "CASE_EXISTS", `A case with id "${caseId}" already exists`);
    }

    const rows = Array.isArray(body.fragments) ? body.fragments : [];
    if (rows.length < 1 || rows.length > 12) {
      throw new HttpError(400, "BAD_POOL", "Pick between 1 and 12 fragments for the pool");
    }
    const seen = new Set<string>();
    const fragments: { id: string; weight: number }[] = [];
    let total = 0;
    for (const row of rows) {
      const id = String(row?.id || "");
      if (!ALL_FRAGMENTS.some((f) => f.id === id) || seen.has(id)) continue;
      const weight = Math.round(Number(row?.weight) * 10000) / 10000;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) {
        throw new HttpError(400, "BAD_WEIGHT", "Weights must be > 0 and <= 1000");
      }
      seen.add(id);
      fragments.push({ id, weight });
      total += weight;
    }
    if (fragments.length < 1 || total <= 0 || total > 1000) {
      throw new HttpError(400, "BAD_POOL", "The pool needs at least one fragment (total weight <= 1000)");
    }

    const def = { name, fragments, createdBy: admin.uid, createdAt: now };
    await db.ref(`economyConfig/cases/${caseId}`).set(def);
    await logLedger({ type: "case_create", uid: admin.uid, caseId, name, fragments });

    res.status(200).json({ ok: true, caseId, def });
    return;
  }

  if (action === "caseDelete") {
    const caseId = String(body.caseId || "");
    if (caseId === "inspire" || caseId === "gold") {
      throw new HttpError(400, "BUILTIN_CASE", "The Inspire and Gold cases cannot be deleted");
    }
    if (!CASE_ID_RE.test(caseId)) throw new HttpError(400, "BAD_CASE", "Unknown case id");
    if (!(await db.ref(`economyConfig/cases/${caseId}`).get()).exists()) {
      throw new HttpError(404, "CASE_NOT_FOUND", `Case "${caseId}" does not exist`);
    }
    await db.ref(`economyConfig/cases/${caseId}`).remove();
    await logLedger({ type: "case_delete", uid: admin.uid, caseId });

    res.status(200).json({ ok: true });
    return;
  }

  if (action === "caseGrant") {
    const caseId = String(body.caseId || "");
    const count = Math.floor(Number(body.count) || 0);
    if (count <= 0 || count > 1000) throw new HttpError(400, "INVALID_AMOUNT", "count must be 1..1000");

    let targetUid = String(body.uid || "").trim();
    if (!targetUid) {
      const username = String(body.username || "").trim().toLowerCase().replace("@", "");
      if (!username) throw new HttpError(400, "MISSING_TARGET", "Provide uid or username");
      const resolved = (await db.ref(`usernames/${username}`).get()).val();
      if (typeof resolved !== "string" || !resolved) {
        throw new HttpError(404, "USER_NOT_FOUND", `No user with username "${username}"`);
      }
      targetUid = resolved;
    }

    const counter = await caseCounterRef(db, targetUid, caseId);
    await counter.ref.transaction((c: any) => (c || 0) + count);
    await logLedger({ type: "case_grant", uid: admin.uid, targetUid, caseId, count });

    res.status(200).json({ ok: true, caseName: counter.name });
    return;
  }

  throw new HttpError(400, "BAD_ACTION", "Unknown case action (use caseCreate|caseDelete|caseGrant)");
});
