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
var ALL_FRAGMENTS = [...FRAGMENTS, ...GOLD_FRAGMENTS, ...TRADING_FRAGMENTS];
var FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
var TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_TRADING = TRADING_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var REFERRAL_MILESTONES = [
  { invited: 3, cases: 1, goldCases: 0, insp: 0 },
  { invited: 10, cases: 3, goldCases: 0, insp: 0 },
  { invited: 25, cases: 5, goldCases: 1, insp: 0 },
  { invited: 50, cases: 7, goldCases: 3, insp: 5 },
  { invited: 100, cases: 10, goldCases: 5, insp: 10 }
];

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
    const claimed = (await rtdb().ref(`referralMilestones/${user.uid}`).get()).val() || {};
    return res.status(200).json({
      ok: true,
      code,
      invited: node.count || 0,
      earned: node.earned || 0,
      referredByCode: node.referredByCode || null,
      bonuses: { new: BONUS_NEW, referrerCase: REFERRAL_CASES },
      milestones: REFERRAL_MILESTONES,
      claimedMilestones: Object.keys(claimed).filter((k) => claimed[k] === true).map(Number)
    });
  }
  if (action === "milestone") {
    const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
    const tierIdx = Number(body?.tier);
    const tier = REFERRAL_MILESTONES[tierIdx];
    if (!tier) throw new HttpError(400, "BAD_TIER", "Unknown milestone tier");
    const node = (await rtdb().ref(`referrals/${user.uid}`).get()).val() || {};
    if ((node.count || 0) < tier.invited) {
      throw new HttpError(409, "NOT_REACHED", `You need ${tier.invited} invited users to claim this reward`);
    }
    const token = `${user.uid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const now = Date.now();
    const ecoTx = await rtdb().ref(`economy/${user.uid}`).transaction((eco) => {
      const e = { ...eco || {} };
      const milestones = { ...e.milestones || {} };
      const existing = milestones[tierIdx];
      if (existing?.claimed === true) return e;
      milestones[tierIdx] = { claimed: true, token, at: now };
      return {
        ...e,
        milestones,
        coins: (e.coins || 0) + tier.insp,
        cases: (e.cases || 0) + tier.cases,
        goldCases: (e.goldCases || 0) + tier.goldCases,
        updatedAt: now
      };
    });
    const after = ecoTx?.snapshot?.val?.() || {};
    const won = ecoTx.committed && after?.milestones?.[tierIdx]?.token === token;
    if (!won) {
      throw new HttpError(409, "ALREADY_CLAIMED", "This milestone reward has already been claimed");
    }
    await logLedger({ type: "referral_milestone", uid: user.uid, tier: tierIdx, invited: tier.invited, cases: tier.cases, goldCases: tier.goldCases, insp: tier.insp });
    return res.status(200).json({ ok: true, tier: tierIdx, reward: { cases: tier.cases, goldCases: tier.goldCases, insp: tier.insp } });
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
