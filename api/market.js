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
var TRADING_FRAGMENTS = [
  { id: "trade-1", name: "25k$ 1", icon: "Briefcase", rarity: "common", dropPercent: 35 },
  { id: "trade-2", name: "25k$ 2", icon: "Gauge", rarity: "common", dropPercent: 35 },
  { id: "trade-3", name: "25k$ 3", icon: "LineChart", rarity: "rare", dropPercent: 8 },
  { id: "trade-4", name: "25k$ 4", icon: "PieChart", rarity: "rare", dropPercent: 8 },
  { id: "trade-5", name: "25k$ 5", icon: "Activity", rarity: "epic", dropPercent: 5 },
  { id: "trade-6", name: "25k$ 6", icon: "BarChart3", rarity: "epic", dropPercent: 5 },
  { id: "trade-7", name: "25k$ 7", icon: "Waves", rarity: "covert", dropPercent: 2.9995 },
  { id: "trade-8", name: "25k$ 8", icon: "Landmark", rarity: "covert", dropPercent: 2.9995 },
  { id: "trade-9", name: "25k$ 9", icon: "Crown", rarity: "mythic", dropPercent: 1e-3 }
];
var CASES = {
  inspire: { id: "inspire", name: "Inspire Case", accountSize: 5e3, fragments: FRAGMENTS },
  gold: { id: "gold", name: "Gold Case", accountSize: 1e4, fragments: GOLD_FRAGMENTS },
  trading: { id: "trading", name: "Trading Case", accountSize: 25e3, fragments: TRADING_FRAGMENTS }
};
var ALL_FRAGMENTS = [...FRAGMENTS, ...GOLD_FRAGMENTS, ...TRADING_FRAGMENTS];
var FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
var TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_TRADING = TRADING_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var MARKET_FEE_PERCENT = 10;
var MAX_ACTIVE_LISTINGS = 50;
var MIN_LISTING_PRICE = 0.01;
var MAX_LISTING_PRICE = 1e6;
function getFragment(id) {
  return ALL_FRAGMENTS.find((f) => f.id === id);
}

// shared/roles.ts
var ADMIN_ROLES = ["analyst", "moderator", "admin", "super_admin"];

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

