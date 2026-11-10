/**
 * POST /api/rewards/claim
 * Grants the daily reward: +1 case, +1 INSP (streak bonus every 7th day).
 * The whole check-and-grant runs inside a single RTDB transaction keyed on
 * the user's economy node, so a claim can only succeed once per local day.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, localDate, previousDate, logLedger } from "../firebase-helper";
import { DAILY_COINS, STREAK_BONUS_EVERY, STREAK_BONUS_COINS, STREAK_BONUS_CASES } from "../fragments-helper";

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const now = Date.now();
  const today = localDate(); // Asia/Tashkent (UTC+5), no DST

  const result = await rtdb()
    .ref(`economy/${user.uid}`)
    .transaction((current: any) => {
      const eco = current || { coins: 0, cases: 0, streak: 0, totalClaimed: 0 };
      if (eco.lastClaimDate === today) return undefined; // abort: already claimed
      const continued = eco.lastClaimDate === previousDate(today);
      const streak = continued ? (eco.streak || 0) + 1 : 1;
      const bonus = streak % STREAK_BONUS_EVERY === 0;
      return {
        coins: (eco.coins || 0) + DAILY_COINS + (bonus ? STREAK_BONUS_COINS : 0),
        cases: (eco.cases || 0) + 1 + (bonus ? STREAK_BONUS_CASES : 0),
        streak,
        lastClaimDate: today,
        totalClaimed: (eco.totalClaimed || 0) + 1,
        updatedAt: now,
      };
    });

  if (!result.committed) {
    throw new HttpError(409, "ALREADY_CLAIMED_TODAY", "Daily reward already claimed");
  }

  const economy = result.snapshot.val();
  await logLedger({ type: "daily_claim", uid: user.uid, streak: economy.streak, day: today });

  res.status(200).json({ ok: true, economy });
});
