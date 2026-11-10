// Test: does _lib/fragments import work after the move?
import { FRAGMENTS } from "./_lib/fragments";

export default async function handler(_req: any, res: any) {
  const out: any = { ts: new Date().toISOString() };

  out.staticImport = { ok: true, fragmentsCount: FRAGMENTS.length };

  // Try dynamic import
  try {
    const mod: any = await import("./_lib/fragments");
    out.dynamicImport = { ok: true, fragmentsCount: mod.FRAGMENTS?.length };
  } catch (e: any) {
    out.dynamicImport = { ok: false, error: String(e?.message || e) };
  }

  // Try ./_lib/firebase
  try {
    const mod: any = await import("./_lib/firebase");
    out.libImport = { ok: true, keys: Object.keys(mod) };
  } catch (e: any) {
    out.libImport = { ok: false, error: String(e?.message || e) };
  }

  res.status(200).json(out);
}
