/**
 * POST /api/admin?action=grant-vip   (owner only)
 * Body: { uid?: string, username?: string, vip: boolean, plan?: string }
 * Phase 34: the owner grants (or revokes) VIP membership to anyone. Sets the
 * profile flags every VIP check already reads: isPremium + premiumPlan (+vip).
 * Written through the admin SDK, so RTDB rules do not apply.
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const vip = body.vip === true || body.vip === "true";
  const plan = String(body.plan || "").trim().slice(0, 40) || (vip ? "owner-grant" : "");

  let targetUid = String(body.uid || "").trim();
  let targetEmail = "";
  if (!targetUid) {
    const username = String(body.username || "").trim().toLowerCase();
    if (!username) throw new HttpError(400, "MISSING_TARGET", "Provide uid or username");
    const resolved = (await rtdb().ref(`usernames/${username}`).once("value")).val();
    if (typeof resolved !== "string" || !resolved) {
      throw new HttpError(404, "USER_NOT_FOUND", `No user with username "${username}"`);
    }
    targetUid = resolved;
  }
  try {
    targetEmail = String((await rtdb().ref(`users/${targetUid}/email`).once("value")).val() || "");
  } catch { /* email is optional info for the ledger */ }

  await rtdb().ref(`users/${targetUid}/profile`).update({
    isPremium: vip,
    premiumPlan: vip ? plan : null,
    vip,
  });

  await logLedger({
    type: "admin_grant_vip",
    target: targetUid,
    email: targetEmail,
    vip,
    plan,
    by: admin.email || admin.uid,
  });

  res.status(200).json({ ok: true, targetUid, vip, plan });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
