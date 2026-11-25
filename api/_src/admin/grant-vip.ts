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
  // P64R4 user request — owner grants now carry a VISIBLE duration:
  // monthly = 30 days, yearly = 365 days, anything else = open-ended
  // (premiumUntil is enforced reactively by the verify endpoint).
  const PLAN_DAYS: Record<string, number> = { monthly: 30, yearly: 365 };
  const plan = String(body.plan || "").trim().slice(0, 40) || (vip ? "owner-grant" : "");
  const grantDays = PLAN_DAYS[plan] ?? 0;
  const premiumUntil = vip && grantDays > 0 ? Date.now() + grantDays * 86_400_000 : null;

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
    premiumSince: vip ? Date.now() : null,
    // null clears a previous duration on revoke or on a permanent grant
    premiumUntil,
  });

  await logLedger({
    type: "admin_grant_vip",
    target: targetUid,
    email: targetEmail,
    vip,
    plan,
    grantDays,
    premiumUntil,
    by: admin.email || admin.uid,
  });

  res.status(200).json({ ok: true, targetUid, vip, plan, grantDays, premiumUntil });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
