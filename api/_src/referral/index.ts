/**
 * POST /api/referral?action=info|apply
 *
 * Referral system. Each user gets a unique referral code (created lazily on
 * first `info` call). A NEW account can apply a code exactly once:
 *   new user  → +100 INSP welcome bonus
 *   referrer  → +1 Inspire Case per invited friend
 *
 * All writes go through the Admin SDK (clients never touch referral nodes —
 * no database.rules.json changes needed). Economy updates use value-returning
 * transactions only (never undefined — see decrementCounter gotcha note).
 *
 * RTDB layout:
 *   referrals/{uid} = { code, createdAt, count, earned, lastInviteAt,
 *                       referredBy?, referredByCode?, referredAt? }
 *   refCodes/{CODE} = uid            (code → owner lookup)
 */
import { handle, requireUser, rtdb, HttpError, logLedger } from "../lib/firebase";

const BONUS_NEW = 100; // INSP for the invited (new) user
const REFERRAL_CASES = 1; // Inspire Cases granted to the referrer per invited friend

// Unambiguous alphabet (no 0/O, 1/I/L confusion) — codes are shown in URLs.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  let s = "";
  for (let i = 0; i < 7; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function bodyCode(req: any): string {
  const url = new URL(req.url || "/", "http://localhost");
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  return String(body?.code || url.searchParams.get("code") || "").trim().toUpperCase();
}

/** Get (or lazily create) the caller's referral code. */
async function ensureCode(uid: string): Promise<string> {
  const nodeRef = rtdb().ref(`referrals/${uid}`);
  const existing = (await nodeRef.get()).val();
  if (existing?.code) return String(existing.code);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const codeVal = (await rtdb().ref(`refCodes/${code}`).get()).val();
    if (codeVal && codeVal !== uid) continue; // collision — try again

    const tx = await nodeRef.transaction((cur: any) => {
      if (cur?.code) return cur; // lost the race — keep the existing code
      return { ...(cur || {}), code, createdAt: Date.now() };
    });
    const committedCode = tx?.snapshot?.val?.()?.code;
    if (!tx.committed || !committedCode) continue;
    // Point the code at this user (overwrite only our own stale entry).
    if (codeVal !== uid) await rtdb().ref(`refCodes/${committedCode}`).set(uid);
    return String(committedCode);
  }
  throw new HttpError(500, "CODE_GEN_FAILED", "Could not create a referral code, try again");
}

export default handle(async (req, res) => {
  // info is called with GET (authedFetch without body); apply via POST.
  if (req.method !== "GET" && req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET or POST only");
  }
  const user = await requireUser(req);
  const url = new URL(req.url || "/", "http://localhost");
  const action = url.searchParams.get("action") || "info";

  if (action === "info") {
    const code = await ensureCode(user.uid);
    const node = (await rtdb().ref(`referrals/${user.uid}`).get()).val() || {};
    return res.status(200).json({
      ok: true,
      code,
      invited: node.count || 0,
      earned: node.earned || 0,
      referredByCode: node.referredByCode || null,
      bonuses: { new: BONUS_NEW, referrerCase: REFERRAL_CASES },
    });
  }

  if (action === "apply") {
    const code = bodyCode(req);
    if (!/^[A-Z0-9]{4,10}$/.test(code)) {
      throw new HttpError(400, "BAD_CODE", "Invalid referral code format");
    }
    const referrerUid = (await rtdb().ref(`refCodes/${code}`).get()).val();
    if (!referrerUid || typeof referrerUid !== "string") {
      throw new HttpError(404, "CODE_NOT_FOUND", "Referral code not found");
    }
    if (referrerUid === user.uid) {
      throw new HttpError(400, "SELF_REFERRAL", "You cannot use your own referral code");
    }

    // Claim the referral atomically on the new user's node. Value-returning
    // no-op pattern: on a concurrent claim we keep the existing referredBy
    // and detect the loss by comparing the snapshot afterwards.
    const now = Date.now();
    const tx = await rtdb()
      .ref(`referrals/${user.uid}`)
      .transaction((cur: any) => {
        if (cur?.referredBy) return cur; // already referred — no-op
        return { ...(cur || {}), referredBy: referrerUid, referredByCode: code, referredAt: now };
      });
    const after = tx?.snapshot?.val?.() || {};
    if (!tx.committed || after.referredBy !== referrerUid) {
      throw new HttpError(409, "ALREADY_REFERRED", "This account already has a referrer");
    }

    // Bonuses (each an independent atomic grant; logged for audit).
    await rtdb()
      .ref(`economy/${user.uid}`)
      .transaction((cur: any) => ({
        ...(cur || { coins: 0, cases: 0, goldCases: 0 }),
        coins: (cur?.coins || 0) + BONUS_NEW,
        updatedAt: now,
      }));
    // Referrer reward: +1 Inspire Case per invited friend (atomic grant).
    await rtdb()
      .ref(`economy/${referrerUid}/cases`)
      .transaction((c: any) => (c || 0) + REFERRAL_CASES);
    await rtdb()
      .ref(`referrals/${referrerUid}`)
      .transaction((cur: any) => ({
        ...(cur || {}),
        count: (cur?.count || 0) + 1,
        earned: (cur?.earned || 0) + REFERRAL_CASES,
        lastInviteAt: now,
      }));
    await logLedger({
      type: "referral_apply",
      newUid: user.uid,
      referrerUid,
      code,
      bonusNew: BONUS_NEW,
      referralCases: REFERRAL_CASES,
    });

    return res.status(200).json({ ok: true, bonusNew: BONUS_NEW, referralCases: REFERRAL_CASES });
  }

  throw new HttpError(400, "BAD_ACTION", "Unknown referral action (use info|apply)");
});
