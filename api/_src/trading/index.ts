/**
 * POST/GET /api/trading?action=…
 *
 * Single serverless function for the whole simulated trading domain. Vercel
 * Hobby allows max 12 Serverless Functions per deployment, so this replaces
 * the old health.ts slot: when called without an action it serves the health
 * payload (vercel.json rewrites /api/health → /api/trading).
 *
 * Auth: every trading action requires a Firebase ID token (Bearer). The user
 * can only ever touch their own account subtree; ALL Firestore writes for
 * trading happen here with the Admin SDK — clients have no direct access
 * (firestore.rules denies the domain to clients).
 *
 *   GET  ?action=accounts                 → accounts + live metrics + quotes
 *   GET  ?action=history&accountId=&limit → immutable fills ledger
 *   POST ?action=create                   { label?, startingBalance?, leverage?, rules? }
 *   POST ?action=order                    { accountId, symbol, side, lots, kind: market|limit|stop, price?, sl?, tp? }
 *   POST ?action=close                    { accountId, positionId, lots? }   (lots? = partial close)
 *   POST ?action=close-all                { accountId }                      (close every open position)
 *   POST ?action=modify                   { accountId, positionId, sl?, tp? }
 *   POST ?action=modify-order             { accountId, orderId, price?, lots?, sl?, tp? }
 *   POST ?action=cancel                   { accountId, orderId }
 *   POST ?action=evaluate                 { accountId }   — SL/TP/pending/stop-out/rules (idempotent)
 *   POST ?action=reset                    { accountId }   — reset to starting balance (fresh challenge attempt)
 *   GET  ?action=quote&symbol=            → the engine's current two-sided quote
 *                                           (the trading ticket mirrors it)
 *   GET  ?action=challenge-types          → active challenge formats (prop-firm marketplace)
 *   GET  ?action=leaderboard&period=      → daily|weekly|monthly|all verified rankings
 *   GET/POST ?action=admin-*              → admin surface (requireAdmin): challenge type
 *                                          CRUD, assignment, monitoring, suspend/
 *                                          reactivate/reset, audit log, leaderboard switch
 *   (no action)                           → health probe
 */
import { handle, requireUser, json, assertPost, type AuthedUser } from "../lib/firebase";
import { getAdminRole, getPlatformSettings } from "../lib/platform";
import { CHALLENGES_ENABLED } from "../../../shared/roles";
import { HttpError } from "../lib/firebase";
import { assertRole } from "../admin/platform-guard";
import * as store from "./store";
import { orderBodyToPlaceOrderRequest, modifyOrderBodyToPatch } from "./route-bodies";
import { rateLimit } from "../lib/rate-limit";
import { runTradingCron, kickCronChainIfStale } from "./cron";
import { getQuotes } from "./prices";
import * as propAdmin from "./admin";
import * as leaderboard from "./leaderboard";

function safeParse(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}

function getAction(req: any): string {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch { /* fall through to body */ }
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return String(body?.action || "");
}

function bodyOf(req: any): any {
  return typeof req.body === "string" ? safeParse(req.body) : req.body || {};
}

function requireAccountId(body: any): string {
  const id = String(body?.accountId || "");
  if (!id) throw Object.assign(new Error("accountId is required"), { status: 400 });
  return id;
}

async function health(res: any) {
  json(res, 200, { status: "ok", version: "trading-1", functions: 12, time: new Date().toISOString() });
}

async function requireAccountAccess(_user: AuthedUser, uid: string, accountId: string) {
  // Account ownership is structural: every query is rooted at users/{uid}/…
  // so a wrong accountId resolves to "not found" rather than another user's
  // data. This helper documents the invariant and guards empty ids.
  if (!accountId) throw Object.assign(new Error("accountId is required"), { status: 400 });
  void _user;
}

// PHASE 62 §7 — per-user sliding-window rate limits on the mutation routes
// (in-process, per instance — blunts abuse and runaway loops).
const RL = {
  order: [30, 60_000] as const,
  close: [30, 60_000] as const,
  closeAll: [6, 60_000] as const,
  modify: [60, 60_000] as const,
  modifyOrder: [60, 60_000] as const,
  cancel: [30, 60_000] as const,
  create: [5, 60_000] as const,
};
function rlGuard(user: AuthedUser, kind: keyof typeof RL) {
  const [limit, windowMs] = RL[kind];
  if (!rateLimit(`${user.uid}:${kind}`, limit, windowMs)) {
    throw Object.assign(new HttpError(429, "RATE_LIMITED", `Too many ${kind} requests — slow down and try again shortly`), { status: 429 });
  }
}

