/**
 * /api/admin?action=gift|withdrawals|deposits|chat-delete   (owner only)
 *
 * Single owner/admin serverless function (Vercel Hobby = max 12 functions).
 *
 *   ?action=gift            POST { uid?|username?, coins?, cases?, note? }
 *   ?action=withdrawals     GET  — list withdrawal requests (newest first)
 *                           POST { uid, id, action: "paid"|"rejected" }
 *   ?action=deposits        GET  — list deposit requests (newest first)
 *                           POST { uid, id, action: "approve"|"reject" }
 *                           approve credits the coins atomically.
 *   ?action=chat-delete     POST { messageId }
 *   ?action=chat-send       POST { text } — posts AS the CEO (stamped server-side)
 *   ?action=set-username    POST { username } — owner claims ANY handle (CEO badge)
 *   ?action=repair-profile-stub POST { key? } — ANY user: clear a uid-less
 *                             redirect stub at a handle they provably own
 *                             (self-service fix for PERMISSION_DENIED saves)
 */
import gift from "./gift";
import withdrawals from "./withdrawals";
import deposits from "./deposits";
import chatDelete from "./chat-delete";
import chatSend from "./chat-send";
import setUsername from "./set-username";
import profileRepair from "./profile-repair";
import usernameMarket from "./username-market";
import caseAdmin from "./cases";
import * as platform from "./platform";
import { getAdminRole } from "../lib/platform";
import { requireUser } from "../lib/firebase";

function safeParse(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}

function getAction(req: any): string {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
    // fall through to body
  }
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return String(body?.action || "");
}

// Phase 7 platform management — role-resolved surface. GET actions read
// query params; POST actions read the JSON body. Every handler enforces its
// permission server-side via assertRole (shared/roles.ts matrix).
const PLATFORM_ACTIONS: Record<string, { GET: boolean; run: (req: any, res: any, admin: any, role: any, body: any) => Promise<void> }> = {
  "users-list": { GET: true, run: (_q, res, a, r, b) => platform.listUsers(a, r, b).then((x) => res.json(x)) },
  "user-detail": { GET: true, run: (_q, res, a, r, b) => platform.userDetail(a, r, b).then((x) => res.json(x)) },
  "analytics": { GET: true, run: (_q, res, a, r) => platform.analytics(a, r).then((x) => res.json(x)) },
  "live-monitor": { GET: true, run: (_q, res, a, r) => platform.liveMonitor(a, r).then((x) => res.json(x)) },
  "admin-alerts": { GET: true, run: (_q, res, a, r) => platform.listAlerts(a, r).then((x) => res.json(x)) },
  "admin-settings-get": { GET: true, run: (_q, res, a, r) => platform.getSettings(a, r).then((x) => res.json(x)) },
  "admin-roles-get": { GET: true, run: (_q, res, a, r) => platform.getRoles(a, r).then((x) => res.json(x)) },
  "user-set-state": { GET: false, run: (_q, res, a, r, b) => platform.setUserState(a, r, b).then((x) => res.json(x)) },
  "purge-profile-stubs": { GET: false, run: (_q, res, a, r, b) => platform.purgeProfileStubs(a, r, b).then((x) => res.json(x)) },
  "user-note": { GET: false, run: (_q, res, a, r, b) => platform.addNote(a, r, b).then((x) => res.json(x)) },
  "admin-account-create": { GET: false, run: (_q, res, a, r, b) => platform.createAccount(a, r, b).then((x) => res.json(x)) },
  "admin-alerts-read": { GET: false, run: (_q, res, a, r, b) => platform.markAlertsRead(a, r, b).then((x) => res.json(x)) },
  "admin-settings-save": { GET: false, run: (_q, res, a, r, b) => platform.saveSettings(a, r, b).then((x) => res.json(x)) },
  "admin-roles-set": { GET: false, run: (_q, res, a, r, b) => platform.setRole(a, r, b).then((x) => res.json(x)) },
};

export default async function handler(req: any, res: any) {
  const action = getAction(req);

  // Phase 7 platform surface — auth + role resolution + per-action matrix
  const platformEntry = PLATFORM_ACTIONS[action];
  if (platformEntry) {
    try {
      const admin = await requireUser(req);
      const role = await getAdminRole(admin);
      let body: any = {};
      if (platformEntry.GET) {
        const url = new URL(req.url || "/", "http://localhost");
        body = Object.fromEntries(url.searchParams.entries());
      } else {
        body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
      }
      return await platformEntry.run(req, res, admin, role, body);
    } catch (e: any) {
      const status = e?.status || e?.statusCode || (String(e?.message || "").includes("token") ? 401 : 500);
      return res.status(status).json({ error: e?.code || "INTERNAL", message: e?.message || "server error" });
    }
  }

  switch (action) {
    case "gift":
      return gift(req, res);
    case "withdrawals":
      // GET lists requests, POST marks one paid/rejected (handled inside).
      return withdrawals(req, res);
    case "deposits":
      // GET lists requests, POST approves (credits coins) / rejects one.
      return deposits(req, res);
    case "chat-delete":
      return chatDelete(req, res);
    case "chat-send":
      return chatSend(req, res);
    case "set-username":
      return setUsername(req, res);
    case "repair-profile-stub":
      // Phase 19: self-service stub repair for ANY authenticated user whose
      // handle is provably theirs — the admin purge endpoint needs an admin
      // ROLE the CEO flag does not grant, which left users stuck on
      // "an admin needs to repair it" after an owner username move
      return profileRepair(req, res);
    case "usernameList":
    case "usernameUnlist":
      return usernameMarket(req, res);
    case "caseCreate":
    case "caseDelete":
    case "caseGrant":
      // owner's case factory — create/delete custom case definitions, grant
      // cases of ANY type (all three dispatched from one module)
      return caseAdmin(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown admin action (use ?action=gift|withdrawals|deposits|chat-delete|chat-send|set-username|caseCreate|caseDelete|caseGrant)" });
  }
}
