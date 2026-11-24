/**
 * P75 — profile frame hooks.
 *
 * useEquippedFrame — live-reads the server-owned frames/<uid> node (the
 * rules file grants read-own ONLY; every write goes through the API). If the
 * rule is not deployed yet (or the node is missing) the hook reports null —
 * callers treat that as "no frame", never as a guessed value.
 *
 * useFrameRole — asks the SERVER whether the signed-in account holds the
 * super_admin role (resolved from RTDB adminRoles / the ADMIN_EMAILS
 * bootstrap). The client uses it only to decide whether the exclusive CEO
 * card shows in the gallery; the actual equip check happens server-side.
 */
import { useEffect, useState } from "react";
import { onValue, ref } from "firebase/database";
import { db } from "@/lib/firebase";
import { authedFetch } from "@/lib/api";

export function useEquippedFrame(uid?: string | null): { frame: string | null; ready: boolean } {
  const [frame, setFrame] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!uid) {
      setFrame(null);
      setReady(true);
      return;
    }
    const unsub = onValue(
      ref(db, `frames/${uid}`),
      (snap) => {
        const val = snap.val() as { frame?: string } | null;
        setFrame(typeof val?.frame === "string" && val.frame ? val.frame : null);
        setReady(true);
      },
      () => {
        // permission denied (rule not deployed yet) or transient error —
        // show "no frame"; equip state will appear once rules are live
        setFrame(null);
        setReady(true);
      },
    );
    return () => unsub();
  }, [uid]);

  return { frame, ready };
}

export function useFrameRole(enabled = true): boolean {
  const [superAdmin, setSuperAdmin] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    authedFetch<any>("/api/admin?action=frame-role", {})
      .then((res) => { if (alive) setSuperAdmin(!!res?.superAdmin); })
      .catch(() => { if (alive) setSuperAdmin(false); });
    return () => { alive = false; };
  }, [enabled]);
  return superAdmin;
}