// api/_src/market/list.ts
var CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
var list_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { fragmentId, caseId, price } = req.body || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const kind = body.kind === "case" ? "case" : "fragment";
  let escrowRef;
  let itemName;
  let insufficientError;
  let listingItem;
  if (kind === "case") {
    const id = String(caseId || "");
    if (id === "inspire" || id === "gold" || id === "trading") {
      escrowRef = id === "gold" ? rtdb().ref(`economy/${user.uid}/goldCases`) : id === "trading" ? rtdb().ref(`economy/${user.uid}/tradingCases`) : rtdb().ref(`economy/${user.uid}/cases`);
      itemName = CASES[id].name;
      insufficientError = new HttpError(400, "NO_CASES", "You don't own this case");
      listingItem = { kind: "case", caseId: id };
    } else {
      if (!CASE_ID_RE.test(id)) throw new HttpError(400, "BAD_CASE", "Unknown case");
      const def = (await rtdb().ref(`economyConfig/cases/${id}`).get()).val();
      if (!def) throw new HttpError(400, "BAD_CASE", "Unknown case");
      escrowRef = rtdb().ref(`economy/${user.uid}/customCases/${id}`);
      itemName = String(def.name || id);
      insufficientError = new HttpError(400, "NO_CASES", "You don't own this case");
      listingItem = { kind: "case", caseId: id };
    }
  } else {
    const fragment = getFragment(String(fragmentId || ""));
    if (!fragment) throw new HttpError(400, "BAD_FRAGMENT", "Unknown fragment");
    escrowRef = rtdb().ref(`inventory/${user.uid}/${fragment.id}/count`);
    itemName = fragment.name;
    insufficientError = new HttpError(400, "NO_FRAGMENT", "You don't own this fragment");
    listingItem = { kind: "fragment", fragmentId: fragment.id };
  }
  const rawPrice = Number(price);
  const priceCents = Math.round(rawPrice * 100);
  const normalizedPrice = priceCents / 100;
  if (!Number.isFinite(rawPrice) || Math.abs(rawPrice - normalizedPrice) > 1e-9 || normalizedPrice < MIN_LISTING_PRICE || normalizedPrice > MAX_LISTING_PRICE) {
    throw new HttpError(400, "BAD_PRICE", `Price must be between ${MIN_LISTING_PRICE} and ${MAX_LISTING_PRICE} INSP (up to 2 decimals)`);
  }
  const db = rtdb();
  const now = Date.now();
  await decrementCounter(escrowRef, insufficientError);
  const adminRole = await getAdminRole(user).catch(() => null);
  const allListings = (await db.ref("market").get()).val() || {};
  const activeMine = Object.values(allListings).filter(
    (l) => l && l.sellerUid === user.uid && l.status === "active"
  ).length;
  if (!adminRole && activeMine >= MAX_ACTIVE_LISTINGS) {
    await escrowRef.transaction((c) => (c || 0) + 1);
    throw new HttpError(400, "TOO_MANY_LISTINGS", `You can have at most ${MAX_ACTIVE_LISTINGS} active listings`);
  }
  let sellerName = "Trader";
  try {
    const snap = await db.ref(`users/${user.uid}/profile/username`).get();
    if (snap.exists() && typeof snap.val() === "string") sellerName = snap.val();
  } catch {
  }
  const listingRef = db.ref("market").push();
  const listing = {
    id: listingRef.key,
    sellerUid: user.uid,
    sellerName,
    itemName,
    ...listingItem,
    price: normalizedPrice,
    status: "active",
    listedAt: now
  };
  await listingRef.set(listing);
  await logLedger({ type: "market_list", uid: user.uid, listingId: listingRef.key, kind, caseId: listing.caseId, fragmentId: listing.fragmentId, price: normalizedPrice });
  res.status(200).json({ ok: true, listing });
});

