/**
 * P75 — profile frames: equip / clear, dispatched through
 * /api/admin?action=frame-equip|frame-clear|frame-role
 * (Vercel Hobby allows max 12 functions, so it lives inside the admin
 * function like the case factory).
 *
 *   ?action=frame-equip  POST { frame: "<catalog id>" }
 *   ?action=frame-clear  POST {}
 *   ?action=frame-role   GET  → { superAdmin } — lets the gallery show the
 *                          exclusive CEO card ONLY to authorized accounts
 *
 * Storage: RTDB frames/<uid> = { frame, updatedAt }. The rules file gives
 * clients read-own ONLY and NO write path at all, so this API is the single
 * writer (the admin SDK bypasses rules; every direct client write is denied).
 *
 * CEO exclusivity is enforced SERVER-SIDE, never in the frontend: the
 * "ceo" frame requires the caller's resolved admin role to be super_admin
 * (RTDB adminRoles/<uid>, or the bootstrapped first ADMIN_EMAILS entry —
 * the existing trusted role system, platform.ts). A normal user cannot
 * obtain the frame by forging requests, editing browser state or writing
 * RTDB nodes: rules deny direct writes to frames/ and publicProfiles.frame
 * validates against the server-owned value.
 */
import { handle, requireUser, assertPost, rtdb, HttpError, logLedger } from "../lib/firebase";
import { getAdminRole, writeAdminAlert } from "../lib/platform";
import { FRAMES } from "../../../shared/frames";

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getBody(req: any): any {
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return body || {};
}

function getAction(req: any): string {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
    // fall through to body
  }
  return String(getBody(req)?.action || "");
}

const frame_default = handle(async (req, res) => {
  const user = await requireUser(req);
  const action = getAction(req);
  const body = getBody(req);

  if (action === "frame-role") {
    const role = await getAdminRole(user);
    res.status(200).json({ ok: true, superAdmin: role === "super_admin" });
    return;
  }

  assertPost(req);
  if (action === "frame-clear") {
    await rtdb().ref(`frames/${user.uid}`).remove();
    await logLedger({ type: "frame_clear", uid: user.uid });
    res.status(200).json({ ok: true, frame: null });
    return;
  }

  if (action === "frame-equip") {
    const id = String(body?.frame || "");
    const def = FRAMES.find((f) => f.id === id);
    if (!def) throw new HttpError(400, "BAD_FRAME", "Unknown frame");
    if (def.exclusive) {
      const role = await getAdminRole(user);
      if (role !== "super_admin") {
        // audit the attempt, then refuse — never trust the client
        await writeAdminAlert(
          {
            type: "suspicious_activity",
            severity: "warning",
            uid: user.uid,
            text: `Non-super-admin attempted to equip the exclusive "${def.id}" frame`,
          },
          `frame-${def.id}-${user.uid}`,
        );
        throw new HttpError(403, "FRAME_FORBIDDEN", "This frame is exclusive to the InspireTrade CEO account");
      }
    }
    await rtdb().ref(`frames/${user.uid}`).set({ frame: def.id, updatedAt: Date.now() });
    await logLedger({ type: "frame_equip", uid: user.uid, frame: def.id });
    res.status(200).json({ ok: true, frame: def.id });
    return;
  }

  throw new HttpError(400, "BAD_ACTION", "Unknown frame action (use frame-equip|frame-clear|frame-role)");
});

export default frame_default;
