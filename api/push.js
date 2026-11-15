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

// api/_src/push/index.ts
function subKey(endpoint) {
  return Buffer.from(endpoint).toString("base64url").slice(0, 120);
}
function sanitize(s) {
  return {
    enabled: !!s?.enabled,
    symbols: Array.isArray(s?.symbols) ? s.symbols.slice(0, 20).map(String) : [],
    calEnabled: !!s?.calEnabled,
    calCurrencies: Array.isArray(s?.calCurrencies) ? s.calCurrencies.slice(0, 12).map(String) : []
  };
}
function getAction(req) {
  try {
    return String(new URL(req.url || "/", "http://localhost").searchParams.get("action") || "");
  } catch {
    return "";
  }
}
var index_default = handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const action = getAction(req);
  if (action === "subscribe") {
    const endpoint = String(body?.subscription?.endpoint || "");
    if (!endpoint.startsWith("https://")) {
      throw new HttpError(400, "INVALID_SUBSCRIPTION", "subscription.endpoint (https) is required");
    }
    await rtdb().ref(`pushSubs/${user.uid}/${subKey(endpoint)}`).set({ sub: body.subscription, at: Date.now() });
    if (body.settings && typeof body.settings === "object") {
      await rtdb().ref(`pushSettings/${user.uid}`).set({ ...sanitize(body.settings), at: Date.now() });
    }
    return res.status(200).json({ ok: true });
  }
  if (action === "unsubscribe") {
    const endpoint = String(body?.endpoint || "");
    if (endpoint) await rtdb().ref(`pushSubs/${user.uid}/${subKey(endpoint)}`).remove();
    return res.status(200).json({ ok: true });
  }
  if (action === "sync-settings") {
    await rtdb().ref(`pushSettings/${user.uid}`).set({ ...sanitize(body?.settings), at: Date.now() });
    return res.status(200).json({ ok: true });
  }
  throw new HttpError(400, "BAD_ACTION", "use ?action=subscribe|unsubscribe|sync-settings");
});
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
export {
  index_default as default
};