const routes: Record<string, (req: any, res: any, user: AuthedUser, body: any) => Promise<void>> = {
  async quote(req, res) {
    // Phase 19 §1: the ticket's PRE-trade bid/ask must mirror the engine —
    // same price service, same genuine/synthetic spread model (the old
    // client-side SPREAD_PIPS estimate diverged from TrueFX-based fills).
    const url = new URL(req.url || "/", "http://localhost");
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
    const quotes = await getQuotes(symbol ? [symbol] : []);
    json(res, 200, { quote: quotes[symbol] ?? null });
  },
  async accounts(_req, res, user) {
    json(res, 200, { accounts: await store.listAccounts(user.uid) });
  },
  async history(req, res, user, body) {
    const url = new URL(req.url || "/", "http://localhost");
    const accountId = String(url.searchParams.get("accountId") || body.accountId || "");
    await requireAccountAccess(user, user.uid, accountId);
    const limit = Number(url.searchParams.get("limit") || body.limit || 100);
    json(res, 200, { trades: await store.history(user.uid, accountId, limit) });
  },
  async create(_req, res, user, body) {
    rlGuard(user, "create");
    // P38 — challenge purchases are temporarily switched off (pre-launch).
    // Only CHALLENGE creation is blocked: DEMO onboarding (rules === null)
    // keeps working, and admin-gifted challenges call store.createAccount
    // directly (propAdmin) so they are unaffected.
    if (!CHALLENGES_ENABLED && body.rules != null) {
      throw new HttpError(503, "CHALLENGES_DISABLED", "Challenge purchases are temporarily unavailable — they will open at launch.");
    }
    json(res, 200, { account: await store.createAccount(user.uid, body.label, body.startingBalance, {
      leverage: body.leverage != null ? Number(body.leverage) : null,
      rules: body.rules ?? null,
    }) });
  },
  async order(_req, res, user, body) {
    rlGuard(user, "order");
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    // PHASE 61 §10 — body normalization lives in route-bodies.ts (pure,
    // regression-tested): expiryAt / tsPct / requestId must reach the store.
    const result = await store.placeOrder(user.uid, orderBodyToPlaceOrderRequest(body));
    json(res, 200, result);
  },
  async close(_req, res, user, body) {
    rlGuard(user, "close");
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.positionId) throw Object.assign(new Error("positionId is required"), { status: 400 });
    const result = await store.closePosition(
      user.uid, String(body.accountId), String(body.positionId),
      body.lots != null ? Number(body.lots) : null,
    );
    json(res, 200, result);
  },
  async "close-all"(req, res, user, body) {
    rlGuard(user, "closeAll");
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    json(res, 200, await store.closeAll(user.uid, String(body.accountId)));
  },
  async modify(_req, res, user, body) {
    rlGuard(user, "modify");
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.positionId) throw Object.assign(new Error("positionId is required"), { status: 400 });
    const result = await store.modifyPosition(
      user.uid, String(body.accountId), String(body.positionId),
      body.sl !== undefined ? body.sl : undefined,
      body.tp !== undefined ? body.tp : undefined,
      body.tsPct !== undefined ? body.tsPct : undefined,
    );
    json(res, 200, result);
  },
  async "modify-order"(req, res, user, body) {
    rlGuard(user, "modifyOrder");
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.orderId) throw Object.assign(new Error("orderId is required"), { status: 400 });
    const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));
    const numOrUndef = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
    json(res, 200, await store.modifyOrder(user.uid, String(body.accountId), String(body.orderId), modifyOrderBodyToPatch(body)));
  },
  async cancel(_req, res, user, body) {
    rlGuard(user, "cancel");
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    if (!body.orderId) throw Object.assign(new Error("orderId is required"), { status: 400 });
    json(res, 200, await store.cancelOrder(user.uid, String(body.accountId), String(body.orderId)));
  },
  async evaluate(req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    json(res, 200, await store.evaluate(user.uid, String(body.accountId)));
    // PHASE 64 §3 — the browser is a SEED, never the authority: when the
    // 24/7 monitoring chain has gone quiet (no successful pass for 90s), an
    // online user's evaluate request re-seeds it. Financial execution is
    // always the shared transactional engine either way.
    try {
      const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
      const host = String(req.headers.host || "localhost");
      await kickCronChainIfStale(`${proto}://${host}`);
    } catch { /* diagnostics only */ }
  },
  async reset(_req, res, user, body) {
    await requireAccountAccess(user, user.uid, requireAccountId(body));
    json(res, 200, await store.resetAccount(user.uid, String(body.accountId)));
  },
  // ---- user-facing prop-firm surface ---------------------------------------
  async "challenge-types"(_req, res) {
    json(res, 200, { types: await propAdmin.listChallengeTypes(true) });
  },
  async leaderboard(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const periodRaw = String(url.searchParams.get("period") || "all");
    const period = leaderboard.isPeriod(periodRaw) ? periodRaw : "all";
    try {
      json(res, 200, await leaderboard.getLeaderboard(period));
    } catch (e: any) {
      // read-only endpoint — surface the failure code so ops can diagnose
      console.error("[api] leaderboard failed:", e?.code, e?.message);
      json(res, 500, { error: "INTERNAL", code: e?.code || null, message: e?.message || "leaderboard failed" });
    }
  },
};

