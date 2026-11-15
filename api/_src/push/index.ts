/**
 * /api/push?action=subscribe|unsubscribe|sync-settings   (auth required)
 *
 * Web Push registration for alerts that must arrive while the site is
 * CLOSED (the user's complaint: notifications only arrived on visit).
 *   pushSubs/{uid}/{subKey}     — PushSubscription objects (per browser)
 *   pushSettings/{uid}          — alert settings snapshot (symbols, currencies)
 * The cron (api/_src/alerts-cron.ts) reads both and delivers via web-push
 * with the VAPID keys from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
 */
import { handle, requireUser, assertPost, rtdb, HttpError } from "../lib/firebase";

function subKey(endpoint: string): string {
  return Buffer.from(endpoint).toString("base64url").slice(0, 120);
}

function sanitize(s: any) {
  return {
    enabled: !!s?.enabled,
    symbols: Array.isArray(s?.symbols) ? s.symbols.slice(0, 20).map(String) : [],
    calEnabled: !!s?.calEnabled,
    calCurrencies: Array.isArray(s?.calCurrencies) ? s.calCurrencies.slice(0, 12).map(String) : [],
  };
}

function getAction(req: any): string {
  try {
    return String(new URL(req.url || "/", "http://localhost").searchParams.get("action") || "");
  } catch {
    return "";
  }
}

export default handle(async (req, res) => {
  assertPost(req);
  const user = await requireUser(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const action = getAction(req);

  if (action === "subscribe") {
    const endpoint = String(body?.subscription?.endpoint || "");
    if (!endpoint.startsWith("https://")) {
      throw new HttpError(400, "INVALID_SUBSCRIPTION", "subscription.endpoint (https) is required");
    }
    await rtdb()
      .ref(`pushSubs/${user.uid}/${subKey(endpoint)}`)
      .set({ sub: body.subscription, at: Date.now() });
    if (body.settings && typeof body.settings === "object") {
      await rtdb().ref(`pushSettings/${user.uid}`).set({ ...sanitize(body.settings), at: Date.now() });
    }
    return res.status(200).json({ ok: true });
  }

  if (action === "unsubscribe") {
    const endpoint = String(body?.endpoint || "");
    if (endpoint) await rtdb().ref(`pushSubs/${user.uid}/${subKey(endpoint)}`).remove();
    return res.status(200).json({ ok: true });
  }

  if (action === "sync-settings") {
    await rtdb().ref(`pushSettings/${user.uid}`).set({ ...sanitize(body?.settings), at: Date.now() });
    return res.status(200).json({ ok: true });
  }

  throw new HttpError(400, "BAD_ACTION", "use ?action=subscribe|unsubscribe|sync-settings");
});

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
