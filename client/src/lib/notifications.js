/**
 * In-site news/calendar alerts.
 *
 * Settings, "seen" markers and the notification log live in localStorage —
 * no server state needed. The AlertsEngine (mounted app-wide) polls
 * /api/news, diffs fresh items/events against the seen markers and fires
 * toasts + log entries. The Navbar bell renders the log.
 */
import { SYMBOLS } from "@/lib/news-api";
const SETTINGS_KEY = "inspire_alert_settings";
const SEEN_KEY = "inspire_alert_seen";
const CAL_SEEN_KEY = "inspire_alert_cal_seen";
const LOG_KEY = "inspire_alert_log";
const READ_KEY = "inspire_alerts_lastread";
export const ALERTS_CHANGED_EVENT = "inspire-alerts-changed";
export const ALERTS_SETTINGS_EVENT = "inspire-alert-settings";
export const DEFAULT_SETTINGS = {
    enabled: true,
    symbols: ["XAUUSD"],
    calEnabled: true,
    calCurrencies: ["USD"],
    browser: false,
};
function readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    }
    catch {
        return fallback;
    }
}
function writeJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        /* private mode / quota — alerts silently degrade */
    }
}
// ---- settings ----------------------------------------------------------------
export function loadAlertSettings() {
    const raw = readJson(SETTINGS_KEY, {});
    return {
        enabled: raw.enabled ?? DEFAULT_SETTINGS.enabled,
        symbols: Array.isArray(raw.symbols) ? raw.symbols.filter((s) => SYMBOLS.includes(s)) : DEFAULT_SETTINGS.symbols,
        calEnabled: raw.calEnabled ?? DEFAULT_SETTINGS.calEnabled,
        calCurrencies: Array.isArray(raw.calCurrencies) ? raw.calCurrencies : DEFAULT_SETTINGS.calCurrencies,
        browser: raw.browser ?? DEFAULT_SETTINGS.browser,
    };
}
export function saveAlertSettings(settings) {
    writeJson(SETTINGS_KEY, settings);
    window.dispatchEvent(new CustomEvent(ALERTS_SETTINGS_EVENT));
    void syncAlertStateToSW();
    // keep the server snapshot fresh so the cron pushes for the right symbols
    void syncPushSettings();
}
/**
 * Telegram-style OS/browser notification. Prefers the service worker's
 * showNotification (works for BACKGROUND tabs and on mobile) and falls back
 * to a page-scoped Notification when no SW is around.
 */
export async function browserNotify(title, body) {
    try {
        if (typeof Notification === "undefined")
            return;
        if (Notification.permission !== "granted")
            return;
        const options = { body: body.slice(0, 180), tag: title + body, icon: "/favicon.png" };
        const reg = await swRegistration();
        if (reg?.active) {
            await reg.showNotification(title, options);
            return;
        }
        const n = new Notification(title, options);
        n.onclick = () => { try {
            window.focus();
            n.close();
        }
        catch { /* ignore */ } };
    }
    catch { /* notifications unavailable — silent */ }
}
async function swRegistration() {
    try {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
            return null;
        return (await navigator.serviceWorker.getRegistration()) ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Mirror the alert state (settings + seen markers + language) into the
 * service worker's Cache API — the ONLY storage a background sync can read.
 * Called after every settings/seen change so the snapshot stays fresh.
 */
export async function syncAlertStateToSW() {
    try {
        const reg = await swRegistration();
        const sw = reg?.active ?? (typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null);
        if (!sw)
            return;
        sw.postMessage({
            type: "ALERT_STATE",
            state: {
                settings: loadAlertSettings(),
                newsSeen: [...getNewsSeen()].slice(-600),
                calSeen: [...getCalSeen()].slice(-200),
                language: localStorage.getItem("tj-language") || "en",
            },
        });
    }
    catch { /* SW unavailable — background alerts degrade to in-tab only */ }
}
/**
 * Register the periodic background sync (tag "inspire-news"). Chrome wakes
 * the service worker even when the site is closed — installed PWA users get
 * news/calendar notifications without the tab being open. No-op everywhere
 * the API is missing (only Chromium + installed PWA support it today).
 */
export async function enableBackgroundAlerts() {
    try {
        if (typeof Notification === "undefined" || Notification.permission !== "granted")
            return;
        const reg = await swRegistration();
        if (!reg)
            return;
        await syncAlertStateToSW();
        const ps = reg.periodicSync;
        if (ps)
            await ps.register("inspire-news", { minInterval: 12 * 60 * 60 * 1000 });
    }
    catch { /* periodicSync unsupported — in-tab alerts still work */ }
}
/** Ask the user for Notification permission; resolves to the final state. */
export function requestBrowserPermission() {
    try {
        if (typeof Notification === "undefined")
            return Promise.resolve("unsupported");
        if (Notification.permission === "granted")
            return Promise.resolve("granted");
        return Notification.requestPermission();
    }
    catch {
        return Promise.resolve("denied");
    }
}
// ---- web push (alerts arrive even when the site is closed) --------------------
function urlBase64ToUint8Array(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++)
        out[i] = raw.charCodeAt(i);
    return out;
}
function vapidKey() {
    const key = String(import.meta.env.VITE_VAPID_PUBLIC_KEY || "");
    return key ? key : null;
}
/** A web-push subscription exists for this browser? */
export async function isPushSubscribed() {
    try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window))
            return false;
        const reg = await swRegistration();
        return !!(await reg?.pushManager.getSubscription());
    }
    catch {
        return false;
    }
}
/**
 * Full web-push enable flow: permission → PushSubscription → register the
 * subscription + current alert settings on the server (api/push). The server
 * cron then delivers news/calendar/price alerts while the site is closed.
 */
