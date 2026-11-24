import { createRequire as __cR } from 'module';
const require = __cR(import.meta.url);

// api/_src/cases/open.ts
import crypto from "crypto";

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
var BLACK_DROP_PERCENT = 1e-8;
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
  inspire: {
    id: "inspire",
    name: "Inspire Case",
    accountSize: 5e3,
    fragments: FRAGMENTS,
    blackDrop: { label: "5k$ Prop Account", accountSize: 5e3, dropPercent: BLACK_DROP_PERCENT }
  },
  gold: {
    id: "gold",
    name: "Gold Case",
    accountSize: 1e4,
    fragments: GOLD_FRAGMENTS,
    blackDrop: { label: "10k$ Prop Account", accountSize: 1e4, dropPercent: BLACK_DROP_PERCENT }
  },
  trading: {
    id: "trading",
    name: "Trading Case",
    accountSize: 25e3,
    fragments: TRADING_FRAGMENTS,
    blackDrop: { label: "25k$ Prop Account", accountSize: 25e3, dropPercent: BLACK_DROP_PERCENT }
  }
};
var ALL_FRAGMENTS = [...FRAGMENTS, ...GOLD_FRAGMENTS, ...TRADING_FRAGMENTS];
function expandCasePool(rows, all = ALL_FRAGMENTS) {
  const pool = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const base = all.find((f) => f.id === row?.id);
    if (!base) continue;
    const weight = Number(row?.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const qty = Math.max(1, Math.min(100, Math.floor(Number(row?.qty) || 1)));
    for (let i = 0; i < qty; i++) pool.push({ ...base, dropPercent: weight });
  }
  return pool;
}
var FRAGMENT_IDS = FRAGMENTS.map((f) => f.id);
var TOTAL_DROP_WEIGHT = FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_GOLD = GOLD_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);
var TOTAL_DROP_WEIGHT_TRADING = TRADING_FRAGMENTS.reduce((s, f) => s + f.dropPercent, 0);

// api/_src/cases/open.ts
function rollFragment(list, totalWeight) {
  let roll = crypto.randomInt(totalWeight * 100) / 100;
  for (const fragment of list) {
    roll -= fragment.dropPercent;
    if (roll < 0) return fragment;
  }
  return list[0];
}
var CASE_ID_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
function makeBlackReference(set) {
  const prefix = set === "gold" ? "GLD-B" : set === "trading" ? "TRD-B" : "INSP-B";
  return `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
var open_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const caseType = String(body.type || "inspire");
  let fragments;
  let counterRef;
  let caseName;
  let noCasesError;
  if (caseType === "inspire" || caseType === "gold" || caseType === "trading") {
    const caseDef = CASES[caseType];
    fragments = caseDef.fragments;
    caseName = caseDef.name;
    counterRef = caseType === "gold" ? db.ref(`economy/${user.uid}/goldCases`) : caseType === "trading" ? db.ref(`economy/${user.uid}/tradingCases`) : db.ref(`economy/${user.uid}/cases`);
    noCasesError = new HttpError(
      400,
      caseType === "gold" ? "NO_GOLD_CASES" : caseType === "trading" ? "NO_TRADING_CASES" : "NO_CASES",
      caseType === "gold" ? "You have no Gold Cases to open" : caseType === "trading" ? "You have no Trading Cases to open" : "You have no cases to open"
    );
  } else {
    if (!CASE_ID_RE.test(caseType)) throw new HttpError(400, "BAD_CASE", "Unknown case");
    const def = (await db.ref(`economyConfig/cases/${caseType}`).get()).val();
    if (!def || !Array.isArray(def.fragments) || def.fragments.length === 0) {
      throw new HttpError(404, "CASE_NOT_FOUND", "This case no longer exists");
    }
    fragments = expandCasePool(def.fragments);
    if (fragments.length === 0) {
      throw new HttpError(409, "CASE_EMPTY", "This case has no valid fragments left");
    }
    caseName = String(def.name || caseType);
    counterRef = db.ref(`economy/${user.uid}/customCases/${caseType}`);
    noCasesError = new HttpError(400, "NO_CASES", "You have no cases of this type to open");
  }
  await decrementCounter(counterRef, noCasesError);
  const blackDef = caseType === "inspire" || caseType === "gold" || caseType === "trading" ? CASES[caseType].blackDrop : null;
  if (blackDef && Math.random() < BLACK_DROP_PERCENT / 100) {
    const reference = makeBlackReference(caseType);
    const claimRef = db.ref(`claims/${user.uid}`).push();
    const claim = {
      id: claimRef.key,
      createdAt: now,
      reference,
      status: "pending",
      set: caseType,
      accountSize: blackDef.accountSize,
      source: "black-drop",
      fragments: {}
    };
    await claimRef.set(claim);
    await logLedger({ type: "case_open_black", uid: user.uid, caseType, caseName, claimId: claimRef.key, accountSize: blackDef.accountSize });
    return res.status(200).json({ ok: true, caseType, caseName, black: { label: blackDef.label, accountSize: blackDef.accountSize, set: caseType, claimId: claimRef.key, reference } });
  }
  const totalWeight = fragments.reduce((s, f) => s + f.dropPercent, 0);
  const fragment = rollFragment(fragments, totalWeight);
  await db.ref(`inventory/${user.uid}/${fragment.id}/count`).transaction((current) => (current || 0) + 1);
  await db.ref(`inventory/${user.uid}/${fragment.id}/updatedAt`).set(now);
  await logLedger({ type: "case_open", uid: user.uid, caseType, caseName, fragmentId: fragment.id, rarity: fragment.rarity });
  res.status(200).json({ ok: true, caseType, caseName, fragment });
});
export {
  open_default as default,
  rollFragment
};
