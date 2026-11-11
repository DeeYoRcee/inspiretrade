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

// api/_src/diag.ts
var diag_default = handle(async (req, res) => {
  const user = await requireUser(req);
  const db = rtdb();
  const [ecoSnap, invSnap] = await Promise.all([
    db.ref(`economy/${user.uid}`).get(),
    db.ref(`inventory/${user.uid}`).get()
  ]);
  const probes = {};
  try {
    const r = await db.ref("__diag/tx1").transaction((c) => (c || 0) + 1);
    probes.scratchValue = { committed: r.committed, val: r.snapshot.val() };
  } catch (e) {
    probes.scratchValue = { error: String(e?.message || e) };
  }
  try {
    const r = await db.ref("__diag/tx2").transaction((c) => {
      const v = c || 0;
      if (v < 1) return void 0;
      return v;
    });
    probes.scratchAbortCold = { committed: r.committed, val: r.snapshot.val() };
  } catch (e) {
    probes.scratchAbortCold = { error: String(e?.message || e) };
  }
  try {
    await db.ref("__diag/tx3").set(1);
    const r = await db.ref("__diag/tx3").transaction(
      (c) => {
        const v = c || 0;
        if (v < 1) return void 0;
        return v - 1;
      },
      void 0,
      false
    );
    probes.scratchAbortALF = { committed: r.committed, val: r.snapshot.val() };
  } catch (e) {
    probes.scratchAbortALF = { error: String(e?.message || e) };
  }
  try {
    const r = await db.ref(`economy/${user.uid}/cases`).transaction(
      (c) => {
        const v = c || 0;
        if (v < 1) return void 0;
        return v;
      },
      void 0,
      false
    );
    probes.economyCasesRO = { committed: r.committed, val: r.snapshot.val() };
  } catch (e) {
    probes.economyCasesRO = { error: String(e?.message || e) };
  }
  res.status(200).json({
    uid: user.uid,
    sdkVersion: globalThis.process?.env?.npm_package_version || null,
    economy: ecoSnap.val(),
    inventory: invSnap.val(),
    envDbUrlSet: !!process.env.FIREBASE_DATABASE_URL,
    probes
  });
});
export {
  diag_default as default
};
