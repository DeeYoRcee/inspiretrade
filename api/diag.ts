// Capture the actual error from importing shared/fragments
export default async function handler(_req: any, res: any) {
  const out: any = { ts: new Date().toISOString() };

  // Try catch around the dynamic import to capture the actual error
  try {
    const mod = await import("../shared/fragments");
    out.import = { ok: true, keys: Object.keys(mod), fragmentsCount: mod.FRAGMENTS?.length };
  } catch (e: any) {
    out.import = {
      ok: false,
      error: String(e?.message || e),
      code: e?.code,
      stack: String(e?.stack || "").split("\n").slice(0, 12),
    };
  }

  // Also try a manual require-like via createRequire
  try {
    const { createRequire } = await import("module");
    const req = createRequire(import.meta.url);
    const mod = req("../shared/fragments");
    out.createRequire = { ok: true, keys: Object.keys(mod), fragmentsCount: mod.FRAGMENTS?.length };
  } catch (e: any) {
    out.createRequire = {
      ok: false,
      error: String(e?.message || e),
      stack: String(e?.stack || "").split("\n").slice(0, 8),
    };
  }

  res.status(200).json(out);
}
