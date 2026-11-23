/**
 * GET  /api/alerts-cron — system cron endpoint (Vercel Cron / external pinger).
 * POST /api/push        — web-push registration, REWRITTEN here (vercel.json):
 * both live in ONE serverless function because Vercel Hobby caps at 12.
 *
 * Server-side alert evaluation + WEB PUSH delivery (the fix for "notifications
 * only arrive when I open the site"):
 *  - "price" (above/below) and "dailyHL" (prev-day H/L breakout) alerts,
 *  - news items in the user's picked symbols,
 *  - high-impact calendar events in the picked currencies (30-min window).
 * Indicator alerts (RSI/MACD/EMA/BB) and drawing-based alerts stay client-side
 * — they need full OHLC history / user drawings.
 *
 * Delivery: web-push to every registered browser (subscriptions in
 * pushSubs/{uid}, settings in pushSettings/{uid}). Requires VAPID_PUBLIC_KEY +
 * VAPID_PRIVATE_KEY env vars; without them the run still evaluates state but
 * cannot deliver.
 *
 * Reliability: NO user session; every active alert of every user is checked on
 * each invocation with a per-alert cooldown (default 60 min). Trigger state
 * (lastTriggeredAt + history ring, max 20) is written back to the same RTDB
 * node the client reads, so client and server evaluations de-duplicate against
 * each other. News/calendar seen-markers live in pushSeen/{uid} (RTDB) so a
 * story never notifies twice.
 *
 * Protection: when CRON_SECRET is set, the GET (cron) requests must carry
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron does this natively —
 * external pingers like cron-job.org must add the same header). POST
 * (push registration) always requires a signed-in user instead.
 */
// web-push must be a STATIC import: Vercel's dependency tracer only follows
// static imports — loading it via createRequire/require() leaves the package
// out of the lambda and the function 500s at runtime (locally it resolves from
// node_modules, which is why it only broke in production). esbuild inlines the
// CJS package into the bundled output.
import * as webpush from "web-push";
import { rtdb, handle, requireUser, assertPost, HttpError } from "./lib/firebase";
import { runTradingCron } from "./trading/cron";
import { rateLimit } from "./lib/rate-limit";
import { INSTRUMENTS, getInstrument } from "../../shared/terminal";
import { collectNewsCron } from "./news/index";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

interface Job { uid: string; id: string; a: any }

const VAPID_SUBJECT = "mailto:support@inspiretrade.app";

function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/** Send one push to every browser of a user; prune dead subscriptions. */
async function sendPush(uid: string, payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  if (!pushConfigured()) return 0;
  const snap = await rtdb().ref(`pushSubs/${uid}`).once("value");
  const subs = snap.val() || {};
  let sent = 0;
  await Promise.allSettled(Object.entries<any>(subs).map(async ([key, row]) => {
    if (!row?.sub?.endpoint) return;
    try {
      await webpush.sendNotification(row.sub, JSON.stringify(payload), { vapidDetails: { subject: VAPID_SUBJECT, publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! } });
      sent++;
    } catch (err: any) {
      // 404/410 = the browser no longer knows this subscription — drop it
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await rtdb().ref(`pushSubs/${uid}/${key}`).remove().catch(() => {});
      }
    }
  }));
  return sent;
}

