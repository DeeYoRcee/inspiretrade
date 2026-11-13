/**
 * /api/admin?action=deposits   (owner only)
 *
 * GET  — list in-app deposit requests (newest first, max 100).
 * POST — act on one request: { uid, id, action: "approve" | "reject" }.
 *        "approve" credits the requested INSP to the user's balance
 *        atomically; "reject" just marks the request rejected.
 */
import { handle, requireAdmin, rtdb, HttpError, logLedger } from "../lib/firebase";

export default handle(async (req, res) => {
  const admin = await requireAdmin(req);
  const db = rtdb();

  if (req.method === "GET") {
    const snap = await db.ref("depositRequests").once("value");
    const all = (snap.val() || {}) as Record<string, Record<string, any>>;
    const list: any[] = [];
    for (const [uid, requests] of Object.entries(all)) {
      for (const [id, request] of Object.entries(requests || {})) {
        list.push({ ...request, uid, id });
      }
    }
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return res.status(200).json({ ok: true, deposits: list.slice(0, 100) });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const targetUid = String(body.uid || "");
  const id = String(body.id || "");
  const action = String(body.action || "");
  if (!targetUid || !id || !["approve", "reject"].includes(action)) {
    throw new HttpError(400, "INVALID_REQUEST", "Provide uid, id and action (approve|reject)");
  }

  const requestRef = db.ref(`depositRequests/${targetUid}/${id}`);
  const current = (await requestRef.once("value")).val();
  if (!current) throw new HttpError(404, "NOT_FOUND", "Deposit request not found");
  if (current.status !== "pending") {
    throw new HttpError(409, "ALREADY_PROCESSED", `Request is already ${current.status}`);
  }

  if (action === "approve") {
    // Credit the coins atomically.
    await db
      .ref(`economy/${targetUid}`)
      .transaction((eco: any) => ({
        ...(eco || { coins: 0, cases: 0 }),
        coins: (eco?.coins || 0) + (current.amount || 0),
        updatedAt: Date.now(),
      }));
  }

  await requestRef.update({
    status: action === "approve" ? "approved" : "rejected",
    processedAt: Date.now(),
    processedBy: admin.email || admin.uid,
  });
  await logLedger({
    type: action === "approve" ? "deposit_approved" : "deposit_rejected",
    target: targetUid,
    amount: current.amount,
    by: admin.email || admin.uid,
  });

  res.status(200).json({ ok: true, status: action });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
