import { createRequire as __cR } from 'module';
const require = __cR(import.meta.url);

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
async function requireAdmin(req) {
  const user = await requireUser(req);
  const emails = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  let flagged = false;
  try {
    flagged = (await rtdb().ref(`admins/${user.uid}`).once("value")).val() === true;
  } catch {
  }
  if (!emails.includes(String(user.email || "").toLowerCase()) && !flagged) {
    throw new HttpError(403, "FORBIDDEN", "Owner access required");
  }
  return user;
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
async function logLedger(entry) {
  try {
    await rtdb().ref("ledger").push({ ...entry, at: Date.now() });
  } catch (e) {
    console.error("[api] ledger write failed", e);
  }
}

// api/_src/admin/gift.ts
var gift_default = handle(async (req, res) => {
  assertPost(req);
  const admin2 = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const coins = Math.floor(Number(body.coins) || 0);
  const cases = Math.floor(Number(body.cases) || 0);
  const goldCases = Math.floor(Number(body.goldCases) || 0);
  const note = String(body.note || "").slice(0, 200);
  if (coins <= 0 && cases <= 0 && goldCases <= 0) {
    throw new HttpError(400, "INVALID_AMOUNT", "Provide a positive coins and/or cases amount");
  }
  if (coins > 1e5 || cases > 1e3 || goldCases > 1e3) {
    throw new HttpError(400, "AMOUNT_TOO_LARGE", "Gift exceeds limits (coins<=100000, cases<=1000, goldCases<=1000)");
  }
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
  const tx = await rtdb().ref(`economy/${targetUid}`).transaction((current) => {
    const eco = current || { coins: 0, cases: 0, streak: 0, totalClaimed: 0 };
    return {
      ...eco,
      coins: (eco.coins || 0) + coins,
      cases: (eco.cases || 0) + cases,
      goldCases: (eco.goldCases || 0) + goldCases,
      updatedAt: Date.now()
    };
  });
  if (!tx.committed) throw new HttpError(500, "TX_FAILED", "Could not update economy");
  await logLedger({
    type: "admin_gift",
    target: targetUid,
    coins,
    cases,
    goldCases,
    note,
    by: admin2.email || admin2.uid
  });
  res.status(200).json({ ok: true, targetUid, coins: tx.snapshot.val().coins, cases: tx.snapshot.val().cases });
});
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/withdrawals.ts
var withdrawals_default = handle(async (req, res) => {
  const admin2 = await requireAdmin(req);
  const db = rtdb();
  if (req.method === "GET") {
    const snap = await db.ref("withdrawals").once("value");
    const all = snap.val() || {};
    const list = [];
    for (const [uid, requests] of Object.entries(all)) {
      for (const [id2, request] of Object.entries(requests || {})) {
        list.push({ ...request, uid, id: id2 });
      }
    }
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return res.status(200).json({ ok: true, withdrawals: list.slice(0, 100) });
  }
  const body = typeof req.body === "string" ? safeParse2(req.body) : req.body || {};
  const targetUid = String(body.uid || "");
  const id = String(body.id || "");
  const action = String(body.action || "");
  if (!targetUid || !id || !["paid", "rejected"].includes(action)) {
    throw new HttpError(400, "INVALID_REQUEST", "Provide uid, id and action (paid|rejected)");
  }
  const requestRef = db.ref(`withdrawals/${targetUid}/${id}`);
  const current = (await requestRef.once("value")).val();
  if (!current) throw new HttpError(404, "NOT_FOUND", "Withdrawal request not found");
  if (current.status !== "pending") {
    throw new HttpError(409, "ALREADY_PROCESSED", `Request is already ${current.status}`);
  }
  if (action === "rejected") {
    await db.ref(`economy/${targetUid}`).transaction((eco) => ({
      ...eco || { coins: 0, cases: 0 },
      coins: (eco?.coins || 0) + (current.amount || 0),
      updatedAt: Date.now()
    }));
  }
  await requestRef.update({
    status: action,
    processedAt: Date.now(),
    processedBy: admin2.email || admin2.uid
  });
  await logLedger({
    type: action === "paid" ? "withdraw_paid" : "withdraw_rejected",
    target: targetUid,
    amount: current.amount,
    by: admin2.email || admin2.uid
  });
  res.status(200).json({ ok: true, status: action });
});
function safeParse2(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/deposits.ts
var deposits_default = handle(async (req, res) => {
  const admin2 = await requireAdmin(req);
  const db = rtdb();
  if (req.method === "GET") {
    const snap = await db.ref("depositRequests").once("value");
    const all = snap.val() || {};
    const list = [];
    for (const [uid, requests] of Object.entries(all)) {
      for (const [id2, request] of Object.entries(requests || {})) {
        list.push({ ...request, uid, id: id2 });
      }
    }
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return res.status(200).json({ ok: true, deposits: list.slice(0, 100) });
  }
  const body = typeof req.body === "string" ? safeParse3(req.body) : req.body || {};
  const targetUid = String(body.uid || "");
  const id = String(body.id || "");
  const action = String(body.action || "");
  if (!targetUid || !id || !["approve", "reject"].includes(action)) {
    throw new HttpError(400, "INVALID_REQUEST", "Provide uid, id and action (approve|reject)");
  }
  const requestRef = db.ref(`depositRequests/${targetUid}/${id}`);
  const current = (await requestRef.once("value")).val();
  if (!current) throw new HttpError(404, "NOT_FOUND", "Deposit request not found");
  if (current.status !== "pending") {
    throw new HttpError(409, "ALREADY_PROCESSED", `Request is already ${current.status}`);
  }
  if (action === "approve") {
    await db.ref(`economy/${targetUid}`).transaction((eco) => ({
      ...eco || { coins: 0, cases: 0 },
      coins: (eco?.coins || 0) + (current.amount || 0),
      updatedAt: Date.now()
    }));
  }
  await requestRef.update({
    status: action === "approve" ? "approved" : "rejected",
    processedAt: Date.now(),
    processedBy: admin2.email || admin2.uid
  });
  await logLedger({
    type: action === "approve" ? "deposit_approved" : "deposit_rejected",
    target: targetUid,
    amount: current.amount,
    by: admin2.email || admin2.uid
  });
  res.status(200).json({ ok: true, status: action });
});
function safeParse3(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/chat-delete.ts
var chat_delete_default = handle(async (req, res) => {
  assertPost(req);
  await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse4(req.body) : req.body || {};
  const messageId = String(body.messageId || "").trim();
  if (!messageId || !/^[A-Za-z0-9_-]{1,64}$/.test(messageId)) {
    throw new HttpError(400, "INVALID_ID", "Provide a valid messageId");
  }
  await rtdb().ref(`chat/global/${messageId}`).remove();
  res.status(200).json({ ok: true });
});
function safeParse4(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/chat-send.ts
var chat_send_default = handle(async (req, res) => {
  assertPost(req);
  const admin2 = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse5(req.body) : req.body || {};
  const text = String(body.text || "").trim().slice(0, 300);
  if (!text) throw new HttpError(400, "EMPTY_TEXT", "Provide a message text");
  await rtdb().ref(`users/${admin2.uid}/profile`).transaction((profile) => ({
    ...profile || {},
    ...profile || {},
    uid: admin2.uid,
    ceo: true
  }));
  const message = {
    uid: admin2.uid,
    name: "CEO",
    ceo: true,
    text,
    at: Date.now()
  };
  await rtdb().ref("chat/global").push(message);
  res.status(200).json({ ok: true, message });
});
function safeParse5(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/set-username.ts
var USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
var set_username_default = handle(async (req, res) => {
  assertPost(req);
  const admin2 = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse6(req.body) : req.body || {};
  const username = String(body.username || "").trim();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "INVALID_USERNAME", "3-20 chars: letters, digits, underscore");
  }
  const key = username.toLowerCase();
  const db = rtdb();
  const profileSnap = await db.ref(`users/${admin2.uid}/profile`).once("value");
  const profile = profileSnap.val() || {};
  const oldKey = typeof profile.username === "string" ? profile.username.toLowerCase() : "";
  const changedKey = oldKey !== key;
  if (changedKey) {
    await db.ref(`usernames/${key}`).set(admin2.uid);
    await db.ref(`usernames/${oldKey}`).set(null);
  }
  await db.ref(`users/${admin2.uid}/profile`).transaction((p) => ({
    ...p || {},
    uid: admin2.uid,
    username,
    ceo: true
  }));
  if (changedKey && oldKey) {
    const oldSnap = await db.ref(`publicProfiles/${oldKey}`).once("value");
    if (oldSnap.exists()) {
      await db.ref(`publicProfiles/${key}`).set({ ...oldSnap.val(), username, usernameKey: key, ceo: true, updatedAt: Date.now() });
      await db.ref(`publicProfiles/${oldKey}`).set(null);
    }
  }
  await db.ref(`publicProfiles/${key}/ceo`).set(true);
  await logLedger({ type: "owner_set_username", target: admin2.uid, username, by: admin2.email || admin2.uid });
  res.status(200).json({ ok: true, username, key });
});
function safeParse6(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/index.ts
function safeParse7(raw) {
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
  const body = typeof req.body === "string" ? safeParse7(req.body) : req.body;
  return String(body?.action || "");
}
async function handler(req, res) {
  const action = getAction(req);
  switch (action) {
    case "gift":
      return gift_default(req, res);
    case "withdrawals":
      return withdrawals_default(req, res);
    case "deposits":
      return deposits_default(req, res);
    case "chat-delete":
      return chat_delete_default(req, res);
    case "chat-send":
      return chat_send_default(req, res);
    case "set-username":
      return set_username_default(req, res);
    default:
      return res.status(400).json({ error: "BAD_ACTION", message: "Unknown admin action (use ?action=gift|withdrawals|deposits|chat-delete|chat-send|set-username)" });
  }
}
export {
  handler as default
};