function asSet(arr: any): Set<string> {
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

// ---- POST /api/push (rewritten here) — push subscription registration ------

function subKey(endpoint: string): string {
  return Buffer.from(endpoint).toString("base64url").slice(0, 120);
}

function sanitizeSettings(s: any) {
  return {
    enabled: !!s?.enabled,
    symbols: Array.isArray(s?.symbols) ? s.symbols.slice(0, 20).map(String) : [],
    calEnabled: !!s?.calEnabled,
    calCurrencies: Array.isArray(s?.calCurrencies) ? s.calCurrencies.slice(0, 12).map(String) : [],
    // PHASE 47 — additive category flags (missing = previous behavior = on)
    tradingAlerts: s?.tradingAlerts !== false,
    systemNotifs: s?.systemNotifs !== false,
  };
}

/** PHASE 47 Part 2 — record every server-side delivery in the unified,
 *  synced notification store so the site shows what was pushed while closed.
 *  Idempotent: the id embeds the trigger identity (idempotentNotification). */
async function recordNotification(uid: string, id: string, n: { category: string; title: string; body?: string; url?: string; symbol?: string }): Promise<void> {
  try {
    await rtdb().ref(`notifications/${uid}/${id}`).update({
      category: n.category,
      title: String(n.title || "").slice(0, 200),
      body: n.body ? String(n.body).slice(0, 400) : null,
      url: n.url || null,
      symbol: n.symbol || null,
      at: Date.now(),
      readAt: null,
    });
  } catch { /* notification record is best-effort — the push already went out */ }
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function pushRegistration(req: any, res: any): Promise<void> {
  assertPost(req);
  const user = await requireUser(req);
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  // action from the query string OR the body (rewrite-proof)
  let action = String(body?.action || "");
  if (!action) {
    try {
      action = String(new URL(req.url || "/", "http://localhost").searchParams.get("action") || "");
    } catch { /* fall through to BAD_ACTION */ }
  }

  // PHASE 62 §9 + support-chat fix — the support inbox relay. The deployed
  // RTDB rules are older than the repo's database.rules.json (the admin must
  // publish them), so direct client writes to supportInbox/{uid} fail with
  // PERMISSION_DENIED; the server (admin SDK) is never denied. These actions
  // make sending/reading support messages work regardless of the rules state.
  if (action === "support-send") {
    const text = String(body?.text || "").trim().slice(0, 300);
    if (!text) throw new HttpError(400, "EMPTY_MESSAGE", "Message text is required");
    if (!rateLimit(`${user.uid}:support-send`, 5, 60_000)) {
      throw new HttpError(429, "RATE_LIMITED", "Too many messages — try again in a minute");
    }
    const msg: Record<string, unknown> = {
      uid: user.uid,
      name: String(body?.name || "User").slice(0, 60),
      text,
      from: "user",
      at: Date.now(),
    };
    if (body?.username) msg.username = String(body.username).slice(0, 20);
    const ref = rtdb().ref(`supportInbox/${user.uid}`);
    const pushed = await ref.push(msg);
    // self-check (PHASE 62): read back the SAME key — proves the write is
    // visible in the database this instance talks to (surfaces any env/URL
    // mismatch immediately instead of a silent loss)
    const back = await ref.child(String(pushed.key)).get();
    res.status(200).json({ ok: true, key: pushed.key, verified: back.exists(), at: msg.at });
    return;
  }
  if (action === "support-history") {
    // PHASE 62: full snapshot + in-code tail (the limitToLast query variant
    // returned an empty set even for verified writes — root cause never
    // fully isolated; a plain get() is the reliable path and these mailboxes
    // are small)
    const snap = await rtdb().ref(`supportInbox/${user.uid}`).get();
    const data = (snap.val() || {}) as Record<string, unknown>;
    const keys = Object.keys(data).sort().slice(-100);
    const messages: Record<string, unknown> = {};
    for (const k of keys) messages[k] = data[k];
    res.status(200).json({ ok: true, messages, existed: snap.exists() });
    return;
  }

  if (action === "subscribe") {
    const endpoint = String(body?.subscription?.endpoint || "");
    if (!endpoint.startsWith("https://")) {
      throw new HttpError(400, "INVALID_SUBSCRIPTION", "subscription.endpoint (https) is required");
    }
    await rtdb()
      .ref(`pushSubs/${user.uid}/${subKey(endpoint)}`)
      .set({ sub: body.subscription, at: Date.now() });
    if (body.settings && typeof body.settings === "object") {
      await rtdb().ref(`pushSettings/${user.uid}`).set({ ...sanitizeSettings(body.settings), at: Date.now() });
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (action === "unsubscribe") {
    const endpoint = String(body?.endpoint || "");
    if (endpoint) await rtdb().ref(`pushSubs/${user.uid}/${subKey(endpoint)}`).remove();
    res.status(200).json({ ok: true });
    return;
  }

  if (action === "sync-settings") {
    await rtdb().ref(`pushSettings/${user.uid}`).set({ ...sanitizeSettings(body?.settings), at: Date.now() });
    res.status(200).json({ ok: true });
    return;
  }

  throw new HttpError(400, "BAD_ACTION", "use ?action=subscribe|unsubscribe|sync-settings");
}

export default handle(async (req, res) => {
  // the browser registers/updates its push subscription here (POST /api/push)
  if ((req.method || "").toUpperCase() === "POST") return pushRegistration(req, res);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== secret) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  // PHASE 62 §3 — the daily Vercel cron is the guaranteed catch-up floor:
  // evaluate every account's SL/TP/pending/stop-out/swap/challenge rules
  // server-side at least once a day, even with no external scheduler wired.
  let tradingCron: Awaited<ReturnType<typeof runTradingCron>> | { ok: false; error: string } | null = null;
  try {
    tradingCron = await runTradingCron(60_000); // this function has no user latency budget
  } catch (e) {
    tradingCron = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const pushOn = pushConfigured();
  if (pushOn) {
    try { webpush.setVapidDetails(VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!); } catch { /* push disabled this run */ }
  }

  const settingsCache = await rtdb().ref("pushSettings").once("value").then((snap: any) => (snap.val() || {}) as Record<string, any>).catch(() => ({} as Record<string, any>));
  const snap = await rtdb().ref("terminalAlerts").once("value");
  const all = snap.val() || {}; // { uid: { alertId: alert } }

  const jobs: Job[] = [];
  const cryptoNeeded = new Set<string>();
  const yahooNeeded = new Set<string>();
  const yahooDailyNeeded = new Set<string>();
  const spotNeeded = new Set<string>();

  for (const [uid, alerts] of Object.entries<any>(all)) {
    const prefs = settingsCache[uid] || {};
    for (const [id, a] of Object.entries<any>(alerts || {})) {
      if (!a || a.paused || a.done) continue;
      const kind = a.kind ?? "price";
      if (kind !== "price" && kind !== "dailyHL") continue;
      if (kind === "price" && a.price == null) continue;
      // PHASE 47 — expired alerts never fire again; the user can disable
      // trading alerts per category without touching the records
      if (a.expiresAt && Date.now() > a.expiresAt) continue;
      if (prefs.tradingAlerts === false) continue;
      const last = a.lastTriggeredAt || a.triggeredAt || 0;
      if (Date.now() - last < (a.cooldownMin ?? 60) * 60000) continue;
      jobs.push({ uid, id, a });
      const inst = getInstrument(a.symbol);
      if (!inst) continue;
      if (inst.feed === "binance" && inst.binance) {
        cryptoNeeded.add(inst.binance);
        if (kind === "dailyHL") cryptoNeeded.add(inst.binance); // 1d kline below
      } else if (inst.spotCode) {
        // Phase 18: metals alerts evaluate against the genuine gold-api SPOT
        // price — the same source the chart and the execution engine use.
        // GC=F (a COMEX futures contract with its own price/delay) must never
        // decide a spot-metal alert.
        spotNeeded.add(inst.spotCode);
        if (kind === "dailyHL") {
          // previous-day range comes from the futures daily bar (gold-api has
          // no OHLC history) — a disclosed futures basis, never the spot price
          yahooNeeded.add(inst.yahoo!);
        }
      } else if (inst.yahoo) {
        yahooNeeded.add(inst.yahoo);
        if (kind === "dailyHL") yahooDailyNeeded.add(inst.yahoo);
      }
    }
  }

  const prices = new Map<string, number>();       // by instrument symbol
  const prevDay = new Map<string, { high: number; low: number }>();

  // metals spot prices (gold-api — the chart/execution source)
  if (spotNeeded.size) {
    await Promise.allSettled([...spotNeeded].map(async (code) => {
      const r = await fetch(`https://api.gold-api.com/price/${code}`);
      if (!r.ok) return;
      const d: any = await r.json();
      const p = Number(d?.price);
      if (!Number.isFinite(p) || p <= 0) return;
      const inst = INSTRUMENTS.find((i) => i.spotCode === code);
      if (inst) prices.set(inst.symbol, p);
    }));
  }

  // crypto spot prices + previous day H/L (1d klines, real data)
  if (cryptoNeeded.size) {
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify([...cryptoNeeded]))}`;
      const arr: any[] = await (await fetch(url)).json();
      for (const row of arr) {
        const inst = INSTRUMENTS.find((i) => i.binance === row.symbol);
        if (inst) prices.set(inst.symbol, +row.price);
      }
    } catch { /* crypto prices unavailable this run */ }
  }
  for (const bin of new Set([...cryptoNeeded])) {
    try {
      const inst = INSTRUMENTS.find((i) => i.binance === bin);
      if (!inst || ![...jobs].some((j) => j.a.symbol === inst.symbol && (j.a.kind ?? "price") === "dailyHL")) continue;
      const kl: any[] = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${bin}&interval=1d&limit=3`)).json();
      const prev = kl.length >= 2 ? kl[kl.length - 2] : null;
      if (prev) prevDay.set(inst.symbol, { high: +prev[2], low: +prev[3] });
    } catch { /* daily bars unavailable */ }
  }

  // yahoo quotes (batch, same pattern as the /api/quotes proxy) + daily H/L
  if (yahooNeeded.size) {
    await Promise.allSettled([...yahooNeeded].map(async (sym) => {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) return;
      const data: any = await r.json();
      const result = data?.chart?.result?.[0];
      const meta = result?.meta || {};
      const inst = INSTRUMENTS.find((i) => i.yahoo === sym);
      // Phase 18: spot metals keep their gold-api price — a futures meta price
      // (GC=F/SI=F) must never overwrite it; the futures feed only contributes
      // the previous-day range for dailyHL (a different instrument, disclosed)
      if (inst && !inst.spotCode && meta.regularMarketPrice != null) prices.set(inst.symbol, meta.regularMarketPrice);
      const ts: number[] = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0] || {};
      if (inst && ts.length >= 2) {
        // second-to-last COMPLETED daily bar = previous day
        for (let i = ts.length - 2; i >= 0; i--) {
          const h = q.high?.[i], l = q.low?.[i];
          if (h != null && l != null && Number.isFinite(h) && Number.isFinite(l)) {
            prevDay.set(inst.symbol, { high: h, low: l });
            break;
          }
        }
      }
    }));
  }

  let fired = 0;
  let pushed = 0;
  const now = Date.now();
  for (const job of jobs) {
    const kind: string = job.a.kind ?? "price";
    const price = prices.get(job.a.symbol);
    if (price == null) continue;
    let hit = false;
    if (kind === "price") {
      hit = job.a.direction === "above" ? price >= job.a.price : price <= job.a.price;
    } else if (kind === "dailyHL") {
      const hl = prevDay.get(job.a.symbol);
      if (hl) hit = job.a.direction === "above" ? price >= hl.high : price <= hl.low;
    }
    if (!hit) continue;
    fired++;
    const history = [...(Array.isArray(job.a.history) ? job.a.history : []), { at: now, price }].slice(-20);
    await rtdb().ref(`terminalAlerts/${job.uid}/${job.id}`).update({
      lastTriggeredAt: now,
      lastPrice: price,
      history,
      // PHASE 47 — "only once" alerts pause themselves after the first trigger
      ...(job.a.frequency === "once" ? { paused: true, done: true } : {}),
    });
    const dir = job.a.direction === "above" ? "crossed above" : "dropped to";
    const title = String(job.a.message || `${job.a.symbol} ${kind === "dailyHL" ? "daily level" : "alert"}`).slice(0, 120);
    const body = `${job.a.symbol} ${dir} ${job.a.price} — now ${price}`;
    await recordNotification(job.uid, `srv-${job.id}-${now}`, { category: "alert", title, body, url: `/terminal?symbol=${encodeURIComponent(job.a.symbol)}`, symbol: job.a.symbol });
    if (pushOn) {
      pushed += await sendPush(job.uid, {
        title,
        body,
        url: `/terminal?symbol=${encodeURIComponent(job.a.symbol)}`,
        tag: `alert-${job.uid}-${job.id}`,
      });
    }
  }

  // ---- news + calendar push (same rules as the in-tab AlertsEngine) --------
  let newsPushed = 0;
  let calPushed = 0;
  if (pushOn) {
    try {
      const [{ items, calendar, ok }, subsSnap, settingsSnap, seenSnap] = await Promise.all([
        collectNewsCron(),
        rtdb().ref("pushSubs").once("value"),
        rtdb().ref("pushSettings").once("value"),
        rtdb().ref("pushSeen").once("value"),
      ]);
      const subsByUid = subsSnap.val() || {};
      const settingsByUid = settingsSnap.val() || {};
      const seenByUid = seenSnap.val() || {};
      const seenUpdates: Record<string, any> = {};

      for (const uid of Object.keys(subsByUid)) {
        const s = settingsByUid[uid] || {};
        if (!s.enabled || !Array.isArray(s.symbols) || !s.symbols.length) continue;
        const seen = seenByUid[uid] || {};
        const newsSeen = asSet(seen.news);
        const calSeen = asSet(seen.cal);
        const updates: any = {};

        const fresh = items.filter(
          (i) => !newsSeen.has(i.link) && now - i.publishedAt < 45 * 60 * 1000 && i.symbols.some((sym) => s.symbols.includes(sym)),
        ).slice(0, 3);
        for (const item of fresh) {
          const syms = item.symbols.filter((sym) => s.symbols.includes(sym)).join(" · ");
          await recordNotification(uid, `srv-news-${Buffer.from(item.link).toString("base64url").slice(0, 80)}`, { category: "news", title: String(item.title || "").slice(0, 180), url: "/news", symbol: item.symbols[0] });
          newsPushed += await sendPush(uid, { title: syms || "News", body: String(item.title || "").slice(0, 180), url: "/news", tag: item.link });
          updates[item.link] = now;
        }

        if (ok && s.calEnabled && Array.isArray(s.calCurrencies) && s.calCurrencies.length) {
          const soon = calendar.filter(
            (e: any) => e.impact === "High" && s.calCurrencies.includes(e.currency) && !calSeen.has(e.id) && e.date > now && e.date - now <= 30 * 60 * 1000,
          ).slice(0, 2);
          for (const ev of soon) {
            const mins = Math.max(1, Math.round((ev.date - now) / 60000));
            await recordNotification(uid, `srv-cal-${ev.id}`, { category: "calendar", title: `${ev.currency} — ${mins} min`, body: String(ev.title || "").slice(0, 180), url: "/news", symbol: ev.currency });
            calPushed += await sendPush(uid, { title: `${ev.currency} — ${mins} min`, body: String(ev.title || "").slice(0, 180), url: "/news", tag: ev.id });
            updates[ev.id] = now;
          }
        }

        if (Object.keys(updates).length) {
          // merge into the per-uid seen maps, newest last, capped
          const mergedNews = [...Object.entries(seen.news || {}).map(([k, v]) => [k, v]), ...Object.entries(updates)]
            .slice(-400);
          const mergedCal = [...Object.entries(seen.cal || {}).map(([k, v]) => [k, v]), ...Object.entries(updates)]
            .slice(-200);
          seenUpdates[`pushSeen/${uid}/news`] = Object.fromEntries(mergedNews);
          seenUpdates[`pushSeen/${uid}/cal`] = Object.fromEntries(mergedCal);
        }
      }
      if (Object.keys(seenUpdates).length) await rtdb().ref().update(seenUpdates);
    } catch { /* news push unavailable this run — price alerts already delivered */ }
  }

  return res.status(200).json({ ok: true, evaluated: jobs.length, fired, pushed, newsPushed, calPushed, pushConfigured: pushOn, tradingCron });
});
