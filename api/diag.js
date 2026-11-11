// api/_src/diag.ts
import * as adminNamespace from "firebase-admin";
var admin = adminNamespace.default ?? adminNamespace;
function json(res, status, data) {
  res.status(status).json(data);
}
var withTimeout = (p, ms = 6e3) => Promise.race([
  p,
  new Promise(
    (_res, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)
  )
]);
async function handler(req, res) {
  const report = {};
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
    const dbUrl = process.env.FIREBASE_DATABASE_URL || "";
    report.env = {
      node: process.version,
      hasServiceAccount: Boolean(raw),
      serviceAccountLength: raw.length,
      hasDatabaseUrl: Boolean(dbUrl),
      databaseUrl: dbUrl || "(not set)"
    };
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      report.parseError = String(e?.message || e);
    }
    if (parsed) {
      const pk = String(parsed.private_key || "");
      report.serviceAccount = {
        projectId: parsed.project_id || "(missing)",
        clientEmail: parsed.client_email || "(missing)",
        privateKeyPreview: pk.slice(0, 14) + `...len=${pk.length}`,
        hasRealNewlines: pk.includes("\n"),
        hasEscapedNewlines: pk.includes("\\n")
      };
    } else {
      report.serviceAccount = "(could not parse JSON)";
    }
    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: parsed?.project_id,
        clientEmail: parsed?.client_email,
        privateKey: String(parsed?.private_key || "").replace(/\\n/g, "\n")
      }),
      databaseURL: dbUrl || `https://${parsed?.project_id}-default-rtdb.firebaseio.com`
    });
    report.init = "ok";
    try {
      const snap = await withTimeout(
        admin.database(app).ref(".info/serverTimeOffset").once("value")
      );
      report.rtdbRead = { ok: true, serverTimeOffset: snap.val() };
    } catch (e) {
      report.rtdbRead = { ok: false, code: e?.code, message: e?.message };
    }
    try {
      await withTimeout(
        admin.database(app).ref("__diag/ping").set({ at: Date.now() })
      );
      const back = await withTimeout(
        admin.database(app).ref("__diag/ping").once("value")
      );
      report.rtdbWrite = { ok: true, roundTrip: Boolean(back.val()?.at) };
    } catch (e) {
      report.rtdbWrite = { ok: false, code: e?.code, message: e?.message };
    }
    report.authReady = typeof admin.auth(app)?.verifyIdToken === "function";
    try {
      await app.delete();
    } catch {
    }
    report.done = true;
    return json(res, 200, report);
  } catch (e) {
    report.fatal = {
      code: e?.code,
      message: e?.message,
      stack: String(e?.stack || "").split("\n").slice(0, 4)
    };
    return json(res, 500, report);
  }
}
export {
  handler as default
};
