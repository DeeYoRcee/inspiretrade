/**
 * POST /api/wallet/withdraw
 * Body: { amount: number, method: "crypto"|"telegram"|"other", details: string }
 * Atomically reserves INSP from the user's balance and stores a pending
 * withdrawal request. The owner processes it manually and marks it paid or
 * rejected (rejected = coins refunded) via /api/admin/withdrawals.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";

const MIN_WITHDRAW = 5; // INSP

const METHODS: Record<string, string> = {
  crypto: "Crypto (USDT TRC20)",
  telegram: "Telegram gift / stars",
  other: "Other (agree with owner)",
};

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};

  const amount = Math.floor(Number(body.amount) || 0);
  const method = String(body.method || "");
  const details = String(body.details || "").trim().slice(0, 200);
  if (!METHODS[method]) {
    throw new HttpError(400, "INVALID_METHOD", "Choose a withdrawal method");
  }
  if (amount < MIN_WITHDRAW) {
    throw new HttpError(400, "AMOUNT_TOO_SMALL", `Minimum withdrawal is ${MIN_WITHDRAW} INSP`);
  }
  if (!details) {
    throw new HttpError(400, "MISSING_DETAILS", "Provide payout details (address / contact)");
  }

  // Atomic balance check + reservation.
  const tx = await rtdb()
    .ref(`economy/${user.uid}`)
    .transaction((current: any) => {
      const eco = current || { coins: 0, cases: 0, streak: 0 };
      if ((eco.coins || 0) < amount) return undefined; // abort: insufficient
      return { ...eco, coins: (eco.coins || 0) - amount, updatedAt: Date.now() };
    });
  if (!tx.committed) {
    throw new HttpError(400, "INSUFFICIENT_BALANCE", "Not enough INSP on the balance");
  }

  const requestRef = rtdb().ref(`withdrawals/${user.uid}`).push();
  const request = {
    id: requestRef.key,
    uid: user.uid,
    amount,
    method,
    methodLabel: METHODS[method],
    details,
    status: "pending",
    at: Date.now(),
  };
  await requestRef.set(request);
  await logLedger({ type: "withdraw_request", uid: user.uid, amount, method });

  res.status(200).json({ ok: true, request });
});

export { MIN_WITHDRAW };

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
