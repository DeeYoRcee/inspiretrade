/**
 * GET /api/diag  (temporary, authenticated)
 * Returns the caller's own economy + inventory as the SERVER sees it, plus
 * transaction-machinery probes on scratch paths (no user data mutated).
 * Remove after diagnosis.
 */
import { handle, requireUser, rtdb } from "./lib/firebase";

export default handle(async (req, res) => {
  const user = await requireUser(req);
  const db = rtdb();
  const [ecoSnap, invSnap] = await Promise.all([
    db.ref(`economy/${user.uid}`).get(),
    db.ref(`inventory/${user.uid}`).get(),
  ]);

  const probes: Record<string, unknown> = {};

  // 1) Value-returning transaction on a scratch path.
  try {
    const r = await db.ref("__diag/tx1").transaction((c: any) => (c || 0) + 1);
    probes.scratchValue = { committed: r.committed, val: r.snapshot.val() };
  } catch (e: any) {
    probes.scratchValue = { error: String(e?.message || e) };
  }

  // 2) undefined-abort WITHOUT warming (fresh path) — expected committed=false.
  try {
    const r = await db.ref("__diag/tx2").transaction((c: any) => {
      const v = c || 0;
      if (v < 1) return undefined;
      return v;
    });
    probes.scratchAbortCold = { committed: r.committed, val: r.snapshot.val() };
  } catch (e: any) {
    probes.scratchAbortCold = { error: String(e?.message || e) };
  }

  // 3) undefined-abort WITH applyLocally=false on a pre-seeded path —
  //    expected committed=true (1 -> 0).
  try {
    await db.ref("__diag/tx3").set(1);
    const r = await db
      .ref("__diag/tx3")
      .transaction(
        (c: any) => {
          const v = c || 0;
          if (v < 1) return undefined;
          return v - 1;
        },
        undefined,
        false,
      );
    probes.scratchAbortALF = { committed: r.committed, val: r.snapshot.val() };
  } catch (e: any) {
    probes.scratchAbortALF = { error: String(e?.message || e) };
  }

  // 4) THE decisive probe: the EXACT production shape on the caller's own
  //    economy/cases path, but read-only (returns current value unchanged).
  try {
    const r = await db
      .ref(`economy/${user.uid}/cases`)
      .transaction(
        (c: any) => {
          const v = c || 0;
          if (v < 1) return undefined;
          return v;
        },
        undefined,
        false,
      );
    probes.economyCasesRO = { committed: r.committed, val: r.snapshot.val() };
  } catch (e: any) {
    probes.economyCasesRO = { error: String(e?.message || e) };
  }

  res.status(200).json({
    uid: user.uid,
    sdkVersion: (globalThis as any).process?.env?.npm_package_version || null,
    economy: ecoSnap.val(),
    inventory: invSnap.val(),
    envDbUrlSet: !!process.env.FIREBASE_DATABASE_URL,
    probes,
  });
});
