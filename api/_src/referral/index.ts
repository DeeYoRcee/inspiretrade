/**
 * POST /api/referral?action=info|apply
 *
 * Referral system. Each user gets a unique referral code (created lazily on
 * first `info` call). A NEW account can apply a code exactly once:
 *   NO rewards are granted — the code only records who invited whom
 *   (per product decision: neither INSP nor cases for referrals).
 *
 * All writes go through the Admin SDK (clients never touch referral nodes —
 * no database.rules.json changes needed).
 *
 * RTDB layout:
 *   referrals/{uid} = { code, createdAt, count, lastInviteAt,
 *                       referredBy?, referredByCode?, referredAt? }
 *   refCodes/{CODE} = uid            (code → owner lookup)
 */
import { handle, requireUser, rtdb, HttpError, logLedger } from "../lib/firebase";
import { REFERRAL_MILESTONES } from "../lib/fragments";

const BONUS_NEW = 0; // disabled — no INSP for the invited user
const REFERRAL_CASES = 0; // disabled — no Inspire Cases for the referrer

// Phase 32 — referral milestones. One-time rewards for reaching an invited
// count; claimed explicitly from the Wallet page. A tier can be claimed only
// when the referrer's count has REACHED the threshold; everything is
// transactional (referralMilestones/{uid}/{tier} = true) and ledgered.


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
    const claimed = (await rtdb().ref(`referralMilestones/${user.uid}`).get()).val() || {};
    return res.status(200).json({
      ok: true,
      code,
      invited: node.count || 0,
      earned: node.earned || 0,
      referredByCode: node.referredByCode || null,
      bonuses: { new: BONUS_NEW, referrerCase: REFERRAL_CASES },
      milestones: REFERRAL_MILESTONES,
      claimedMilestones: Object.keys(claimed).filter((k) => claimed[k] === true).map(Number),
    });
  }

  // Phase 32: claim a referral milestone tier (one-time, atomic). The grant
  // rides INSIDE the economy transaction and is validated by a unique token
  // landing in the node — concurrent claims of the same tier cannot double-
  // grant (the loser's token never lands, so it must not credit anything).
  if (action === "milestone") {
    const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
    const tierIdx = Number(body?.tier);
    const tier = REFERRAL_MILESTONES[tierIdx];
    if (!tier) throw new HttpError(400, "BAD_TIER", "Unknown milestone tier");
    const node = (await rtdb().ref(`referrals/${user.uid}`).get()).val() || {};
    if ((node.count || 0) < tier.invited) {
      throw new HttpError(409, "NOT_REACHED", `You need ${tier.invited} invited users to claim this reward`);
    }
    const token = `${user.uid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const now = Date.now();
    const ecoTx = await rtdb()
      .ref(`economy/${user.uid}`)
      .transaction((eco: any) => {
        const e = { ...(eco || {}) };
        const milestones = { ...((e as any).milestones || {}) };
        const existing = milestones[tierIdx];
        if (existing?.claimed === true) return e; // no-op — already claimed (token differs)
        milestones[tierIdx] = { claimed: true, token, at: now };
        return {
          ...e,
          milestones,
          coins: (e.coins || 0) + tier.insp,
          cases: (e.cases || 0) + tier.cases,
          goldCases: (e.goldCases || 0) + tier.goldCases,
          updatedAt: now,
        };
      });
    const after = ecoTx?.snapshot?.val?.() || {};
    const won = ecoTx.committed && (after as any)?.milestones?.[tierIdx]?.token === token;
    if (!won) {
      throw new HttpError(409, "ALREADY_CLAIMED", "This milestone reward has already been claimed");
    }
    await logLedger({ type: "referral_milestone", uid: user.uid, tier: tierIdx, invited: tier.invited, cases: tier.cases, goldCases: tier.goldCases, insp: tier.insp });
    return res.status(200).json({ ok: true, tier: tierIdx, reward: { cases: tier.cases, goldCases: tier.goldCases, insp: tier.insp } });
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

    // NO bonuses — rewards are disabled. Only the relationship is recorded
    // (referredBy on the new user's node + count on the referrer's node).
    await rtdb()
      .ref(`referrals/${referrerUid}`)
      .transaction((cur: any) => ({
        ...(cur || {}),
        count: (cur?.count || 0) + 1,
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
