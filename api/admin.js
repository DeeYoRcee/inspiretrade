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
function firestore() {
  ensureApp();
  return admin.firestore();
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
  const db3 = rtdb();
  if (req.method === "GET") {
    const snap = await db3.ref("withdrawals").once("value");
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
  const requestRef = db3.ref(`withdrawals/${targetUid}/${id}`);
  const current = (await requestRef.once("value")).val();
  if (!current) throw new HttpError(404, "NOT_FOUND", "Withdrawal request not found");
  if (current.status !== "pending") {
    throw new HttpError(409, "ALREADY_PROCESSED", `Request is already ${current.status}`);
  }
  if (action === "rejected") {
    await db3.ref(`economy/${targetUid}`).transaction((eco) => ({
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
  const db3 = rtdb();
  if (req.method === "GET") {
    const snap = await db3.ref("depositRequests").once("value");
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
  const requestRef = db3.ref(`depositRequests/${targetUid}/${id}`);
  const current = (await requestRef.once("value")).val();
  if (!current) throw new HttpError(404, "NOT_FOUND", "Deposit request not found");
  if (current.status !== "pending") {
    throw new HttpError(409, "ALREADY_PROCESSED", `Request is already ${current.status}`);
  }
  if (action === "approve") {
    await db3.ref(`economy/${targetUid}`).transaction((eco) => ({
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
  const db3 = rtdb();
  const profileSnap = await db3.ref(`users/${admin2.uid}/profile`).once("value");
  const profile = profileSnap.val() || {};
  const oldKey = typeof profile.username === "string" ? profile.username.toLowerCase() : "";
  const changedKey = oldKey !== key;
  if (changedKey) {
    await db3.ref(`usernames/${key}`).set(admin2.uid);
  }
  await db3.ref(`users/${admin2.uid}/profile`).transaction((p) => ({
    ...p || {},
    uid: admin2.uid,
    username,
    ceo: true,
    usernames: { ...p && p.usernames || {}, [key]: { username, at: Date.now() } }
  }));
  if (changedKey && oldKey) {
    const oldSnap = await db3.ref(`publicProfiles/${oldKey}`).once("value");
    if (oldSnap.exists()) {
      await db3.ref(`publicProfiles/${key}`).set({ ...oldSnap.val(), username, usernameKey: key, ceo: true, updatedAt: Date.now() });
      await db3.ref(`publicProfiles/${oldKey}`).set({ redirect: key, updatedAt: Date.now() });
    }
  }
  await db3.ref(`publicProfiles/${key}/ceo`).set(true);
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

// shared/fragments.ts
var FRAGMENTS = [
  { id: "discipline", name: "5k$ 1", icon: "ShieldCheck", rarity: "common", dropPercent: 35 },
  { id: "patience", name: "5k$ 2", icon: "Hourglass", rarity: "common", dropPercent: 35 },
  { id: "risk-management", name: "5k$ 3", icon: "Scale", rarity: "rare", dropPercent: 8 },
  { id: "backtesting", name: "5k$ 4", icon: "FlaskConical", rarity: "rare", dropPercent: 8 },
  { id: "trading-plan", name: "5k$ 5", icon: "ClipboardList", rarity: "epic", dropPercent: 5 },
  { id: "psychology", name: "5k$ 6", icon: "Brain", rarity: "epic", dropPercent: 5 },
  { id: "consistency", name: "5k$ 7", icon: "Repeat", rarity: "covert", dropPercent: 2.9995 },
  { id: "execution", name: "5k$ 8", icon: "Crosshair", rarity: "covert", dropPercent: 2.9995 },
  { id: "master-trader", name: "5k$ 9", icon: "Crown", rarity: "mythic", dropPercent: 1e-3 }
];
var GOLD_FRAGMENTS = [
  { id: "gold-1", name: "10k$ 1", icon: "Gem", rarity: "common", dropPercent: 35 },
  { id: "gold-2", name: "10k$ 2", icon: "Zap", rarity: "common", dropPercent: 35 },
  { id: "gold-3", name: "10k$ 3", icon: "Star", rarity: "rare", dropPercent: 8 },
  { id: "gold-4", name: "10k$ 4", icon: "Target", rarity: "rare", dropPercent: 8 },
  { id: "gold-5", name: "10k$ 5", icon: "Medal", rarity: "epic", dropPercent: 5 },
  { id: "gold-6", name: "10k$ 6", icon: "Trophy", rarity: "epic", dropPercent: 5 },
  { id: "gold-7", name: "10k$ 7", icon: "Rocket", rarity: "covert", dropPercent: 2.9995 },
  { id: "gold-8", name: "10k$ 8", icon: "Diamond", rarity: "covert", dropPercent: 2.9995 },
  { id: "gold-9", name: "10k$ 9", icon: "Crown", rarity: "mythic", dropPercent: 1e-3 }
];
var CASES = {
  inspire: { id: "inspire", name: "Inspire Case", accountSize: 5e3, fragments: FRAGMENTS },
  gold: { id: "gold", name: "Gold Case", accountSize: 1e4, fragments: GOLD_FRAGMENTS }
};
var ALL_FRAGMENTS = [...FRAGMENTS, ...GOLD_FRAGMENTS];
var FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
var TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var MIN_LISTING_PRICE = 0.01;
var MAX_LISTING_PRICE = 1e6;

// api/_src/admin/username-market.ts
var USERNAME_RE2 = /^[a-zA-Z0-9_]{3,20}$/;
var username_market_default = handle(async (req, res) => {
  assertPost(req);
  const admin2 = await requireAdmin(req);
  const body = typeof req.body === "string" ? safeParse7(req.body) : req.body || {};
  const action = new URL(req.url || "/", "http://localhost").searchParams.get("action") || "";
  const db3 = rtdb();
  if (action === "usernameUnlist") {
    const listingId = String(body.listingId || "");
    const snap = await db3.ref(`market/${listingId}`).get();
    const listing2 = snap.val();
    if (!listing2 || listing2.kind !== "username") throw new HttpError(404, "NO_LISTING", "Listing not found");
    await db3.ref(`market/${listingId}`).set(null);
    await logLedger({ type: "username_unlist", listingId, usernameKey: listing2.usernameKey, by: admin2.email || admin2.uid });
    res.status(200).json({ ok: true });
    return;
  }
  const username = String(body.username || "").trim();
  if (!USERNAME_RE2.test(username)) {
    throw new HttpError(400, "INVALID_USERNAME", "3-20 chars: letters, digits, underscore");
  }
  const key = username.toLowerCase();
  const rawPrice = Number(body.price);
  const priceCents = Math.round(rawPrice * 100);
  const price = priceCents / 100;
  if (!Number.isFinite(rawPrice) || Math.abs(rawPrice - price) > 1e-9 || price < MIN_LISTING_PRICE || price > MAX_LISTING_PRICE) {
    throw new HttpError(400, "BAD_PRICE", `Price must be between ${MIN_LISTING_PRICE} and ${MAX_LISTING_PRICE} INSP (up to 2 decimals)`);
  }
  const ownerUid = (await db3.ref(`usernames/${key}`).get()).val() || null;
  if (ownerUid && ownerUid !== admin2.uid) {
    throw new HttpError(409, "USERNAME_TAKEN", "That username belongs to another user");
  }
  if (ownerUid === admin2.uid) {
    const profile = (await db3.ref(`users/${admin2.uid}/profile`).get()).val() || {};
    if (String(profile.username || "").toLowerCase() === key) {
      throw new HttpError(409, "PRIMARY_HANDLE", "Switch to another username first \u2014 the primary handle can't be sold from under the profile");
    }
  }
  const all = (await db3.ref("market").get()).val() || {};
  for (const [id, l] of Object.entries(all)) {
    if (l && l.kind === "username" && l.usernameKey === key) await db3.ref(`market/${id}`).set(null);
  }
  const listingRef = db3.ref("market").push();
  const listing = {
    id: listingRef.key,
    kind: "username",
    username,
    usernameKey: key,
    sellerUid: admin2.uid,
    sellerName: "InspireTrade",
    itemName: `@${username}`,
    fragmentId: "",
    price,
    status: "active",
    listedAt: Date.now()
  };
  await listingRef.set(listing);
  await logLedger({ type: "username_list", listingId: listingRef.key, usernameKey: key, price, by: admin2.email || admin2.uid });
  res.status(200).json({ ok: true, listing });
});
function safeParse7(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// api/_src/admin/cases.ts
var CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
function safeParse8(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function getBody(req) {
  const body = typeof req.body === "string" ? safeParse8(req.body) : req.body;
  return body || {};
}
function getAction(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
  }
  return String(getBody(req)?.action || "");
}
function slugifyCaseId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug.length >= 3 ? slug : `case-${Math.random().toString(36).slice(2, 7)}`;
}
async function caseCounterRef(db3, uid, caseId) {
  if (caseId === "inspire") return { ref: db3.ref(`economy/${uid}/cases`), name: CASES.inspire.name };
  if (caseId === "gold") return { ref: db3.ref(`economy/${uid}/goldCases`), name: CASES.gold.name };
  if (!CASE_ID_RE.test(caseId)) throw new HttpError(400, "BAD_CASE", "Unknown case id");
  const def = (await db3.ref(`economyConfig/cases/${caseId}`).get()).val();
  if (!def) throw new HttpError(404, "CASE_NOT_FOUND", `Case "${caseId}" does not exist`);
  return { ref: db3.ref(`economy/${uid}/customCases/${caseId}`), name: String(def.name || caseId) };
}
var cases_default = handle(async (req, res) => {
  assertPost(req);
  const admin2 = await requireAdmin(req);
  const db3 = rtdb();
  const action = getAction(req);
  const body = getBody(req);
  const now = Date.now();
  if (action === "caseCreate") {
    const name = String(body.name || "").trim().slice(0, 40);
    if (name.length < 2) throw new HttpError(400, "BAD_NAME", "Case name must be 2-40 characters");
    const caseId = slugifyCaseId(String(body.caseId || name));
    if (!CASE_ID_RE.test(caseId)) throw new HttpError(400, "BAD_CASE_ID", "Case id must be 3-24 chars of a-z 0-9 -");
    if ((await db3.ref(`economyConfig/cases/${caseId}`).get()).exists()) {
      throw new HttpError(409, "CASE_EXISTS", `A case with id "${caseId}" already exists`);
    }
    const rows = Array.isArray(body.fragments) ? body.fragments : [];
    if (rows.length < 1 || rows.length > 12) {
      throw new HttpError(400, "BAD_POOL", "Pick between 1 and 12 fragments for the pool");
    }
    const seen = /* @__PURE__ */ new Set();
    const fragments = [];
    let total = 0;
    for (const row of rows) {
      const id = String(row?.id || "");
      if (!ALL_FRAGMENTS.some((f) => f.id === id) || seen.has(id)) continue;
      const weight = Math.round(Number(row?.weight) * 1e4) / 1e4;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1e3) {
        throw new HttpError(400, "BAD_WEIGHT", "Weights must be > 0 and <= 1000");
      }
      seen.add(id);
      fragments.push({ id, weight });
      total += weight;
    }
    if (fragments.length < 1 || total <= 0 || total > 1e3) {
      throw new HttpError(400, "BAD_POOL", "The pool needs at least one fragment (total weight <= 1000)");
    }
    const def = { name, fragments, createdBy: admin2.uid, createdAt: now };
    await db3.ref(`economyConfig/cases/${caseId}`).set(def);
    await logLedger({ type: "case_create", uid: admin2.uid, caseId, name, fragments });
    res.status(200).json({ ok: true, caseId, def });
    return;
  }
  if (action === "caseDelete") {
    const caseId = String(body.caseId || "");
    if (caseId === "inspire" || caseId === "gold") {
      throw new HttpError(400, "BUILTIN_CASE", "The Inspire and Gold cases cannot be deleted");
    }
    if (!CASE_ID_RE.test(caseId)) throw new HttpError(400, "BAD_CASE", "Unknown case id");
    if (!(await db3.ref(`economyConfig/cases/${caseId}`).get()).exists()) {
      throw new HttpError(404, "CASE_NOT_FOUND", `Case "${caseId}" does not exist`);
    }
    await db3.ref(`economyConfig/cases/${caseId}`).remove();
    await logLedger({ type: "case_delete", uid: admin2.uid, caseId });
    res.status(200).json({ ok: true });
    return;
  }
  if (action === "caseGrant") {
    const caseId = String(body.caseId || "");
    const count = Math.floor(Number(body.count) || 0);
    if (count <= 0 || count > 1e3) throw new HttpError(400, "INVALID_AMOUNT", "count must be 1..1000");
    let targetUid = String(body.uid || "").trim();
    if (!targetUid) {
      const username = String(body.username || "").trim().toLowerCase().replace("@", "");
      if (!username) throw new HttpError(400, "MISSING_TARGET", "Provide uid or username");
      const resolved = (await db3.ref(`usernames/${username}`).get()).val();
      if (typeof resolved !== "string" || !resolved) {
        throw new HttpError(404, "USER_NOT_FOUND", `No user with username "${username}"`);
      }
      targetUid = resolved;
    }
    const counter = await caseCounterRef(db3, targetUid, caseId);
    await counter.ref.transaction((c) => (c || 0) + count);
    await logLedger({ type: "case_grant", uid: admin2.uid, targetUid, caseId, count });
    res.status(200).json({ ok: true, caseName: counter.name });
    return;
  }
  throw new HttpError(400, "BAD_ACTION", "Unknown case action (use caseCreate|caseDelete|caseGrant)");
});

// api/_src/admin/platform.ts
import * as adminNamespace2 from "firebase-admin";

// shared/roles.ts
var ROLE_RANK = {
  analyst: 1,
  moderator: 2,
  admin: 3,
  super_admin: 4
};
var ADMIN_ROLES = ["analyst", "moderator", "admin", "super_admin"];
var ACTION_MIN_RANK = {
  // read-only surface — every admin role
  "users.read": 1,
  "analytics.read": 1,
  "monitor.read": 1,
  "audit.read": 1,
  "alerts.read": 1,
  "trades.read": 1,
  "settings.read": 1,
  "roles.read": 1,
  // moderator-level — account freezes + notes
  "account.suspend": 2,
  "user.note": 2,
  "alerts.manage": 2,
  // admin-level — mutations, assignments, destructive resets
  "user.suspend": 3,
  "account.assign": 3,
  "account.create": 3,
  "account.reset": 3,
  "challenge.write": 3,
  "leaderboard.toggle": 3,
  "settings.write": 3,
  // super-admin only — role management
  "roles.write": 4
};
function roleAtLeast(role, minRank) {
  if (!role) return false;
  return (ROLE_RANK[role] || 0) >= minRank;
}
function can(role, action) {
  const min = ACTION_MIN_RANK[action];
  return roleAtLeast(role, min === void 0 ? 99 : min);
}
function maskEmail(email) {
  const e = String(email || "");
  if (!e || !e.includes("@")) return "hidden";
  const [local, domain] = e.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, Math.min(8, local.length - 1)))}@${domain}`;
}
var PLATFORM_SETTINGS_DEFAULTS = {
  maintenanceMode: false,
  registrationOpen: true,
  symbolsMode: "all",
  customSymbols: [],
  defaultAccountBalance: 1e4,
  defaultChallenge: {
    profitTargetPct: 10,
    dailyLossLimitPct: 5,
    maxDrawdownPct: 10,
    minTradingDays: 3,
    maxTradingDays: 30,
    maxOpenPositions: 10
  },
  allowedLeverages: [10, 20, 30, 50, 100, 200, 500],
  defaultLeverage: 100,
  maxLotPerOrder: null,
  commissionPerLotUsd: 0,
  spreadMultiplier: 1,
  updatedAt: null,
  updatedBy: null
};
var num = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
var optNum = (v, lo, hi) => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};
var KNOWN_LEVERAGES = [10, 20, 30, 50, 100, 200, 500];
function sanitizePlatformSettings(raw, current) {
  const base = current || PLATFORM_SETTINGS_DEFAULTS;
  const allowed = Array.isArray(raw?.allowedLeverages) ? KNOWN_LEVERAGES.filter((l) => raw.allowedLeverages.includes(l)) : base.allowedLeverages;
  const custom = Array.isArray(raw?.customSymbols) ? Array.from(new Set(raw.customSymbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))).slice(0, 60) : base.customSymbols;
  const dc = raw?.defaultChallenge || {};
  return {
    maintenanceMode: raw?.maintenanceMode === void 0 ? base.maintenanceMode : !!raw.maintenanceMode,
    registrationOpen: raw?.registrationOpen === void 0 ? base.registrationOpen : !!raw.registrationOpen,
    symbolsMode: raw?.symbolsMode === "custom" ? "custom" : raw?.symbolsMode === "all" ? "all" : base.symbolsMode,
    customSymbols: custom,
    defaultAccountBalance: num(raw?.defaultAccountBalance, 1e3, 1e6, base.defaultAccountBalance),
    defaultChallenge: {
      profitTargetPct: dc.profitTargetPct === void 0 ? base.defaultChallenge.profitTargetPct : optNum(dc.profitTargetPct, 0.5, 100),
      dailyLossLimitPct: dc.dailyLossLimitPct === void 0 ? base.defaultChallenge.dailyLossLimitPct : optNum(dc.dailyLossLimitPct, 0.5, 50),
      maxDrawdownPct: dc.maxDrawdownPct === void 0 ? base.defaultChallenge.maxDrawdownPct : optNum(dc.maxDrawdownPct, 0.5, 50),
      minTradingDays: num(dc.minTradingDays, 0, 60, base.defaultChallenge.minTradingDays),
      maxTradingDays: dc.maxTradingDays === void 0 ? base.defaultChallenge.maxTradingDays : optNum(dc.maxTradingDays, 0, 365),
      maxOpenPositions: dc.maxOpenPositions === void 0 ? base.defaultChallenge.maxOpenPositions : optNum(dc.maxOpenPositions, 1, 30)
    },
    allowedLeverages: allowed.length ? allowed : base.allowedLeverages,
    defaultLeverage: allowed.includes(Number(raw?.defaultLeverage)) ? Number(raw.defaultLeverage) : allowed.includes(base.defaultLeverage) ? base.defaultLeverage : base.defaultLeverage,
    maxLotPerOrder: raw?.maxLotPerOrder === void 0 ? base.maxLotPerOrder : optNum(raw.maxLotPerOrder, 0.01, 100),
    commissionPerLotUsd: num(raw?.commissionPerLotUsd, 0, 100, base.commissionPerLotUsd),
    spreadMultiplier: num(raw?.spreadMultiplier, 0.5, 5, base.spreadMultiplier),
    updatedAt: Date.now(),
    updatedBy: null
  };
}
function bucketByDay(timestamps, days, now = Date.now()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = start.getTime() - i * 864e5;
    buckets.push({
      day: new Date(from).toISOString().slice(5, 10),
      count: 0,
      from
    });
  }
  for (const ts of timestamps) {
    const t = Number(ts);
    if (!Number.isFinite(t)) continue;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const until = i + 1 < buckets.length ? buckets[i + 1].from : b.from + 864e5;
      if (t >= b.from && t < until) {
        b.count += 1;
        break;
      }
    }
  }
  return buckets.map(({ day, count }) => ({ day, count }));
}

// api/_src/lib/platform.ts
async function getAdminRole(user) {
  try {
    const role = (await rtdb().ref(`adminRoles/${user.uid}`).once("value")).val();
    if (typeof role === "string" && ADMIN_ROLES.includes(role)) return role;
  } catch {
  }
  const email = String(user.email || "").toLowerCase();
  const emails = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (emails.includes(email)) return emails.indexOf(email) === 0 ? "super_admin" : "admin";
  return null;
}
async function writeAdminAlert(alert, throttleKey, cooldownMs = 10 * 6e4) {
  try {
    if (throttleKey) {
      const stateRef = rtdb().ref(`adminAlertsState/${throttleKey.replace(/[.#$/[\]]/g, "_")}`);
      const last = (await stateRef.once("value")).val();
      if (typeof last === "number" && Date.now() - last < cooldownMs) return false;
      await stateRef.set(Date.now());
    }
    await rtdb().ref("adminAlerts").push({ ...alert, at: Date.now(), read: false });
    return true;
  } catch (e) {
    console.error("[api] admin alert write failed", e);
    return false;
  }
}
var cache = null;
var CACHE_MS = 6e4;
async function getPlatformSettings(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.settings;
  let settings = PLATFORM_SETTINGS_DEFAULTS;
  try {
    const snap = await firestore().collection("platformSettings").doc("global").get();
    if (snap.exists) {
      const raw = snap.data() || {};
      settings = sanitizePlatformSettings({ ...PLATFORM_SETTINGS_DEFAULTS, ...raw });
    }
  } catch (e) {
    console.error("[api] platform settings read failed \u2014 using defaults", e);
  }
  cache = { at: Date.now(), settings };
  return settings;
}
function invalidateSettingsCache() {
  cache = null;
}

// api/_src/admin/platform-guard.ts
function assertRole(role, action) {
  if (!role || !can(role, action)) {
    throw new HttpError(403, "FORBIDDEN", `Action "${action}" requires elevated admin permissions`);
  }
}

// shared/terminal.ts
var INSTRUMENTS = [
  // ---- Metals -------------------------------------------------------------
  // Gold now streams REAL-TIME from Binance: PAXG/USDT (each token = 1 troy oz
  // of London-vault gold; trades 24/7 within ~0.3% of XAU spot). Yahoo's GC=F
  // futures are kept only as provenance — every consumer routes by `feed`,
  // so chart, watchlist and the server engine all share this one live source.
  { symbol: "XAUUSD", name: "Gold / USD", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "binance", binance: "PAXGUSDT", yahoo: "GC=F", feedLabel: "Binance \xB7 PAXG/USDT (tokenized gold)" },
  { symbol: "XAGUSD", name: "Silver / USD", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5e3, quote: "USD", feed: "quotes", yahoo: "SI=F" },
  // ---- Forex majors -------------------------------------------------------
  // Euro streams REAL-TIME from Binance: EUR/USDT tracks the EURUSD spot rate
  // (USDT ≈ USD; basis typically <0.1%). Replaces Yahoo's delayed FX candles.
  { symbol: "EURUSD", name: "Euro / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "binance", binance: "EURUSDT", yahoo: "EURUSD=X", feedLabel: "Binance \xB7 EUR/USDT" },
  { symbol: "GBPUSD", name: "British Pound / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X" },
  { symbol: "USDJPY", name: "US Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 1e5, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X" },
  { symbol: "AUDUSD", name: "Australian Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X" },
  { symbol: "USDCAD", name: "US Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X" },
  { symbol: "USDCHF", name: "US Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X" },
  // ---- Crypto (live via Binance public API, no key) -----------------------
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT" },
  { symbol: "ETHUSD", name: "Ethereum / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT" },
  { symbol: "XRPUSD", name: "XRP / USD", assetClass: "crypto", digits: 4, pipSize: 1e-4, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT" },
  // ---- Indices (CFD reference levels, quotes proxy) -----------------------
  { symbol: "NAS100", name: "US Tech 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX" },
  { symbol: "US30", name: "Wall Street 30", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI" },
  { symbol: "SPX500", name: "US 500", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC" },
  { symbol: "GER40", name: "Germany 40", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI" },
  { symbol: "UK100", name: "UK 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE" }
];
function getInstrument(symbol) {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}

// shared/trading-engine.ts
var SPREAD_PIPS = {
  XAUUSD: 2.5,
  XAGUSD: 3,
  EURUSD: 0.8,
  GBPUSD: 1,
  USDJPY: 1,
  AUDUSD: 1.2,
  NZDUSD: 1.5,
  USDCAD: 1.5,
  USDCHF: 1.5,
  BTCUSD: 12,
  ETHUSD: 2,
  SOLUSD: 0.5,
  XRPUSD: 0.3,
  NAS100: 1.5,
  US30: 2.5,
  SPX500: 0.5,
  GER40: 1.5,
  UK100: 1.5
};
var DEFAULT_LEVERAGE = 100;
function quoteFromMid(mid, spec, source, live, time = Date.now()) {
  const spread = (SPREAD_PIPS[spec.symbol] ?? 2) * spec.pipSize;
  return { mid, bid: mid - spread / 2, ask: mid + spread / 2, time, source, live };
}
function convQuoteToUsd(quoteCcy, prices) {
  if (!quoteCcy || quoteCcy === "USD") return 1;
  const px = (sym) => prices[sym] || 0;
  switch (quoteCcy) {
    case "JPY":
      return px("USDJPY") ? 1 / px("USDJPY") : 0;
    case "CHF":
      return px("USDCHF") ? 1 / px("USDCHF") : 0;
    case "CAD":
      return px("USDCAD") ? 1 / px("USDCAD") : 0;
    case "EUR":
      return px("EURUSD");
    case "GBP":
      return px("GBPUSD");
    default:
      return 0;
  }
}
function positionPnlUsd(spec, side, lots, entry, exit, prices) {
  const diff = side === "buy" ? exit - entry : entry - exit;
  const conv = convQuoteToUsd(spec.quote, prices);
  const v = diff * lots * spec.contractSize * conv;
  return Math.round(v * 100) / 100;
}
function marginUsdFor(spec, lots, price, prices, leverage = DEFAULT_LEVERAGE) {
  const size = lots * spec.contractSize;
  const notionalUsd = spec.assetClass === "forex" && spec.symbol.startsWith("USD") ? size : size * price * convQuoteToUsd(spec.quote, prices);
  const v = notionalUsd / Math.max(1, leverage);
  return Math.round(v * 100) / 100;
}
function exitPriceFor(side, q) {
  return side === "buy" ? q.bid : q.ask;
}
function floatingPnlUsd(pos, q, prices) {
  const spec = getInstrument(pos.symbol);
  if (!spec) return 0;
  return positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exitPriceFor(pos.side, q), prices);
}
function computeMetrics(balance, positions, quotes, prices, leverage = DEFAULT_LEVERAGE) {
  let floating = 0;
  let used = 0;
  let openCount = 0;
  for (const p of positions) {
    const q = quotes[p.symbol];
    const spec = getInstrument(p.symbol);
    if (!spec || !q) continue;
    openCount++;
    floating += floatingPnlUsd(p, q, prices);
    used += marginUsdFor(spec, p.lots, q.mid, prices, leverage);
  }
  const equity = balance + floating;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    balance: r2(balance),
    floatingPnl: r2(floating),
    equity: r2(equity),
    usedMargin: r2(used),
    freeMargin: r2(equity - used),
    marginLevel: used > 0 ? r2(equity / used * 100) : null,
    openCount
  };
}
function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

// api/_src/trading/prices.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var BINANCE_HOSTS = ["api.binance.com", "data-api.binance.vision"];
var CRYPTO_TTL = 3e3;
var SPOT_TTL = 5e3;
var YAHOO_TTL = 45e3;
var cache2 = /* @__PURE__ */ new Map();
async function fetchJson(url, timeoutMs = 6e3, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function fetchCryptoMids(binanceSyms) {
  let lastErr;
  for (let i = 0; i < BINANCE_HOSTS.length; i++) {
    try {
      const host = BINANCE_HOSTS[i];
      const q = encodeURIComponent(JSON.stringify(binanceSyms));
      const arr = await fetchJson(`https://${host}/api/v3/ticker/price?symbols=${q}`);
      const out = {};
      for (const row of arr) if (Number.isFinite(+row.price)) out[row.symbol] = +row.price;
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("binance unreachable");
}
var GOLD_CODES = { XAGUSD: "XAG" };
async function fetchSpot(code) {
  const res = await fetchJson(`https://api.gold-api.com/price/${code}`);
  const price = Number(res?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
  return price;
}
async function fetchYahooMid(yahooSym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`;
  const json = await fetchJson(url, 8e3, { "User-Agent": UA });
  const meta = json?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_YAHOO");
  return price;
}
async function getMids(symbols) {
  const out = {};
  const now = Date.now();
  const want = [];
  for (const s of symbols) {
    const cached = cache2.get(s);
    if (cached && now - cached.time < (cached.live ? Math.min(CRYPTO_TTL, SPOT_TTL) : YAHOO_TTL)) out[s] = cached;
    else want.push(s);
  }
  if (want.length) {
    const crypto = want.filter((s) => getInstrument(s)?.feed === "binance");
    const spot = want.filter((s) => GOLD_CODES[s]);
    const yahoo = want.filter((s) => {
      const inst = getInstrument(s);
      return inst && inst.feed !== "binance" && !GOLD_CODES[s];
    });
    await Promise.all([
      (async () => {
        if (!crypto.length) return;
        const binanceSyms = crypto.map((s) => getInstrument(s).binance);
        const byBinance = await fetchCryptoMids(binanceSyms);
        for (const s of crypto) {
          const p = byBinance[getInstrument(s).binance];
          if (Number.isFinite(p)) {
            out[s] = { mid: p, source: "binance", live: true, time: Date.now() };
            cache2.set(s, out[s]);
          }
        }
      })(),
      (async () => {
        for (const s of spot) {
          try {
            const p = await fetchSpot(GOLD_CODES[s]);
            out[s] = { mid: p, source: "gold-api", live: true, time: Date.now() };
            cache2.set(s, out[s]);
          } catch {
          }
        }
      })(),
      (async () => {
        for (const s of yahoo) {
          const inst = getInstrument(s);
          if (!inst?.yahoo) continue;
          try {
            const p = await fetchYahooMid(inst.yahoo);
            out[s] = { mid: p, source: "yahoo", live: false, time: Date.now() };
            cache2.set(s, out[s]);
          } catch {
          }
        }
      })()
    ]);
  }
  return out;
}
function withConversionSymbols(symbols) {
  const set = new Set(symbols);
  for (const s of symbols) {
    const inst = getInstrument(s);
    if (!inst || inst.quote === "USD") continue;
    if (inst.quote === "EUR") set.add("EURUSD");
    else if (inst.quote === "GBP") set.add("GBPUSD");
    else if (inst.quote === "JPY") set.add("USDJPY");
    else if (inst.quote === "CHF") set.add("USDCHF");
    else if (inst.quote === "CAD") set.add("USDCAD");
  }
  return [...set];
}
async function getQuotes(symbols) {
  const mids = await getMids(withConversionSymbols(symbols));
  const settings = await getPlatformSettings();
  const mult = settings.spreadMultiplier || 1;
  const out = {};
  for (const [sym, info] of Object.entries(mids)) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    const q = quoteFromMid(info.mid, inst, info.source, info.live, info.time);
    if (mult !== 1) {
      const spread = (q.ask - q.bid) * mult;
      q.bid = q.mid - spread / 2;
      q.ask = q.mid + spread / 2;
    }
    out[sym] = q;
  }
  return out;
}
var ALL_SYMBOLS = INSTRUMENTS.map((i) => i.symbol);

// api/_src/trading/store.ts
var MAX_ACCOUNTS = 10;
var ALLOWED_LEVERAGES = [10, 20, 30, 50, 100, 200, 500];
var db = () => firestore();
var accountsCol = (uid) => db().collection("users").doc(uid).collection("accounts");
function sanitizeRules(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pct = (v, lo, hi) => {
    const n = Number(v);
    if (v == null || v === "" || !Number.isFinite(n)) return null;
    return Math.min(hi, Math.max(lo, n));
  };
  const rules = {
    dailyLossLimitPct: pct(raw.dailyLossLimitPct, 1, 50),
    maxDrawdownPct: pct(raw.maxDrawdownPct, 1, 50),
    profitTargetPct: pct(raw.profitTargetPct, 1, 100),
    minTradingDays: Math.min(60, Math.max(0, Math.floor(Number(raw.minTradingDays) || 0))),
    maxLotsTotal: pct(raw.maxLotsTotal, 0.01, 100),
    maxLotsPerOrder: pct(raw.maxLotsPerOrder, 0.01, 100),
    maxOpenPositions: raw.maxOpenPositions == null ? null : Math.min(30, Math.max(1, Math.floor(Number(raw.maxOpenPositions) || 1))),
    maxTradingDays: pct(raw.maxTradingDays, 0, 365)
  };
  const hasAny = rules.dailyLossLimitPct != null || rules.maxDrawdownPct != null || rules.profitTargetPct != null || rules.minTradingDays > 0 || rules.maxLotsTotal != null || rules.maxLotsPerOrder != null || rules.maxOpenPositions != null || rules.maxTradingDays != null;
  return hasAny ? rules : null;
}
async function createAccount(uid, label, startingBalance, opts = {}) {
  const existing = await accountsCol(uid).get();
  if (existing.size >= MAX_ACCOUNTS) throw new HttpError(409, "TOO_MANY_ACCOUNTS", `Maximum ${MAX_ACCOUNTS} accounts`);
  const settings = await getPlatformSettings();
  const balance = Math.round(Math.min(5e6, Math.max(1e3, Number(startingBalance) || settings.defaultAccountBalance)) * 100) / 100;
  const rules = sanitizeRules(opts.rules);
  const leverageRaw = Number(opts.leverage) || settings.defaultLeverage;
  const allowed = settings.allowedLeverages?.length ? settings.allowedLeverages : ALLOWED_LEVERAGES;
  const leverage = allowed.includes(leverageRaw) ? leverageRaw : allowed.includes(settings.defaultLeverage) ? settings.defaultLeverage : DEFAULT_LEVERAGE;
  const today = dayKey();
  const doc = {
    label: String(label || (rules ? "CHALLENGE" : "DEMO")).slice(0, 32) || "DEMO",
    type: rules ? "CHALLENGE" : "DEMO",
    challengeTypeId: opts.challengeTypeId ?? null,
    challengeName: String(opts.challengeName || "").slice(0, 60) || null,
    balance,
    startingBalance: balance,
    leverage,
    status: "active",
    rules,
    failedReason: null,
    adminSuspended: false,
    startedAt: Date.now(),
    peakEquity: balance,
    tradingDays: {},
    stats: { totalTrades: 0, wins: 0, losses: 0 },
    createdAt: Date.now(),
    dayStart: { [today]: balance }
  };
  const ref = await accountsCol(uid).add(doc);
  return { id: ref.id, ...doc, metrics: computeMetrics(balance, [], {}, {}, leverage), positions: [], orders: [] };
}

// api/_src/admin/platform.ts
var adminPkg = adminNamespace2.default ?? adminNamespace2;
var MAX_LIST_USERS = 1e3;
function db2() {
  return firestore();
}
function adminAuth() {
  return adminPkg.auth();
}
async function traderNames() {
  try {
    const snap = await rtdb().ref("usernames").once("value");
    const map = snap.val() || {};
    const out = {};
    for (const [name, uid] of Object.entries(map)) if (typeof uid === "string") out[uid] = name;
    return out;
  } catch {
    return {};
  }
}
async function audit(admin2, action, details = {}) {
  try {
    await db2().collection("propAudit").add({
      at: Date.now(),
      by: admin2.email || admin2.uid,
      byUid: admin2.uid,
      action,
      ...details
    });
  } catch (e) {
    console.error("[admin] audit write failed", e);
  }
}
async function fetchAuthUsers() {
  const out = [];
  let pageToken;
  for (let page = 0; page < 3 && out.length < MAX_LIST_USERS; page++) {
    const res = await adminAuth().listUsers(1e3, pageToken);
    out.push(...res.users);
    pageToken = res.pageToken;
    if (!pageToken) break;
  }
  return out;
}
async function flagNewUsers(users) {
  try {
    const knownRef = rtdb().ref("adminState/knownUsers");
    const known = (await knownRef.once("value")).val() || {};
    const fresh = users.filter((u) => !known[u.uid]);
    for (const u of fresh.slice(0, 10)) {
      await writeAdminAlert({
        type: "new_user",
        severity: "info",
        text: `New registration: ${u.email || u.uid}`,
        uid: u.uid,
        details: { email: u.email || null }
      });
    }
    if (fresh.length) {
      const patch = {};
      for (const u of fresh) patch[u.uid] = true;
      await knownRef.update(patch);
    }
  } catch (e) {
    console.error("[admin] registration diff failed", e);
  }
}
async function listUsers(admin2, role, body) {
  assertRole(role, "users.read");
  const q = String(body?.q || body?.query || "").trim().toLowerCase();
  const status = String(body?.status || "all");
  const [users, names, rolesSnap, restrictedSnap, ecoSnap] = await Promise.all([
    fetchAuthUsers(),
    traderNames(),
    rtdb().ref("adminRoles").once("value"),
    rtdb().ref("restricted").once("value"),
    rtdb().ref("economy").once("value")
  ]);
  const roles = rolesSnap.val() || {};
  const restricted = restrictedSnap.val() || {};
  const economy = ecoSnap.val() || {};
  void flagNewUsers(users);
  const rows = users.map((u) => {
    const email = String(u.email || "");
    return {
      uid: u.uid,
      email: role === "analyst" ? maskEmail(email) : email,
      displayName: names[u.uid] ? `@${names[u.uid]}` : email.split("@")[0] || u.uid.slice(0, 8),
      username: names[u.uid] || null,
      emailVerified: !!u.emailVerified,
      disabled: !!u.disabled,
      restricted: !!restricted[u.uid],
      creationTime: new Date(u.metadata?.creationTime || 0).getTime(),
      lastSignInTime: u.metadata?.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : null,
      coins: typeof economy[u.uid]?.coins === "number" ? economy[u.uid].coins : null,
      role: roles[u.uid] || null
    };
  });
  let filtered = rows;
  if (q) {
    filtered = filtered.filter(
      (r) => r.email.toLowerCase().includes(q) || r.uid.toLowerCase().includes(q) || (r.username || "").toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q)
    );
  }
  const now = Date.now();
  if (status === "suspended") filtered = filtered.filter((r) => r.disabled);
  else if (status === "active") filtered = filtered.filter((r) => !r.disabled);
  else if (status === "recent") filtered = filtered.filter((r) => now - r.creationTime < 30 * 864e5);
  filtered.sort((a, b) => b.creationTime - a.creationTime);
  return { users: filtered.slice(0, 300), total: rows.length, filtered: filtered.length };
}
async function userDetail(admin2, role, body) {
  assertRole(role, "users.read");
  const uid = String(body?.uid || "").trim();
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");
  const showFull = role !== "analyst";
  const [authRec, profileSnap, ecoSnap, accSnap, notesSnap, ledgerSnap, names] = await Promise.all([
    adminAuth().getUser(uid).catch(() => null),
    rtdb().ref(`users/${uid}/profile`).once("value"),
    rtdb().ref(`economy/${uid}`).once("value"),
    db2().collection(`users/${uid}/accounts`).get(),
    rtdb().ref(`adminNotes/${uid}`).limitToLast(50).once("value"),
    rtdb().ref("ledger").orderByChild("uid").equalTo(uid).limitToLast(40).once("value"),
    traderNames()
  ]);
  if (!authRec) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  const profile = profileSnap.val() || {};
  const eco = ecoSnap.val() || {};
  const accounts = accSnap.docs.map((d) => {
    const a = d.data() || {};
    const starting = Number(a.startingBalance) || 0;
    const balance = Number(a.balance) || 0;
    return {
      aid: d.id,
      label: a.label || "DEMO",
      type: a.type || "DEMO",
      challengeName: a.challengeName ?? null,
      balance,
      startingBalance: starting,
      profitPct: starting > 0 ? Math.round((balance - starting) / starting * 1e4) / 100 : 0,
      status: a.status || "active",
      adminSuspended: !!a.adminSuspended,
      leverage: a.leverage || 100,
      stats: a.stats || { totalTrades: 0, wins: 0, losses: 0 },
      tradingDays: Object.keys(a.tradingDays || {}).length,
      createdAt: a.createdAt || null,
      rules: a.rules || null,
      failedReason: a.failedReason ?? null
    };
  });
  const challengeAccounts = accounts.filter((a) => a.type === "CHALLENGE");
  const notes = [];
  const notesVal = notesSnap.val() || {};
  for (const [id, n] of Object.entries(notesVal)) notes.push({ id, ...n });
  notes.sort((a, b) => (b.at || 0) - (a.at || 0));
  const activity = [];
  const ledgerVal = ledgerSnap.val() || {};
  for (const [id, e] of Object.entries(ledgerVal)) activity.push({ id, ...e });
  activity.sort((a, b) => (b.at || 0) - (a.at || 0));
  const email = String(authRec.email || "");
  return {
    uid,
    email: showFull ? email : maskEmail(email),
    displayName: names[uid] ? `@${names[uid]}` : email.split("@")[0] || uid.slice(0, 8),
    username: profile.username || names[uid] || null,
    ceo: !!profile.ceo,
    emailVerified: !!authRec.emailVerified,
    disabled: !!authRec.disabled,
    restricted: !!(await rtdb().ref(`restricted/${uid}`).once("value")).val(),
    creationTime: new Date(authRec.metadata?.creationTime || 0).getTime(),
    lastSignInTime: authRec.metadata?.lastSignInTime ? new Date(authRec.metadata.lastSignInTime).getTime() : null,
    provider: (authRec.providerData || []).map((p) => p.providerId).filter(Boolean),
    economy: { coins: eco.coins ?? null, cases: eco.cases ?? null, goldCases: eco.goldCases ?? null, totalClaimed: eco.totalClaimed ?? null },
    profileBio: String(profile.bio || "").slice(0, 200) || null,
    accounts,
    challengeProgress: {
      assigned: challengeAccounts.length,
      passed: challengeAccounts.filter((a) => a.status === "passed").length,
      failed: challengeAccounts.filter((a) => a.status === "failed").length,
      active: challengeAccounts.filter((a) => a.status === "active").length,
      totalTrades: accounts.reduce((s, a) => s + (a.stats?.totalTrades || 0), 0),
      wins: accounts.reduce((s, a) => s + (a.stats?.wins || 0), 0)
    },
    notes,
    activity
  };
}
async function setUserState(admin2, role, body) {
  assertRole(role, "user.suspend");
  const uid = String(body?.uid || "").trim();
  const action = String(body?.action || "");
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");
  if (uid === admin2.uid) throw new HttpError(400, "SELF_ACTION", "Administrators cannot change their own access state");
  if (action === "suspend" || action === "reactivate") {
    const disabled = action === "suspend";
    await adminAuth().updateUser(uid, { disabled });
    await rtdb().ref(`restricted/${uid}`).set(disabled);
    await writeAdminAlert({
      type: "user_state",
      severity: disabled ? "warning" : "info",
      text: `User ${disabled ? "suspended" : "reactivated"} (${uid.slice(0, 8)}\u2026) by ${admin2.email || admin2.uid}`,
      uid
    });
    await audit(admin2, `user_${action}`, { uid });
    return { ok: true, disabled, restricted: disabled };
  }
  if (action === "restrict" || action === "unrestrict") {
    const restricted = action === "restrict";
    await rtdb().ref(`restricted/${uid}`).set(restricted);
    await writeAdminAlert({
      type: "user_state",
      severity: restricted ? "warning" : "info",
      text: `Trading ${restricted ? "restricted" : "unrestricted"} for ${uid.slice(0, 8)}\u2026 by ${admin2.email || admin2.uid}`,
      uid
    });
    await audit(admin2, `user_${action}`, { uid });
    return { ok: true, restricted };
  }
  throw new HttpError(400, "BAD_ACTION", "action must be suspend | reactivate | restrict | unrestrict");
}
async function addNote(admin2, role, body) {
  assertRole(role, "user.note");
  const uid = String(body?.uid || "").trim();
  const text = String(body?.text || "").trim().slice(0, 500);
  if (!uid || !text) throw new HttpError(400, "BAD_INPUT", "uid and text are required");
  const ref = await rtdb().ref(`adminNotes/${uid}`).push({ at: Date.now(), by: admin2.email || admin2.uid, text });
  await audit(admin2, "user_note", { uid });
  return { ok: true, id: ref.key, text };
}
async function createAccount2(admin2, role, body) {
  assertRole(role, "account.create");
  const uid = String(body?.uid || "").trim();
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");
  const settings = await getPlatformSettings();
  const balance = Math.max(1e3, Math.min(1e6, Math.floor(Number(body?.startingBalance) || settings.defaultAccountBalance)));
  const account = await createAccount(uid, String(body?.label || "DEMO").slice(0, 32), balance, {
    leverage: Number(body?.leverage) || settings.defaultLeverage,
    rules: null
  });
  await writeAdminAlert({
    type: "account_state",
    severity: "info",
    text: `DEMO account ${account.id.slice(0, 8)}\u2026 (${balance} USD) created for ${uid.slice(0, 8)}\u2026`,
    uid
  });
  await audit(admin2, "account_create", { uid, aid: account.id, balance });
  return { uid, account };
}
async function analytics(admin2, role) {
  assertRole(role, "analytics.read");
  const now = Date.now();
  const d30 = 30 * 864e5;
  const users = await fetchAuthUsers();
  void flagNewUsers(users);
  const creationTimes = users.map((u) => new Date(u.metadata?.creationTime || 0).getTime());
  const lastSignIns = users.map((u) => u.metadata?.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : 0);
  const accSnap = await db2().collectionGroup("accounts").limit(500).get();
  const accounts = accSnap.docs.map((d) => d.data() || {});
  const challenges = accounts.filter((a) => a.type === "CHALLENGE");
  const tradesSnap = await db2().collectionGroup("trades").limit(3e3).get();
  const trades = tradesSnap.docs.map((d) => d.data() || {});
  const tradeTimes = trades.map((t) => Number(t.closedAt) || 0);
  const convSymbols = ["USDJPY", "USDCHF", "USDCAD", "EURUSD", "GBPUSD"];
  const convQuotes = await getQuotes(convSymbols);
  const convPrices = {};
  for (const [sym, q] of Object.entries(convQuotes)) convPrices[sym] = q.mid;
  const volume = trades.reduce((sum, t) => {
    const spec = getInstrument(String(t.symbol || ""));
    if (!spec) return sum;
    const notional = (Number(t.lots) || 0) * spec.contractSize * (Number(t.entry) || 0);
    return sum + notional * (convQuoteToUsd(spec.quote, convPrices) || 1);
  }, 0);
  const posSnap = await db2().collectionGroup("positions").limit(1e3).get();
  return {
    users: {
      total: users.length,
      new30d: creationTimes.filter((t) => now - t < d30).length,
      active30d: lastSignIns.filter((t) => t && now - t < d30).length,
      suspended: users.filter((u) => u.disabled).length,
      registrationsByDay: bucketByDay(creationTimes.filter((t) => now - t < d30), 30, now)
    },
    accounts: {
      total: accounts.length,
      demo: accounts.filter((a) => a.type !== "CHALLENGE").length,
      challenge: challenges.length,
      challengeActive: challenges.filter((a) => a.status === "active" && !a.adminSuspended).length,
      challengePassed: challenges.filter((a) => a.status === "passed").length,
      challengeFailed: challenges.filter((a) => a.status === "failed").length,
      challengeSuspended: challenges.filter((a) => a.adminSuspended).length
    },
    trading: {
      closedTrades: trades.length,
      openPositions: posSnap.size,
      volumeUsd: Math.round(volume)
    },
    activity: { tradesByDay: bucketByDay(tradeTimes.filter((t) => t && now - t < d30), 30, now) }
  };
}
async function liveMonitor(admin2, role) {
  assertRole(role, "monitor.read");
  const accSnap = await db2().collectionGroup("accounts").limit(300).get();
  const names = await traderNames();
  const flagged = [];
  const exposure = {};
  const candidates = [];
  for (const doc of accSnap.docs) {
    const uid = doc.ref.parent.parent?.id;
    const a = doc.data() || {};
    if (!uid) continue;
    const openCount = a.metrics?.openCount || 0;
    if (openCount > 0) candidates.push({ uid, aid: doc.id, data: a });
  }
  const cap = candidates.slice(0, 50);
  const posSnaps = await Promise.all(cap.map((c) => db2().collection(`users/${c.uid}/accounts/${c.aid}/positions`).get()));
  const symbolSet = /* @__PURE__ */ new Set();
  for (const ps of posSnaps) for (const d of ps.docs) symbolSet.add(String(d.data()?.symbol || ""));
  const symbols = [...symbolSet].filter(Boolean);
  const quotes = symbols.length ? await getQuotes(symbols) : {};
  const prices = {};
  for (const [sym, q] of Object.entries(quotes)) prices[sym] = q.mid;
  const recentTrades = [];
  for (let i = 0; i < cap.length; i++) {
    const { uid, aid, data: a } = cap[i];
    const positions = posSnaps[i].docs.map((d) => {
      const p = d.data() || {};
      const spec = getInstrument(String(p.symbol || ""));
      const notional = spec ? (Number(p.lots) || 0) * spec.contractSize * (Number(p.entry) || 0) * (convQuoteToUsd(spec.quote, prices) || 1) : 0;
      return { id: d.id, symbol: p.symbol, side: p.side, lots: p.lots, entry: p.entry, sl: p.sl ?? null, tp: p.tp ?? null, openedAt: p.openedAt, notionalUsd: Math.round(notional) };
    });
    for (const p of positions) {
      const e = exposure[p.symbol] || { lots: 0, notional: 0 };
      e.lots += p.lots || 0;
      e.notional += p.notionalUsd || 0;
      exposure[p.symbol] = e;
    }
    const starting = Number(a.startingBalance) || 0;
    const balance = Number(a.balance) || 0;
    const equity = Number(a.metrics?.equity) || balance;
    const rules = a.rules || null;
    const flags = [];
    if (rules?.maxDrawdownPct && starting > 0 && (balance - starting) / starting <= -(0.6 * rules.maxDrawdownPct) / 100) flags.push("risk");
    if (positions.length >= 10) flags.push("heavy_book");
    const notionalSum = positions.reduce((s, p) => s + p.notionalUsd, 0);
    if (equity > 0 && notionalSum > 5 * equity) flags.push("high_exposure");
    if (a.adminSuspended) flags.push("suspended");
    if (a.status === "failed") flags.push("failed");
    flagged.push({
      uid,
      aid,
      traderName: names[uid] ? `@${names[uid]}` : `trader ${uid.slice(0, 6)}`,
      label: a.label || "DEMO",
      type: a.type || "DEMO",
      challengeName: a.challengeName ?? null,
      balance,
      startingBalance: starting,
      equity,
      floatingPnl: Number(a.metrics?.floatingPnl) || 0,
      status: a.status || "active",
      adminSuspended: !!a.adminSuspended,
      rules,
      flags,
      positions
    });
    const ts = await db2().collection(`users/${uid}/accounts/${aid}/trades`).orderBy("closedAt", "desc").limit(5).get();
    for (const d of ts.docs) {
      const t = d.data() || {};
      recentTrades.push({ uid, aid, traderName: names[uid] ? `@${names[uid]}` : uid.slice(0, 6), id: d.id, ...t });
    }
  }
  recentTrades.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  return {
    accounts: flagged,
    exposure: Object.entries(exposure).map(([symbol, e]) => ({ symbol, lots: Math.round(e.lots * 100) / 100, notionalUsd: Math.round(e.notional) })).sort((a, b) => b.notionalUsd - a.notionalUsd),
    recentTrades: recentTrades.slice(0, 30),
    openAccounts: candidates.length
  };
}
async function listAlerts(admin2, role) {
  assertRole(role, "alerts.read");
  const snap = await rtdb().ref("adminAlerts").orderByChild("at").limitToLast(100).once("value");
  const val = snap.val() || {};
  const alerts = Object.entries(val).map(([id, a]) => ({ id, ...a })).sort((a, b) => (b.at || 0) - (a.at || 0));
  const unread = alerts.filter((a) => !a.read).length;
  return { alerts, unread };
}
async function markAlertsRead(admin2, role, body) {
  assertRole(role, "alerts.manage");
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100) : [];
  const snap = await rtdb().ref("adminAlerts").orderByChild("read").equalTo(false).once("value").catch(() => null);
  const updates = {};
  if (ids.length) {
    for (const id of ids) updates[id] = true;
  } else if (snap) {
    const val = snap.val() || {};
    for (const id of Object.keys(val)) updates[id] = true;
  }
  if (Object.keys(updates).length) await rtdb().ref("adminAlerts").update(Object.fromEntries(Object.keys(updates).map((id) => [`${id}/read`, true])));
  return { ok: true, marked: Object.keys(updates).length };
}
async function getSettings(admin2, role) {
  assertRole(role, "settings.read");
  const snap = await db2().collection("platformSettings").doc("global").get();
  const raw = snap.exists ? snap.data() || {} : {};
  const settings = sanitizePlatformSettings({ ...raw });
  return { settings };
}
async function saveSettings(admin2, role, body) {
  assertRole(role, "settings.write");
  const snap = await db2().collection("platformSettings").doc("global").get();
  const current = snap.exists ? sanitizePlatformSettings(snap.data() || {}) : void 0;
  const next = sanitizePlatformSettings(body?.settings || body || {}, current);
  next.updatedBy = admin2.email || admin2.uid;
  await db2().collection("platformSettings").doc("global").set(next);
  invalidateSettingsCache();
  await writeAdminAlert({
    type: "settings_changed",
    severity: next.maintenanceMode ? "warning" : "info",
    text: `Platform settings updated by ${admin2.email || admin2.uid}${next.maintenanceMode ? " \u2014 MAINTENANCE MODE ON" : ""}`,
    details: { maintenance: next.maintenanceMode, symbolsMode: next.symbolsMode }
  });
  await audit(admin2, "settings_save", { maintenance: next.maintenanceMode, symbolsMode: next.symbolsMode });
  return { settings: next };
}
async function getRoles(admin2, role) {
  assertRole(role, "roles.read");
  const snap = await rtdb().ref("adminRoles").once("value");
  const val = snap.val() || {};
  const names = await traderNames();
  const users = Object.entries(val).map(([uid, r]) => ({
    uid,
    role: r,
    name: names[uid] ? `@${names[uid]}` : null
  }));
  return { roles: users, myRole: role };
}
async function setRole(admin2, role, body) {
  assertRole(role, "roles.write");
  const uid = String(body?.uid || "").trim();
  const target = String(body?.role || "");
  if (!uid || !ADMIN_ROLES.includes(target)) {
    throw new HttpError(400, "BAD_INPUT", `role must be one of ${ADMIN_ROLES.join(", ")}`);
  }
  if (uid === admin2.uid) throw new HttpError(400, "SELF_ROLE", "Administrators cannot change their own role");
  await rtdb().ref(`adminRoles/${uid}`).set(target);
  await writeAdminAlert({
    type: "roles_changed",
    severity: "warning",
    text: `Role ${target} granted to ${uid.slice(0, 8)}\u2026 by ${admin2.email || admin2.uid}`,
    uid,
    details: { role: target }
  });
  await audit(admin2, "role_set", { uid, role: target });
  return { ok: true, uid, role: target };
}

// api/_src/admin/index.ts
function safeParse9(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function getAction2(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
  }
  const body = typeof req.body === "string" ? safeParse9(req.body) : req.body;
  return String(body?.action || "");
}
var PLATFORM_ACTIONS = {
  "users-list": { GET: true, run: (_q, res, a, r, b) => listUsers(a, r, b).then((x) => res.json(x)) },
  "user-detail": { GET: true, run: (_q, res, a, r, b) => userDetail(a, r, b).then((x) => res.json(x)) },
  "analytics": { GET: true, run: (_q, res, a, r) => analytics(a, r).then((x) => res.json(x)) },
  "live-monitor": { GET: true, run: (_q, res, a, r) => liveMonitor(a, r).then((x) => res.json(x)) },
  "admin-alerts": { GET: true, run: (_q, res, a, r) => listAlerts(a, r).then((x) => res.json(x)) },
  "admin-settings-get": { GET: true, run: (_q, res, a, r) => getSettings(a, r).then((x) => res.json(x)) },
  "admin-roles-get": { GET: true, run: (_q, res, a, r) => getRoles(a, r).then((x) => res.json(x)) },
  "user-set-state": { GET: false, run: (_q, res, a, r, b) => setUserState(a, r, b).then((x) => res.json(x)) },
  "user-note": { GET: false, run: (_q, res, a, r, b) => addNote(a, r, b).then((x) => res.json(x)) },
  "admin-account-create": { GET: false, run: (_q, res, a, r, b) => createAccount2(a, r, b).then((x) => res.json(x)) },
  "admin-alerts-read": { GET: false, run: (_q, res, a, r, b) => markAlertsRead(a, r, b).then((x) => res.json(x)) },
  "admin-settings-save": { GET: false, run: (_q, res, a, r, b) => saveSettings(a, r, b).then((x) => res.json(x)) },
  "admin-roles-set": { GET: false, run: (_q, res, a, r, b) => setRole(a, r, b).then((x) => res.json(x)) }
};
async function handler(req, res) {
  const action = getAction2(req);
  const platformEntry = PLATFORM_ACTIONS[action];
  if (platformEntry) {
    try {
      const admin2 = await requireUser(req);
      const role = await getAdminRole(admin2);
      let body = {};
      if (platformEntry.GET) {
        const url = new URL(req.url || "/", "http://localhost");
        body = Object.fromEntries(url.searchParams.entries());
      } else {
        body = typeof req.body === "string" ? safeParse9(req.body) : req.body || {};
      }
      return await platformEntry.run(req, res, admin2, role, body);
    } catch (e) {
      const status = e?.status || e?.statusCode || (String(e?.message || "").includes("token") ? 401 : 500);
      return res.status(status).json({ error: e?.code || "INTERNAL", message: e?.message || "server error" });
    }
  }
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
    case "usernameList":
    case "usernameUnlist":
      return username_market_default(req, res);
    case "caseCreate":
    case "caseDelete":
    case "caseGrant":
      return cases_default(req, res);
    default:
      return res.status(400).json({ error: "BAD_ACTION", message: "Unknown admin action (use ?action=gift|withdrawals|deposits|chat-delete|chat-send|set-username|caseCreate|caseDelete|caseGrant)" });
  }
}
export {
  handler as default
};
