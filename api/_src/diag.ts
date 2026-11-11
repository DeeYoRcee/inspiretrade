/**
 * TEMPORARY diagnostic endpoint (GET /api/diag).
 * Reports which env vars exist (no secrets) and attempts a real RTDB
 * read/write so the exact underlying error surfaces as JSON.
 * DELETE once the economy API is confirmed stable in production.
 */
import * as adminNamespace from "firebase-admin";
const admin: any = (adminNamespace as any).default ?? adminNamespace;

function json(res: any, status: number, data: unknown) {
  res.status(status).json(data);
}

const withTimeout = (p: Promise<any>, ms = 6000) =>
  Promise.race([
    p,
    new Promise((_res, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);

export default async function handler(req: any, res: any) {
  const report: Record<string, unknown> = {};
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
    const dbUrl = process.env.FIREBASE_DATABASE_URL || "";
    report.env = {
      node: process.version,
      hasServiceAccount: Boolean(raw),
      serviceAccountLength: raw.length,
      hasDatabaseUrl: Boolean(dbUrl),
      databaseUrl: dbUrl || "(not set)",
    };

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      report.parseError = String(e?.message || e);
    }
    if (parsed) {
      const pk = String(parsed.private_key || "");
      report.serviceAccount = {
        projectId: parsed.project_id || "(missing)",
        clientEmail: parsed.client_email || "(missing)",
        privateKeyPreview: pk.slice(0, 14) + `...len=${pk.length}`,
        hasRealNewlines: pk.includes("\n"),
        hasEscapedNewlines: pk.includes("\\n"),
      };
    } else {
      report.serviceAccount = "(could not parse JSON)";
    }

    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: parsed?.project_id,
        clientEmail: parsed?.client_email,
        privateKey: String(parsed?.private_key || "").replace(/\\n/g, "\n"),
      }),
      databaseURL:
        dbUrl || `https://${parsed?.project_id}-default-rtdb.firebaseio.com`,
    });
    report.init = "ok";

    try {
      const snap = await withTimeout(
        admin.database(app).ref(".info/serverTimeOffset").once("value"),
      );
      report.rtdbRead = { ok: true, serverTimeOffset: snap.val() };
    } catch (e: any) {
      report.rtdbRead = { ok: false, code: e?.code, message: e?.message };
    }

    try {
      await withTimeout(
        admin.database(app).ref("__diag/ping").set({ at: Date.now() }),
      );
      const back = await withTimeout(
        admin.database(app).ref("__diag/ping").once("value"),
      );
      report.rtdbWrite = { ok: true, roundTrip: Boolean(back.val()?.at) };
    } catch (e: any) {
      report.rtdbWrite = { ok: false, code: e?.code, message: e?.message };
    }

    report.authReady = typeof admin.auth(app)?.verifyIdToken === "function";

    try {
      await app.delete();
    } catch {}
    report.done = true;
    return json(res, 200, report);
  } catch (e: any) {
    report.fatal = {
      code: e?.code,
      message: e?.message,
      stack: String(e?.stack || "").split("\n").slice(0, 4),
    };
    return json(res, 500, report);
  }
}