// api/_src/market/buy.ts
var CASE_ID_RE2 = /^[a-z0-9][a-z0-9-]{2,23}$/;
var buy_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { listingId } = req.body || {};
  if (!listingId || typeof listingId !== "string") throw new HttpError(400, "BAD_LISTING", "listingId required");
  const db = rtdb();
  const now = Date.now();
  const listingRef = db.ref(`market/${listingId}`);
  const tx = await listingRef.transaction((current) => {
    if (current && current.status === "active" && current.sellerUid !== user.uid) {
      return { ...current, status: "sold", buyerUid: user.uid, soldAt: now };
    }
    return current;
  });
  const reserved = tx.snapshot.val();
  if (!tx.committed || !reserved || reserved.status !== "sold" || reserved.buyerUid !== user.uid) {
    if (reserved && reserved.sellerUid === user.uid) {
      throw new HttpError(400, "OWN_LISTING", "You can't buy your own listing");
    }
    throw new HttpError(400, "NOT_AVAILABLE", "Listing is no longer available");
  }
  const listing = reserved;
  const revertListing = async () => {
    await db.ref(`market/${listingId}`).transaction((current) => {
      if (current && current.status === "sold" && current.buyerUid === user.uid) {
        return { ...current, status: "active", buyerUid: null, soldAt: null };
      }
      return current;
    });
  };
  const coinsRef = db.ref(`economy/${user.uid}/coins`);
  const before = (await coinsRef.get()).val() || 0;
  const payTx = await coinsRef.transaction((c) => {
    const v = c || 0;
    return v >= listing.price ? v - listing.price : v;
  });
  const coinsAfter = payTx?.snapshot?.val?.() ?? 0;
  if (!payTx?.committed || coinsAfter >= before) {
    await revertListing();
    throw new HttpError(400, "INSUFFICIENT_COINS", "Not enough INSP coins");
  }
  const priceCents = Math.round(listing.price * 100);
  const feeCents = Math.round(priceCents * MARKET_FEE_PERCENT / 100);
  const sellerReceives = (priceCents - feeCents) / 100;
  const fee = feeCents / 100;
  await db.ref(`economy/${listing.sellerUid}/coins`).transaction((c) => (c || 0) + sellerReceives);
  if (listing.kind === "username") {
    await deliverUsername(db, user.uid, listing, revertListing, sellerReceives);
    res.status(200).json({ ok: true, listing: reserved, coinsLeft: coinsAfter, username: listing.username });
    return;
  }
  if (listing.kind === "case") {
    const caseId = String(listing.caseId || "");
    let deliverRef;
    if (caseId === "inspire" || caseId === "gold" || caseId === "trading") {
      deliverRef = caseId === "gold" ? db.ref(`economy/${user.uid}/goldCases`) : caseId === "trading" ? db.ref(`economy/${user.uid}/tradingCases`) : db.ref(`economy/${user.uid}/cases`);
    } else if (CASE_ID_RE2.test(caseId) && (await db.ref(`economyConfig/cases/${caseId}`).get()).exists()) {
      deliverRef = db.ref(`economy/${user.uid}/customCases/${caseId}`);
    } else {
      await revertListing();
      await db.ref(`economy/${user.uid}/coins`).transaction((c) => (c || 0) + listing.price);
      throw new HttpError(409, "CASE_UNAVAILABLE", "This case was removed by the owner \u2014 your coins are refunded");
    }
    await deliverRef.transaction((c) => (c || 0) + 1);
  } else {
    await db.ref(`inventory/${user.uid}/${listing.fragmentId}/count`).transaction((c) => (c || 0) + 1);
    await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);
  }
  await logLedger({
    type: "market_buy",
    buyerUid: user.uid,
    sellerUid: listing.sellerUid,
    listingId,
    kind: listing.kind || "fragment",
    caseId: listing.caseId,
    fragmentId: listing.fragmentId,
    price: listing.price,
    fee,
    sellerReceives
  });
  res.status(200).json({
    ok: true,
    listing: reserved,
    coinsLeft: coinsAfter
  });
});
async function deliverUsername(db, buyerUid, listing, revertListing, sellerReceives) {
  const key = String(listing.usernameKey || "");
  const username = String(listing.username || "");
  const sellerUid = String(listing.sellerUid || "");
  const [buyerProfileSnap, buyerAdminSnap] = await Promise.all([
    db.ref(`users/${buyerUid}/profile`).once("value"),
    db.ref(`admins/${buyerUid}`).once("value")
  ]);
  const buyerProfile = buyerProfileSnap.val() || {};
  const buyerVip = buyerProfile.isPremium === true || !!buyerProfile.premiumPlan || buyerProfile.ceo === true || buyerAdminSnap.val() === true;
  const USERNAME_CAP = buyerVip ? 5 : 2;
  const heldBefore = { ...buyerProfile.usernames || {} };
  const primaryBefore = typeof buyerProfile.username === "string" ? buyerProfile.username.toLowerCase() : "";
  const willHold = new Set([...Object.keys(heldBefore), primaryBefore, key].filter(Boolean));
  if (willHold.size > USERNAME_CAP) {
    await revertListing();
    throw new HttpError(
      409,
      "USERNAME_CAP_REACHED",
      buyerVip ? `VIP accounts can hold at most ${USERNAME_CAP} usernames` : `Accounts can hold at most ${USERNAME_CAP} usernames (VIP raises the cap to 5)`
    );
  }
  const mapTx = await db.ref(`usernames/${key}`).transaction((current) => {
    if (current === null || current === sellerUid) return buyerUid;
    return current;
  });
  const mapOwner = mapTx?.snapshot?.val?.();
  if (!mapTx?.committed || mapOwner !== buyerUid) {
    await revertListing();
    await db.ref(`economy/${buyerUid}/coins`).transaction((c) => (c || 0) + listing.price);
    await db.ref(`economy/${sellerUid}/coins`).transaction((c) => (c || 0) - sellerReceives);
    throw new HttpError(409, "USERNAME_TAKEN", "That username was just taken by someone else \u2014 your coins are refunded");
  }
  const profileSnap = await db.ref(`users/${buyerUid}/profile`).once("value");
  const profile = profileSnap.val() || {};
  const oldKey = typeof profile.username === "string" ? profile.username.toLowerCase() : "";
  const held = { ...profile.usernames || {} };
  const oldWasCollectible = !!held[oldKey];
  if (oldKey && oldKey !== key) {
    if (oldWasCollectible) {
      await db.ref(`usernames/${oldKey}`).set(buyerUid);
    } else {
      await db.ref(`usernames/${oldKey}`).set(null);
    }
  }
  await db.ref(`users/${buyerUid}/profile`).transaction((p) => ({
    ...p || {},
    uid: buyerUid,
    username,
    usernames: { ...(p || {}).usernames || {}, [key]: { username, at: Date.now() } }
  }));
  const sellerHeldSnap = await db.ref(`users/${sellerUid}/profile/usernames/${key}`).get();
  if (sellerHeldSnap.exists()) await db.ref(`users/${sellerUid}/profile/usernames/${key}`).set(null);
  if (oldKey && oldKey !== key) {
    const oldSnap = await db.ref(`publicProfiles/${oldKey}`).once("value");
    if (oldSnap.exists()) {
      const snap = oldSnap.val();
      await db.ref(`publicProfiles/${key}`).set({
        ...snap,
        username,
        usernameKey: key,
        updatedAt: Date.now(),
        usernames: buildUsernamesList(held, { [key]: { username } })
      });
      await db.ref(`publicProfiles/${oldKey}`).set({ redirect: key, updatedAt: Date.now() });
    }
  }
  await logLedger({
    type: "username_transfer",
    buyerUid,
    sellerUid,
    listingId: listing.id,
    usernameKey: key,
    price: listing.price
  });
}
function buildUsernamesList(held, extra) {
  const merged = {};
  for (const [k, v] of Object.entries(held)) {
    const name = v?.username || k;
    merged[k.toLowerCase()] = name;
  }
  for (const [k, v] of Object.entries(extra)) merged[k.toLowerCase()] = v.username;
  return Object.entries(merged).slice(0, 20).map(([k, name]) => ({ username: name, key: k }));
}

