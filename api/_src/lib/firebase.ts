/**
 * Shared helper for all economy/market API functions.
 * Verifies the caller's Firebase ID token and provides an Admin SDK handle
 * so the server can write to paths that are locked for clients in
 * database.rules.json (economy, inventory, market, ledger, claims).
 */
// Use namespace import + default fallback for max compatibility across
// Node ESM/CJS runtimes (Vercel runs Node 26 with strict ESM interop).
import * as adminNamespace from "firebase-admin";
const admin: any = (adminNamespace as any).default ?? adminNamespace;

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

let app: any = null;

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

function ensureApp(): any {
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

/**
 * Owner / admin guard. A caller is an admin when their verified Firebase
 * email is listed in the ADMIN_EMAILS env var (comma-separated) OR an
 * `admins/{uid} === true` flag exists in the database.
 */
export async function requireAdmin(req: any): Promise<AuthedUser> {
  const user = await requireUser(req);
  const emails = String(process.env.ADMIN_EMAILS || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let flagged = false;
  try {
    flagged = (await rtdb().ref(`admins/${user.uid}`).once("value")).val() === true;
  } catch {}
  if (!emails.includes(String(user.email || "").toLowerCase()) && !flagged) {
    throw new HttpError(403, "FORBIDDEN", "Owner access required");
  }
  return user;
}

export function rtdb(): any {
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

/**
 * Atomically decrements a numeric counter by 1, or fails with `insufficientError`.
 *
 * IMPORTANT (firebase-admin 12 gotcha, proven in production): a transaction
 * whose update function returns `undefined` aborts INSTANTLY on a fresh
 * function instance — the first speculative run sees a locally-null cache and
 * `applyLocally: false` does NOT force a server fetch (verified via probes:
 * value-returning transactions commit fine, undefined-aborting ones never do,
 * even when the server value is sufficient). Therefore the update fn below
 * NEVER returns undefined: it no-ops (returns the current value) when the
 * balance is insufficient, and success is detected by comparing the
 * post-transaction snapshot against the pre-read value.
 */
export async function decrementCounter(
  ref: any,
  insufficientError: HttpError,
): Promise<number> {
  const before = (await ref.get()).val() || 0;
  const tx = await ref.transaction((c: any) => {
    const v = c || 0;
    return v >= 1 ? v - 1 : v; // never undefined
  });
  const after = tx?.snapshot?.val?.() ?? 0;
  if (!tx?.committed || after >= before) {
    // Our decrement never applied — the counter hit 0 before we got it.
    throw insufficientError;
  }
  return after;
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