export async function enableWebPush() {
    try {
        const key = vapidKey();
        if (!key)
            return { ok: false, reason: "no-vapid-key" };
        const perm = await requestBrowserPermission();
        if (perm !== "granted")
            return { ok: false, reason: perm };
        if (!("serviceWorker" in navigator) || !("PushManager" in window))
            return { ok: false, reason: "unsupported" };
        const reg = (await navigator.serviceWorker.ready) ?? (await swRegistration());
        if (!reg)
            return { ok: false, reason: "no-sw" };
        const existing = await reg.pushManager.getSubscription();
        const sub = existing ??
            (await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(key),
            }));
        const { authedFetch } = await import("./api");
        await authedFetch("/api/push?action=subscribe", { action: "subscribe", subscription: sub.toJSON(), settings: loadAlertSettings() });
        return { ok: true };
    }
    catch (err) {
        return { ok: false, reason: String(err?.message || "push-failed") };
    }
}
/** Remove this browser's subscription (server + browser). */
export async function disableWebPush() {
    try {
        const reg = await swRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
            const { authedFetch } = await import("./api");
            await authedFetch("/api/push?action=unsubscribe", { action: "unsubscribe", endpoint: sub.endpoint }).catch(() => { });
            await sub.unsubscribe().catch(() => { });
        }
    }
    catch { /* best effort */ }
}
/** Mirror the latest alert settings to the server (no-op when not subscribed). */
export async function syncPushSettings() {
    try {
        if (!(await isPushSubscribed()))
            return;
        const { authedFetch } = await import("./api");
        await authedFetch("/api/push?action=sync-settings", { action: "sync-settings", settings: loadAlertSettings() });
    }
    catch { /* settings sync is best-effort */ }
}
// ---- seen markers --------------------------------------------------------------
function loadSeen(key, cap) {
    const arr = readJson(key, []);
    return new Set(Array.isArray(arr) ? arr.slice(-cap) : []);
}
function saveSeen(key, seen, cap) {
    writeJson(key, Array.from(seen).slice(-cap));
}
export function getNewsSeen() {
    return loadSeen(SEEN_KEY, 600);
}
export function markNewsSeen(ids) {
    const seen = getNewsSeen();
    for (const id of ids)
        seen.add(id);
    saveSeen(SEEN_KEY, seen, 600);
    void syncAlertStateToSW();
}
export function getCalSeen() {
    return loadSeen(CAL_SEEN_KEY, 200);
}
export function markCalSeen(ids) {
    const seen = getCalSeen();
    for (const id of ids)
        seen.add(id);
    saveSeen(CAL_SEEN_KEY, seen, 200);
    void syncAlertStateToSW();
}
// ---- notification log -----------------------------------------------------------
const LOG_CAP = 30;
export function getAlertLog() {
    const log = readJson(LOG_KEY, []);
    return Array.isArray(log) ? log : [];
}
export function appendAlertLog(entry) {
    const log = getAlertLog();
    log.unshift({ ...entry, at: Date.now() });
    writeJson(LOG_KEY, log.slice(0, LOG_CAP));
    window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT));
}
export function clearAlertLog() {
    writeJson(LOG_KEY, []);
    window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT));
}
export function getUnreadCount() {
    const lastRead = readJson(READ_KEY, 0);
    return getAlertLog().filter((e) => e.at > lastRead).length;
}
export function markAllAlertsRead() {
    writeJson(READ_KEY, Date.now());
    window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT));
}
