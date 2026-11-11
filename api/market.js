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
  { id: "discipline", name: "Discipline", icon: "ShieldCheck", rarity: "common", dropPercent: 20 },
  { id: "patience", name: "Patience", icon: "Hourglass", rarity: "common", dropPercent: 20 },
  { id: "risk-management", name: "Risk Management", icon: "Scale", rarity: "rare", dropPercent: 14 },
  { id: "backtesting", name: "Backtesting", icon: "FlaskConical", rarity: "rare", dropPercent: 14 },
  { id: "trading-plan", name: "Trading Plan", icon: "ClipboardList", rarity: "epic", dropPercent: 9 },
  { id: "psychology", name: "Psychology", icon: "Brain", rarity: "epic", dropPercent: 9 },
  { id: "consistency", name: "Consistency", icon: "Repeat", rarity: "covert", dropPercent: 5 },
  { id: "execution", name: "Execution", icon: "Crosshair", rarity: "covert", dropPercent: 5 },
  { id: "master-trader", name: "Master Trader", icon: "Crown", rarity: "mythic", dropPercent: 2 }
];
var FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
var TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var MARKET_FEE_PERCENT = 10;
var MAX_ACTIVE_LISTINGS = 20;
var MIN_LISTING_PRICE = 1;
var MAX_LISTING_PRICE = 1e6;
function getFragment(id) {
  return FRAGMENTS.find((f) => f.id === id);
}

// api/_src/market/list.ts
var list_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const { fragmentId, price } = req.body || {};
  const fragment = getFragment(String(fragmentId || ""));
  if (!fragment) throw new HttpError(400, "BAD_FRAGMENT", "Unknown fragment");
  const parsedPrice = Number(price);
  if (!Number.isInteger(parsedPrice) || parsedPrice < MIN_LISTING_PRICE || parsedPrice > MAX_LISTING_PRICE) {
    throw new HttpError(400, "BAD_PRICE", `Price must be a whole number between ${MIN_LISTING_PRICE} and ${MAX_LISTING_PRICE} INSP`);
  }
  const db = rtdb();
  const now = Date.now();
  const countRef = db.ref(`inventory/${user.uid}/${fragment.id}/count`);
  await decrementCounter(countRef, new HttpError(400, "NO_FRAGMENT", "You don't own this fragment"));
  const allListings = (await db.ref("market").get()).val() || {};
  const activeMine = Object.values(allListings).filter(
    (l) => l && l.sellerUid === user.uid && l.status === "active"
  ).length;
  if (activeMine >= MAX_ACTIVE_LISTINGS) {
    await db.ref(`inventory/${user.uid}/${fragment.id}/count`).transaction((c) => (c || 0) + 1);
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
    fragmentId: fragment.id,
    price: parsedPrice,
    status: "active",
    listedAt: now
  };
  await listingRef.set(listing);
  await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);
  await logLedger({ type: "market_list", uid: user.uid, listingId: listingRef.key, fragmentId: fragment.id, price: parsedPrice });
  res.status(200).json({ ok: true, listing });
});

// api/_src/market/buy.ts
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
  const coinsRef = db.ref(`economy/${user.uid}/coins`);
  const before = (await coinsRef.get()).val() || 0;
  const payTx = await coinsRef.transaction((c) => {
    const v = c || 0;
    return v >= listing.price ? v - listing.price : v;
  });
  const coinsAfter = payTx?.snapshot?.val?.() ?? 0;
  if (!payTx?.committed || coinsAfter >= before) {
    await db.ref(`market/${listingId}`).transaction((current) => {
      if (current && current.status === "sold" && current.buyerUid === user.uid) {
        return { ...current, status: "active", buyerUid: null, soldAt: null };
      }
      return current;
    });
    throw new HttpError(400, "INSUFFICIENT_COINS", "Not enough INSP coins");
  }
  const sellerReceives = Math.floor(listing.price * (1 - MARKET_FEE_PERCENT / 100));
  const fee = listing.price - sellerReceives;
  await db.ref(`economy/${listing.sellerUid}/coins`).transaction((c) => (c || 0) + sellerReceives);
  await db.ref(`inventory/${user.uid}/${listing.fragmentId}/count`).transaction((c) => (c || 0) + 1);
  await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);
  await logLedger({
    type: "market_buy",
    buyerUid: user.uid,
    sellerUid: listing.sellerUid,
    listingId,
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
  await db.ref(`inventory/${user.uid}/${listing.fragmentId}/count`).transaction((c) => (c || 0) + 1);
  await db.ref(`inventory/${user.uid}/${listing.fragmentId}/updatedAt`).set(now);
  await logLedger({ type: "market_cancel", uid: user.uid, listingId, fragmentId: listing.fragmentId });
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
