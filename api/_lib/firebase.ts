/**
 * Shared helper for all economy/market API functions.
 * Verifies the caller's Firebase ID token and provides an Admin SDK handle
 * so the server can write to paths that are locked for clients in
 * database.rules.json (economy, inventory, market, ledger, claims).
 */
import admin from "firebase-admin";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

let app: admin.app.App | null = null;

function getServiceAccount():
  | { projectId: string; clientEmail: string; privateKey: string }
  | null {
  // Preferred: one JSON string with the whole service-account key.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: String(parsed.private_key).replace(/\\n/g, "\n"),
        };
      }
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON");
    }
  }
  // Fallback: individual variables.
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    };
  }
  return null;
}

function ensureApp(): admin.app.App {
  if (app) return app;
  const account = getServiceAccount();
  if (!account) {
    throw new HttpError(
      500,
      "SERVER_NOT_CONFIGURED",
      "Missing FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) environment variables on the server.",
    );
  }
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKey: account.privateKey,
    }),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      `https://${account.projectId}-default-rtdb.firebaseio.com`,
  });
  return app;
}

export interface AuthedUser {
  uid: string;
  email?: string;
  name?: string;
}

export async function requireUser(req: any): Promise<AuthedUser> {
  const header: string = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, "MISSING_TOKEN", "Missing Authorization bearer token");
  ensureApp();
  let decoded: any;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired token");
  }
  if (!decoded?.uid) throw new HttpError(401, "INVALID_TOKEN", "Invalid token payload");
  return { uid: decoded.uid, email: decoded.email, name: decoded.name };
}

export function rtdb(): admin.database.Database {
  ensureApp();
  return admin.database();
}

export function json(res: any, status: number, data: unknown) {
  res.status(status).json(data);
}

/** Wraps a handler so thrown HttpErrors become clean JSON responses. */
export function handle(fn: (req: any, res: any) => Promise<void>) {
  return async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        console.error("[api] unexpected error:", err);
        res.status(500).json({ error: "INTERNAL", message: "Unexpected server error" });
      }
    }
  };
}

export function assertPost(req: any) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST only");
}

/** Returns the calendar date (YYYY-MM-DD) in a fixed UTC offset, default UTC+5 (Tashkent). */
export function localDate(offsetHours = 5, d = new Date()): string {
  return new Date(d.getTime() + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

export function previousDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
}

export async function logLedger(entry: Record<string, unknown>) {
  try {
    await rtdb().ref("ledger").push({ ...entry, at: Date.now() });
  } catch (e) {
    console.error("[api] ledger write failed", e);
  }
}
