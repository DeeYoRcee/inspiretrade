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
async function logLedger(entry) {
  try {
    await rtdb().ref("ledger").push({ ...entry, at: Date.now() });
  } catch (e) {
    console.error("[api] ledger write failed", e);
  }
}

// api/_src/referral/index.ts
var BONUS_NEW = 0;
var REFERRAL_CASES = 0;
var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  let s = "";
  for (let i = 0; i < 7; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function bodyCode(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  return String(body?.code || url.searchParams.get("code") || "").trim().toUpperCase();
}
async function ensureCode(uid) {
  const nodeRef = rtdb().ref(`referrals/${uid}`);
  const existing = (await nodeRef.get()).val();
  if (existing?.code) return String(existing.code);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const codeVal = (await rtdb().ref(`refCodes/${code}`).get()).val();
    if (codeVal && codeVal !== uid) continue;
    const tx = await nodeRef.transaction((cur) => {
      if (cur?.code) return cur;
      return { ...cur || {}, code, createdAt: Date.now() };
    });
    const committedCode = tx?.snapshot?.val?.()?.code;
    if (!tx.committed || !committedCode) continue;
    if (codeVal !== uid) await rtdb().ref(`refCodes/${committedCode}`).set(uid);
    return String(committedCode);
  }
  throw new HttpError(500, "CODE_GEN_FAILED", "Could not create a referral code, try again");
}
var index_default = handle(async (req, res) => {
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
      bonuses: { new: BONUS_NEW, referrerCase: REFERRAL_CASES }
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
    const now = Date.now();
    const tx = await rtdb().ref(`referrals/${user.uid}`).transaction((cur) => {
      if (cur?.referredBy) return cur;
      return { ...cur || {}, referredBy: referrerUid, referredByCode: code, referredAt: now };
    });
    const after = tx?.snapshot?.val?.() || {};
    if (!tx.committed || after.referredBy !== referrerUid) {
      throw new HttpError(409, "ALREADY_REFERRED", "This account already has a referrer");
    }
    await rtdb().ref(`referrals/${referrerUid}`).transaction((cur) => ({
      ...cur || {},
      count: (cur?.count || 0) + 1,
      lastInviteAt: now
    }));
    await logLedger({
      type: "referral_apply",
      newUid: user.uid,
      referrerUid,
      code,
      bonusNew: BONUS_NEW,
      referralCases: REFERRAL_CASES
    });
    return res.status(200).json({ ok: true, bonusNew: BONUS_NEW, referralCases: REFERRAL_CASES });
  }
  throw new HttpError(400, "BAD_ACTION", "Unknown referral action (use info|apply)");
});
export {
  index_default as default
};
