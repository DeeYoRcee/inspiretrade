/**
 * Temporary diagnostics endpoint. Safe to call. Remove after fix is verified.
 */
import { FRAGMENTS, DAILY_COINS } from "../shared/fragments";

export default async function handler(_req: any, res: any) {
  const out: any = { ts: new Date().toISOString(), node: process.version, cwd: process.cwd() };

  out.env = {
    hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
    hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
    databaseUrl: process.env.FIREBASE_DATABASE_URL || null,
  };

  // Try multiple import strategies to see which works
  try {
    const mod: any = await import("firebase-admin");
    out.nsImport = {
      ok: true,
      keys: Object.keys(mod).slice(0, 20),
      hasDefault: !!mod.default,
      hasAuth: typeof mod.auth,
      hasDatabase: typeof mod.database,
      hasApps: typeof mod.apps,
      hasInit: typeof mod.initializeApp,
      hasCredential: typeof mod.credential,
      defaultKeys: mod.default ? Object.keys(mod.default).slice(0, 20) : null,
      defaultHasAuth: mod.default ? typeof mod.default.auth : null,
      defaultHasDatabase: mod.default ? typeof mod.default.database : null,
    };
  } catch (e: any) {
    out.nsImport = { ok: false, error: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 5) };
  }

  // Try a manual initializeApp to confirm the full API works
  try {
    const mod: any = await import("firebase-admin");
    const a = mod.default ?? mod;
    if (a.apps && a.apps.length === 0 && process.env.FIREBASE_PROJECT_ID) {
      a.initializeApp({
        credential: a.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    }
    out.afterInit = {
      appsLength: a.apps ? a.apps.length : "no apps array",
      authWorks: a.auth ? typeof a.auth : "no auth",
      databaseWorks: a.database ? typeof a.database : "no database",
    };
  } catch (e: any) {
    out.afterInit = { ok: false, error: String(e?.message || e) };
  }

  out.sharedImport = { ok: true, fragments: FRAGMENTS.length, dailyCoins: DAILY_COINS };
  res.status(200).json(out);
}