// api/_src/market/cancel.ts
var cancel_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { listingId } = req.body || {};
  if (!listingId || typeof listingId !== "string") throw new HttpError(400, "BAD_LISTING", "listingId required");
  const db = rtdb();
  const now = Date.now();
  const listingRef = db.ref(`market/${listingId}`);
  const tx = await listingRef.transaction((current) => {
    if (current && current.status === "active" && current.sellerUid === user.uid) {
      return { ...current, status: "canceled", canceledAt: now };
    }
    return current;
  });
  const listing = tx.snapshot.val();
  if (!tx.committed || !listing || listing.status !== "canceled") {
    throw new HttpError(400, "CANNOT_CANCEL", "Listing is not active or not yours");
  }
  if (listing.kind === "case") {
    const caseId = String(listing.caseId || "");
    const refundRef = caseId === "gold" ? db.ref(`economy/${user.uid}/goldCases`) : caseId === "inspire" ? db.ref(`economy/${user.uid}/cases`) : db.ref(`economy/${user.uid}/customCases/${caseId}`);
    await refundRef.transaction((c) => (c || 0) + 1);
  } else {
    await db.ref(`inventory/${user.uid}/${listing.fragmentId}/count`).transaction((c) => (c || 0) + 1);
    await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);
  }
  await logLedger({ type: "market_cancel", uid: user.uid, listingId, kind: listing.kind || "fragment", caseId: listing.caseId, fragmentId: listing.fragmentId });
  res.status(200).json({ ok: true });
});

// api/_src/market/index.ts
function safeParse(raw) {
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
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return String(body?.action || "");
}
async function handler(req, res) {
  const action = getAction(req);
  switch (action) {
    case "list":
      return list_default(req, res);
    case "buy":
      return buy_default(req, res);
    case "cancel":
      return cancel_default(req, res);
    default:
      return res.status(400).json({ error: "BAD_ACTION", message: "Unknown market action (use ?action=list|buy|cancel)" });
  }
}
export {
  handler as default
};