// ---- admin routes (role-resolved; POST unless listed in ADMIN_GET_ACTIONS) ---
const ADMIN_GET_ACTIONS = new Set(["admin-challenge-types", "admin-accounts", "admin-account-detail", "admin-audit", "admin-trades"]);

/** Minimum-role action per admin route (shared/roles.ts matrix, server-enforced). */
const ADMIN_MIN_ACTION: Record<string, string> = {
  "admin-challenge-types": "settings.read",
  "admin-challenge-type-save": "challenge.write",
  "admin-challenge-type-delete": "challenge.write",
  "admin-accounts": "analytics.read",
  "admin-account-detail": "users.read",
  "admin-assign": "account.assign",
  "admin-leaderboard-toggle": "leaderboard.toggle",
  "admin-audit": "audit.read",
  "admin-trades": "trades.read",
};

const adminRoutes: Record<string, (req: any, res: any, admin: AuthedUser, body: any) => Promise<void>> = {
  async "admin-challenge-types"(_req, res) {
    json(res, 200, { types: await propAdmin.listChallengeTypes(false) });
  },
  async "admin-challenge-type-save"(_req, res, admin, body) {
    json(res, 200, await propAdmin.saveChallengeType(body, admin));
  },
  async "admin-challenge-type-delete"(_req, res, admin, body) {
    json(res, 200, await propAdmin.deleteChallengeType(String(body?.id || ""), admin));
  },
  async "admin-accounts"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    json(res, 200, { accounts: await propAdmin.listAllChallengeAccounts(url.searchParams.get("status") || "all") });
  },
  async "admin-account-detail"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const uid = String(url.searchParams.get("uid") || "");
    const aid = String(url.searchParams.get("aid") || "");
    if (!uid || !aid) throw Object.assign(new Error("uid and aid are required"), { status: 400 });
    json(res, 200, await propAdmin.accountDetail(uid, aid));
  },
  async "admin-assign"(_req, res, admin, body) {
    json(res, 200, await propAdmin.assignChallengeAccount(admin, body));
  },
  async "admin-account-action"(_req, res, admin, body) {
    json(res, 200, await propAdmin.setAccountState(admin, body));
  },
  async "admin-leaderboard-toggle"(_req, res, admin, body) {
    json(res, 200, await propAdmin.setLeaderboardEnabled(!!body?.enabled, admin));
  },
  async "admin-audit"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    json(res, 200, { entries: await propAdmin.listAudit({
      uid: url.searchParams.get("uid") || undefined,
      aid: url.searchParams.get("aid") || undefined,
    }, Number(url.searchParams.get("limit") || 100)) });
  },
  async "admin-trades"(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const uid = String(url.searchParams.get("uid") || "");
    const aid = String(url.searchParams.get("aid") || "");
    if (!uid || !aid) throw Object.assign(new Error("uid and aid are required"), { status: 400 });
    const limit = Number(url.searchParams.get("limit") || 200);
    // complete trading activity of any account (audit view)
    const db = (await import("../lib/firebase")).firestore();
    const snap = await db.collection("users").doc(uid).collection("accounts").doc(aid)
      .collection("trades").orderBy("closedAt", "desc").limit(Math.min(500, Math.max(1, limit))).get();
    json(res, 200, { trades: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) });
  },
};

