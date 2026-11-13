/**
 * POST /api/wallet?action=deposit
 * Body: { amount: number, method: "crypto"|"other", details: string }
 *
 * In-app deposit request — replaces the old "contact the owner on Telegram"
 * flow. The user creates a request (amount + txid/contact details), it lands
 * in `depositRequests/{uid}/{id}` as status "pending", and the owner approves
 * or rejects it via /api/admin?action=deposits. Approval credits the coins
 * atomically (no serverless function added — same wallet dispatcher).
 *
 * RTDB: depositRequests/{uid}/{id} = { id, uid, amount, method, methodLabel,
 * details, status, at, processedAt?, processedBy? }
 */
import { handle, requireUser, rtdb, HttpError, logLedger } from "../lib/firebase";

export const METHODS: Record<string, string> = {
  crypto: "Crypto (USDT / INSP)",
  other: "Other (card / manual)",
};

export const MIN_DEPOSIT = 10;
export const MAX_DEPOSIT = 100000;

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default handle(async (req, res) => {
  const user = await requireUser(req);
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST only");

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const amount = Math.floor(Number(body.amount) || 0);
  const method = String(body.method || "");
  const details = String(body.details || "").trim().slice(0, 300);

  if (!METHODS[method]) throw new HttpError(400, "INVALID_METHOD", "Choose a deposit method");
  if (amount < MIN_DEPOSIT) throw new HttpError(400, "AMOUNT_TOO_SMALL", `Minimum deposit is ${MIN_DEPOSIT} INSP`);
  if (amount > MAX_DEPOSIT) throw new HttpError(400, "AMOUNT_TOO_LARGE", `Maximum deposit is ${MAX_DEPOSIT} INSP`);
  if (details.length < 4) throw new HttpError(400, "MISSING_DETAILS", "Provide payment details (txid / contact)");

  // Do NOT touch the balance here — coins are credited only on admin approval.
  const requestRef = rtdb().ref(`depositRequests/${user.uid}`).push();
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
  await logLedger({ type: "deposit_request", uid: user.uid, amount, method });

  res.status(200).json({ ok: true, request });
});
