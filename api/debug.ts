/**
 * Temporary debug endpoint — shows what is failing in the Vercel runtime.
 * Safe to call (no auth, read-only). Remove after diagnosis.
 */
export default async function handler(_req: any, res: any) {
  const out: any = { ts: new Date().toISOString(), node: process.version };

  // 1) env presence (without leaking values)
  out.env = {
    FIREBASE_SERVICE_ACCOUNT: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL || null,
  };

  // 2) try a dynamic import of firebase-admin
  try {
    const admin: any = await import("firebase-admin");
    out.admin = {
      ok: true,
      version: admin.SDK_VERSION,
      hasApps: !!admin.apps,
      hasAuth: typeof admin.auth,
      hasDatabase: typeof admin.database,
    };
  } catch (e: any) {
    out.admin = { ok: false, error: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 8) };
  }

  // 3) try a require-based import (CJS fallback)
  try {
    const admin2 = require("firebase-admin");
    out.adminRequire = { ok: true, version: admin2.SDK_VERSION };
  } catch (e: any) {
    out.adminRequire = { ok: false, error: String(e?.message || e) };
  }

  // 4) try initializing app if service-account env is present
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      out.sa = { ok: true, hasProjectId: !!parsed.project_id, hasClientEmail: !!parsed.client_email, hasPrivateKey: !!parsed.private_key };
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      out.sa = { ok: true, source: "split", projectId: process.env.FIREBASE_PROJECT_ID };
    } else {
      out.sa = { ok: false, reason: "no service account env" };
    }
  } catch (e: any) {
    out.sa = { ok: false, error: String(e?.message || e) };
  }

  res.status(200).json(out);
}