export default handle(async (req, res) => {
  const action = getAction(req);
  if (!action) return health(res);

  // public platform-status probe (no auth) — maintenance/registration flags
  if (action === "platform-status") {
    const settings = await getPlatformSettings();
    // PHASE 64 §12 — public-safe health summary: only "is monitoring alive"
    // counters, never account data. Full diagnostics stay admin-only.
    let cron: { ageSec: number; processed: number; failed: number; remaining: number; lastError: string | null } | null = null;
    try {
      const db = (await import("../lib/firebase")).firestore();
      const mon = (await db.collection("platformMonitoring").doc("tradingCron").get()).data() as any;
      if (mon?.lastRunAt) {
        cron = {
          ageSec: Math.round((Date.now() - mon.lastRunAt) / 1000),
          processed: mon.processed ?? 0, failed: mon.failed ?? 0,
          remaining: mon.remaining ?? 0, lastError: mon.lastError ?? null,
        };
      }
    } catch { /* monitoring read is best-effort */ }
    return json(res, 200, { maintenance: settings.maintenanceMode, registrationOpen: settings.registrationOpen, challengesEnabled: CHALLENGES_ENABLED, cron });
  }

  // PHASE 62 §3 — server-authoritative trade-lifecycle evaluation entry
  // point. Runs WITHOUT a user token: guarded by the same CRON_SECRET
  // Bearer pattern as alerts-cron (Vercel Cron sends it natively). An
  // external minute-level scheduler (Upstash QStash / cron-job.org) hits
  // /api/trading?action=cron-evaluate; the vercel.json daily cron is the
  // guaranteed catch-up floor.
  if (action === "cron-evaluate") {
    // PHASE 64 §3 — the chain hop MUST be authenticated. On Vercel an unset
    // CRON_SECRET would leave the endpoint wide open to anyone (it triggers
    // evaluation of every account) — hard-fail in production instead.
    const secret = process.env.CRON_SECRET;
    if (!secret && process.env.VERCEL === "1") {
      return json(res, 401, { ok: false, error: "CRON_SECRET_NOT_CONFIGURED" });
    }
    if (secret) {
      const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (got !== secret) return json(res, 401, { ok: false, error: "UNAUTHORIZED" });
    }
    try {
      const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
      const host = String(req.headers.host || "localhost");
      const result = await runTradingCron(45_000, { baseUrl: `${proto}://${host}` });
      return json(res, 200, result);
    } catch (e) {
      return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // PHASE 67 — manual/ops lever for the server-side spot recorder: one
  // gold-api sample per code folded into the shared spotTicks store (the
  // transaction claim inside recorderStep makes concurrent calls idempotent).
  // Same CRON_SECRET Bearer guard as cron-evaluate — this writes SHARED
  // market data and must never be anonymously callable. The normal driver is
  // the trading-cron chain itself; this action exists for backfills after an
  // outage and for external health checks.
  if (action === "recorder-step") {
    const secret = process.env.CRON_SECRET;
    if (!secret && process.env.VERCEL === "1") {
      return json(res, 401, { ok: false, error: "CRON_SECRET_NOT_CONFIGURED" });
    }
    if (secret) {
      const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (got !== secret) return json(res, 401, { ok: false, error: "UNAUTHORIZED" });
    }
    try {
      const { recorderStep } = await import("../lib/spot-recorder");
      const diag = await recorderStep();
      return json(res, 200, diag);
    } catch (e) {
      return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // admin surface — role matrix enforced server-side (never frontend checks)
  if (action.startsWith("admin-")) {
    const route = adminRoutes[action];
    if (!route) return json(res, 400, { error: "BAD_ACTION", message: "Unknown admin action" });
    if (!ADMIN_GET_ACTIONS.has(action)) assertPost(req);
    const admin = await requireUser(req);
    const role = await getAdminRole(admin);
    const body = bodyOf(req);
    if (action === "admin-account-action") {
      assertRole(role, body?.action === "reset" ? "account.reset" : "account.suspend");
    } else {
      assertRole(role, ADMIN_MIN_ACTION[action] || "settings.write");
    }
    return route(req, res, admin, body);
  }

  const route = routes[action];
  if (!route) {
    return json(res, 400, { error: "BAD_ACTION", message: "Unknown trading action" });
  }
  // read-only actions accept GET — everything else is POST-only (state changes)
  const GET_ACTIONS = new Set(["history", "challenge-types", "leaderboard", "accounts", "quote"]);
  if (GET_ACTIONS.has(action)) {
    // GET with bearer token (read-only)
    const user = await requireUser(req);
    return route(req, res, user, {});
  }
  assertPost(req);
  const user = await requireUser(req);
  return route(req, res, user, bodyOf(req));
});
