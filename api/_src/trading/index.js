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
 *   POST ?action=create                   { label?, startingBalance? }
 *   POST ?action=order                    { accountId, symbol, side, lots, kind: market|limit|stop, price?, sl?, tp? }
 *   POST ?action=close                    { accountId, positionId, lots? }   (lots? = partial close)
 *   POST ?action=modify                   { accountId, positionId, sl?, tp? }
 *   POST ?action=cancel                   { accountId, orderId }
 *   POST ?action=evaluate                 { accountId }   — SL/TP/pending/stop-out (idempotent)
 *   POST ?action=reset                    { accountId }   — DEMO reset to starting balance
 *   (no action)                           → health probe
 */
import { handle, requireUser, json, assertPost } from "../lib/firebase";
import * as store from "./store";
function safeParse(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function getAction(req) {
    try {
        const url = new URL(req.url || "/", "http://localhost");
        const q = url.searchParams.get("action");
        if (q)
            return String(q);
    }
    catch { /* fall through to body */ }
    const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
    return String(body?.action || "");
}
function bodyOf(req) {
    return typeof req.body === "string" ? safeParse(req.body) : req.body || {};
}
function requireAccountId(body) {
    const id = String(body?.accountId || "");
    if (!id)
        throw Object.assign(new Error("accountId is required"), { status: 400 });
    return id;
}
async function health(res) {
    json(res, 200, { status: "ok", version: "trading-1", functions: 12, time: new Date().toISOString() });
}
async function requireAccountAccess(_user, uid, accountId) {
    // Account ownership is structural: every query is rooted at users/{uid}/…
    // so a wrong accountId resolves to "not found" rather than another user's
    // data. This helper documents the invariant and guards empty ids.
    if (!accountId)
        throw Object.assign(new Error("accountId is required"), { status: 400 });
    void _user;
}
const routes = {
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
        json(res, 200, { account: await store.createAccount(user.uid, body.label, body.startingBalance) });
    },
    async order(_req, res, user, body) {
        await requireAccountAccess(user, user.uid, requireAccountId(body));
        const result = await store.placeOrder(user.uid, {
            accountId: String(body.accountId),
            symbol: String(body.symbol || ""),
            side: body.side,
            lots: Number(body.lots),
            kind: body.kind,
            price: body.price != null ? Number(body.price) : null,
            sl: body.sl != null && body.sl !== "" ? Number(body.sl) : null,
            tp: body.tp != null && body.tp !== "" ? Number(body.tp) : null,
            comment: body.comment,
        });
        json(res, 200, result);
    },
    async close(_req, res, user, body) {
        await requireAccountAccess(user, user.uid, requireAccountId(body));
        if (!body.positionId)
            throw Object.assign(new Error("positionId is required"), { status: 400 });
        const result = await store.closePosition(user.uid, String(body.accountId), String(body.positionId), body.lots != null ? Number(body.lots) : null);
        json(res, 200, result);
    },
    async modify(_req, res, user, body) {
        await requireAccountAccess(user, user.uid, requireAccountId(body));
        if (!body.positionId)
            throw Object.assign(new Error("positionId is required"), { status: 400 });
        const result = await store.modifyPosition(user.uid, String(body.accountId), String(body.positionId), body.sl !== undefined ? body.sl : undefined, body.tp !== undefined ? body.tp : undefined);
        json(res, 200, result);
    },
    async cancel(_req, res, user, body) {
        await requireAccountAccess(user, user.uid, requireAccountId(body));
        if (!body.orderId)
            throw Object.assign(new Error("orderId is required"), { status: 400 });
        json(res, 200, await store.cancelOrder(user.uid, String(body.accountId), String(body.orderId)));
    },
    async evaluate(_req, res, user, body) {
        await requireAccountAccess(user, user.uid, requireAccountId(body));
        json(res, 200, await store.evaluate(user.uid, String(body.accountId)));
    },
    async reset(_req, res, user, body) {
        await requireAccountAccess(user, user.uid, requireAccountId(body));
        json(res, 200, await store.resetAccount(user.uid, String(body.accountId)));
    },
};
export default handle(async (req, res) => {
    const action = getAction(req);
    if (!action)
        return health(res);
    const route = routes[action];
    if (!route) {
        return json(res, 400, { error: "BAD_ACTION", message: "Unknown trading action" });
    }
    if (action === "history") {
        // GET with bearer token (read-only)
        const user = await requireUser(req);
        return route(req, res, user, {});
    }
    assertPost(req);
    const user = await requireUser(req);
    return route(req, res, user, bodyOf(req));
});
