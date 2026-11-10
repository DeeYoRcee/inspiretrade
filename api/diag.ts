// Capture actual error from importing helpers dynamically
export default async function handler(_req: any, res: any) {
  const out: any = { ts: new Date().toISOString(), cwd: process.cwd() };

  // Try dynamic import of firebase-helper
  try {
    const mod: any = await import("./firebase-helper");
    out.firebaseHelper = { ok: true, keys: Object.keys(mod) };
  } catch (e: any) {
    out.firebaseHelper = {
      ok: false,
      error: String(e?.message || e),
      code: e?.code,
      stack: String(e?.stack || "").split("\n").slice(0, 10),
    };
  }

  // Try dynamic import of fragments-helper
  try {
    const mod: any = await import("./fragments-helper");
    out.fragmentsHelper = { ok: true, keys: Object.keys(mod) };
  } catch (e: any) {
    out.fragmentsHelper = {
      ok: false,
      error: String(e?.message || e),
      stack: String(e?.stack || "").split("\n").slice(0, 10),
    };
  }

  // Try fs.readdir to see what's in the api directory at runtime
  try {
    const fs = await import("fs");
    const path = await import("path");
    const apiDir = path.join(process.cwd(), "api");
    out.apiDir = fs.readdirSync(apiDir);
  } catch (e: any) {
    out.apiDir = { error: String(e?.message || e) };
  }

  res.status(200).json(out);
}
