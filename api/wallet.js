// api/_src/lib/firebase.ts
import * as adminNamespace from "firebase-admin";
var admin = adminNamespace.default ?? adminNamespace;
var HttpError = class extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
};
var app = null;
function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: String(parsed.private_key).replace(/\\n/g, "\n")
        };
      }
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON");
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    };
  }
  return null;
}
function ensureApp() {
  if (app) return app;
  const account = getServiceAccount();
  if (!account) {
    throw new HttpError(
      500,
      "SERVER_NOT_CONFIGURED",
      "Missing FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) environment variables on the server."
    );
  }
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKey: account.privateKey
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${account.projectId}-default-rtdb.firebaseio.com`
  });
  return app;
}
async function requireUser(req) {
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, "MISSING_TOKEN", "Missing Authorization bearer token");
  ensureApp();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired token");
  }
  if (!decoded?.uid) throw new HttpError(401, "INVALID_TOKEN", "Invalid token payload");
  return { uid: decoded.uid, email: decoded.email, name: decoded.name };
}
function rtdb() {
  ensureApp();
  return admin.database();
}
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        console.error("[api] unexpected error:", err);
        res.status(500).json({ error: "INTERNAL", message: "Unexpected server error" });
      }
    }
  };
}
function assertPost(req) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST only");
}
async function decrementCounter(ref, insufficientError) {
  const before = (await ref.get()).val() || 0;
  const tx = await ref.transaction((c) => {
    const v = c || 0;
    return v >= 1 ? v - 1 : v;
  });
  const after = tx?.snapshot?.val?.() ?? 0;
  if (!tx?.committed || after >= before) {
    throw insufficientError;
  }
  return after;
}
async function logLedger(entry) {
  try {
    await rtdb().ref("ledger").push({ ...entry, at: Date.now() });
  } catch (e) {
    console.error("[api] ledger write failed", e);
  }
}

// api/_src/wallet/withdraw.ts
var MIN_WITHDRAW = 5;
var METHODS = {
  crypto: "Crypto (USDT TRC20)",
  telegram: "Telegram gift / stars",
  other: "Other (agree with owner)"
};
var withdraw_default = handle(async (req, res) => {
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
  const coinsRef = rtdb().ref(`economy/${user.uid}/coins`);
  await decrementCounter(coinsRef, new HttpError(400, "INSUFFICIENT_BALANCE", "Not enough INSP on the balance"));
  const requestRef = rtdb().ref(`withdrawals/${user.uid}`).push();
  const request = {
    id: requestRef.key,
    uid: user.uid,
    amount,
    method,
    methodLabel: METHODS[method],
    details,
    status: "pending",
    at: Date.now()
  };
  await requestRef.set(request);
  await logLedger({ type: "withdraw_request", uid: user.uid, amount, method });
  res.status(200).json({ ok: true, request });
});
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/wallet/index.ts
function safeParse2(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function getAction(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
  }
  const body = typeof req.body === "string" ? safeParse2(req.body) : req.body;
  return String(body?.action || "withdraw");
}
async function handler(req, res) {
  const action = getAction(req);
  switch (action) {
    case "withdraw":
      return withdraw_default(req, res);
    default:
      return res.status(400).json({ error: "BAD_ACTION", message: "Unknown wallet action (use ?action=withdraw)" });
  }
}
export {
  handler as default
};
