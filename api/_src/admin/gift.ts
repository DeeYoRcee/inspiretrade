/**
 * POST /api/admin?action=gift   (owner only)
 * Body: { uid?: string, username?: string, coins?: number, cases?: number, goldCases?: number, tradingCases?: number, note?: string }
 * Grants INSP coins and/or cases to a user. Owner-facing tool for deposits
 * processed manually (Telegram payments), gifts and the owner panel spawn.
 */
import { handle, requireAdmin, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";

export default handle(async (req, res) => {
  assertPost(req);
  const admin = await requireAdmin(req);

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const coins = Math.floor(Number(body.coins) || 0);
  const cases = Math.floor(Number(body.cases) || 0);
  const goldCases = Math.floor(Number(body.goldCases) || 0);
  // Phase 32: the Trading Case ($25,000 account puzzle) is grantable too.
  const tradingCases = Math.floor(Number(body.tradingCases) || 0);
  const note = String(body.note || "").slice(0, 200);
  if (coins === 0 && cases <= 0 && goldCases <= 0 && tradingCases <= 0) {
    throw new HttpError(400, "INVALID_AMOUNT", "Provide a positive coins and/or cases amount");
  }

  // Resolve target: direct uid or username key from the usernames map.
  let targetUid = String(body.uid || "").trim();
  if (!targetUid) {
    const username = String(body.username || "").trim().toLowerCase();
    if (!username) throw new HttpError(400, "MISSING_TARGET", "Provide uid or username");
    const resolved = (await rtdb().ref(`usernames/${username}`).once("value")).val();
    if (typeof resolved !== "string" || !resolved) {
      throw new HttpError(404, "USER_NOT_FOUND", `No user with username "${username}"`);
    }
    targetUid = resolved;
  }

  // Phase 34: the OWNER can top up their own INSP freely ("tashla olsin") —
  // higher cap and negative amounts allowed (floor at zero in the tx below).
  // Everyone else keeps the add-only caps.
  const self = targetUid === admin.uid;
  if (!self && coins < 0) throw new HttpError(400, "INVALID_AMOUNT", "Coins must be positive for other users");
  if (coins > (self ? 2_000_000 : 100000)) {
    throw new HttpError(400, "AMOUNT_TOO_LARGE", self ? "Self-gift cap is 2,000,000" : "Gift exceeds limits (coins<=100000)");
  }
  if (cases > 1000 || goldCases > 1000 || tradingCases > 1000) {
    throw new HttpError(400, "AMOUNT_TOO_LARGE", "Gift exceeds limits (cases<=1000, goldCases<=1000, tradingCases<=1000)");
  }

  const tx = await rtdb()
    .ref(`economy/${targetUid}`)
    .transaction((current: any) => {
      const eco = current || { coins: 0, cases: 0, streak: 0, totalClaimed: 0 };
      return {
        ...eco,
        coins: Math.max(0, (eco.coins || 0) + coins), // never negative
        cases: (eco.cases || 0) + cases,
        goldCases: (eco.goldCases || 0) + goldCases,
        tradingCases: (eco.tradingCases || 0) + tradingCases,
        updatedAt: Date.now(),
      };
    });
  if (!tx.committed) throw new HttpError(500, "TX_FAILED", "Could not update economy");

  await logLedger({
    type: "admin_gift",
    target: targetUid,
    coins,
    cases,
    goldCases,
    tradingCases,
    note,
    by: admin.email || admin.uid,
  });

  res.status(200).json({ ok: true, targetUid, coins: tx.snapshot.val().coins, cases: tx.snapshot.val().cases });
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
