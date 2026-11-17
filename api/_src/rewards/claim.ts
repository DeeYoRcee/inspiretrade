/**
 * POST /api/rewards/claim
 * PUBG-style 7-day login cycle: days 1-6 grant an Inspire Case (5k$ fragments),
 * day 7 grants the Gold Case (10k$ fragments). No INSP is granted.
 * The whole check-and-grant runs inside a single RTDB transaction keyed on
 * the user's economy node, so a claim can only succeed once per local day.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, localDate, previousDate, logLedger } from "../lib/firebase";
import { REWARD_CYCLE_DAYS, cycleDayOf, caseTypeForCycleDay, CASES } from "../lib/fragments";

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const now = Date.now();
  const today = localDate(); // Asia/Tashkent (UTC+5), no DST

  const result = await rtdb()
    .ref(`economy/${user.uid}`)
    .transaction((current: any) => {
      const eco = current || { coins: 0, cases: 0, goldCases: 0, streak: 0, totalClaimed: 0 };
      if (eco.lastClaimDate === today) return undefined; // abort: already claimed
      const continued = eco.lastClaimDate === previousDate(today);
      // Number() guard: a streak stored as a string ("7") would otherwise be
      // concatenated ("7" + 1 = "71") and the 7-day cycle would never follow
      // 1→7 again — the reported "cycle doesn't restart" bug. One claim
      // normalizes the field back to a clean number.
      const streak = continued ? Math.floor(Number(eco.streak) || 0) + 1 : 1;
      const cycleDay = cycleDayOf(streak);
      const caseType = caseTypeForCycleDay(cycleDay);
      // spread eco — a transaction return REPLACES the node, so a bare object
      // would wipe fields written elsewhere (customCases from opened custom
      // cases, future fields); coins stay untouched — cases only
      return {
        ...eco,
        coins: eco.coins || 0,
        cases: (eco.cases || 0) + (caseType === "inspire" ? 1 : 0),
        goldCases: (eco.goldCases || 0) + (caseType === "gold" ? 1 : 0),
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
  const cycleDay = cycleDayOf(economy.streak);
  const caseType = caseTypeForCycleDay(cycleDay);
  await logLedger({ type: "daily_claim", uid: user.uid, streak: economy.streak, day: today, cycleDay, caseType });

  res.status(200).json({
    ok: true,
    economy,
    reward: { cycleDay, caseType, caseName: CASES[caseType].name },
  });
});
