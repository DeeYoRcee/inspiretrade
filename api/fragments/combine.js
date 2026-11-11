// api/_src/fragments/combine.ts
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

// api/_src/fragments/combine.ts
function makeReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return `INSP-${code}`;
}
var combine_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const db = rtdb();
  const now = Date.now();
  const invRef = db.ref(`inventory/${user.uid}`);
  await invRef.get();
  const tx = await invRef.transaction((current) => {
    const inventory = current || {};
    for (const fragment of FRAGMENTS) {
      if (!((inventory[fragment.id] || {}).count >= 1)) return void 0;
    }
    const next = JSON.parse(JSON.stringify(inventory));
    for (const fragment of FRAGMENTS) {
      next[fragment.id] = {
        ...next[fragment.id] || {},
        count: (next[fragment.id].count || 0) - 1,
        updatedAt: now
      };
    }
    return next;
  }, void 0, false);
  if (!tx.committed) {
    throw new HttpError(400, "MISSING_FRAGMENTS", "You need at least one fragment of every type (9 total)");
  }
  const reference = makeReference();
  const claimRef = db.ref(`claims/${user.uid}`).push();
  const claim = {
    id: claimRef.key,
    createdAt: now,
    reference,
    status: "pending",
    fragments: Object.fromEntries(FRAGMENTS.map((f) => [f.id, true]))
  };
  await claimRef.set(claim);
  await logLedger({ type: "combine", uid: user.uid, claimId: claimRef.key, reference });
  res.status(200).json({ ok: true, claim });
});
export {
  combine_default as default
};
