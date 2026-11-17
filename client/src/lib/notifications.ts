/**
 * In-site news/calendar alerts.
 *
 * Settings, "seen" markers and the notification log live in localStorage —
 * no server state needed. The AlertsEngine (mounted app-wide) polls
 * /api/news, diffs fresh items/events against the seen markers and fires
 * toasts + log entries. The Navbar bell renders the log.
 */

import { SYMBOLS } from "@/lib/news-api";

export type AlertKind = "news" | "calendar";

export interface AlertLogEntry {
  id: string;
  kind: AlertKind;
  symbol?: string;
  title: string;
  at: number;
}

export interface AlertSettings {
  enabled: boolean;
  symbols: string[];
  calEnabled: boolean;
  calCurrencies: string[];
  /** minutes before a matching high-impact event the alert fires (Phase 5: configurable) */
  calMinutesBefore: number;
  /** Telegram-style browser notifications (Notification API) */
  browser: boolean;
}

const SETTINGS_KEY = "inspire_alert_settings";
const SEEN_KEY = "inspire_alert_seen";
const CAL_SEEN_KEY = "inspire_alert_cal_seen";
const LOG_KEY = "inspire_alert_log";
const READ_KEY = "inspire_alerts_lastread";

export const ALERTS_CHANGED_EVENT = "inspire-alerts-changed";
export const ALERTS_SETTINGS_EVENT = "inspire-alert-settings";

export const DEFAULT_SETTINGS: AlertSettings = {
  enabled: true,
  symbols: ["XAUUSD"],
  calEnabled: true,
  calCurrencies: ["USD"],
  calMinutesBefore: 30,
  browser: false,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — alerts silently degrade */
  }
}

// ---- settings ----------------------------------------------------------------

export function loadAlertSettings(): AlertSettings {
  const raw = readJson<Partial<AlertSettings>>(SETTINGS_KEY, {});
  return {
    enabled: raw.enabled ?? DEFAULT_SETTINGS.enabled,
    symbols: Array.isArray(raw.symbols) ? raw.symbols.filter((s) => (SYMBOLS as readonly string[]).includes(s)) : DEFAULT_SETTINGS.symbols,
    calEnabled: raw.calEnabled ?? DEFAULT_SETTINGS.calEnabled,
    calCurrencies: Array.isArray(raw.calCurrencies) ? raw.calCurrencies : DEFAULT_SETTINGS.calCurrencies,
    calMinutesBefore: [5, 15, 30, 60].includes(Number(raw.calMinutesBefore)) ? Number(raw.calMinutesBefore) : DEFAULT_SETTINGS.calMinutesBefore,
    browser: raw.browser ?? DEFAULT_SETTINGS.browser,
  };
}

export function saveAlertSettings(settings: AlertSettings): void {
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
export async function browserNotify(title: string, body: string): Promise<void> {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const options: NotificationOptions = { body: body.slice(0, 180), tag: title + body, icon: "/favicon.png" };
    const reg = await swRegistration();
    if (reg?.active) {
      await reg.showNotification(title, options);
      return;
    }
    const n = new Notification(title, options);
    n.onclick = () => { try { window.focus(); n.close(); } catch { /* ignore */ } };
  } catch { /* notifications unavailable — silent */ }
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Mirror the alert state (settings + seen markers + language) into the
 * service worker's Cache API — the ONLY storage a background sync can read.
 * Called after every settings/seen change so the snapshot stays fresh.
 */
export async function syncAlertStateToSW(): Promise<void> {
  try {
    const reg = await swRegistration();
    const sw = reg?.active ?? (typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null);
    if (!sw) return;
    sw.postMessage({
      type: "ALERT_STATE",
      state: {
        settings: loadAlertSettings(),
        newsSeen: [...getNewsSeen()].slice(-600),
        calSeen: [...getCalSeen()].slice(-200),
        language: localStorage.getItem("tj-language") || "en",
      },
    });
  } catch { /* SW unavailable — background alerts degrade to in-tab only */ }
}

/**
 * Register the periodic background sync (tag "inspire-news"). Chrome wakes
 * the service worker even when the site is closed — installed PWA users get
 * news/calendar notifications without the tab being open. No-op everywhere
 * the API is missing (only Chromium + installed PWA support it today).
 */
export async function enableBackgroundAlerts(): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const reg = await swRegistration();
    if (!reg) return;
    await syncAlertStateToSW();
    const ps = (reg as unknown as { periodicSync?: { register: (tag: string, o: { minInterval: number }) => Promise<void> } }).periodicSync;
    if (ps) await ps.register("inspire-news", { minInterval: 12 * 60 * 60 * 1000 });
  } catch { /* periodicSync unsupported — in-tab alerts still work */ }
}

/** Ask the user for Notification permission; resolves to the final state. */
export function requestBrowserPermission(): Promise<string> {
  try {
    if (typeof Notification === "undefined") return Promise.resolve("unsupported");
    if (Notification.permission === "granted") return Promise.resolve("granted");
    return Notification.requestPermission();
  } catch {
    return Promise.resolve("denied");
  }
}

// ---- web push (alerts arrive even when the site is closed) --------------------

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function vapidKey(): string | null {
  const key = String(import.meta.env.VITE_VAPID_PUBLIC_KEY || "");
  return key ? key : null;
}

/** A web-push subscription exists for this browser? */
export async function isPushSubscribed(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    const reg = await swRegistration();
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Full web-push enable flow: permission → PushSubscription → register the
 * subscription + current alert settings on the server (api/push). The server
 * cron then delivers news/calendar/price alerts while the site is closed.
 */
export async function enableWebPush(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const key = vapidKey();
    if (!key) return { ok: false, reason: "no-vapid-key" };
    const perm = await requestBrowserPermission();
    if (perm !== "granted") return { ok: false, reason: perm };
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return { ok: false, reason: "unsupported" };
    const reg = (await navigator.serviceWorker.ready) ?? (await swRegistration());
    if (!reg) return { ok: false, reason: "no-sw" };
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
      }));
    const { authedFetch } = await import("./api");
    await authedFetch("/api/push?action=subscribe", { action: "subscribe", subscription: sub.toJSON(), settings: loadAlertSettings() });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message || "push-failed") };
  }
}

/** Remove this browser's subscription (server + browser). */
export async function disableWebPush(): Promise<void> {
  try {
    const reg = await swRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const { authedFetch } = await import("./api");
      await authedFetch("/api/push?action=unsubscribe", { action: "unsubscribe", endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* best effort */ }
}

/** Mirror the latest alert settings to the server (no-op when not subscribed). */
export async function syncPushSettings(): Promise<void> {
  try {
    if (!(await isPushSubscribed())) return;
    const { authedFetch } = await import("./api");
    await authedFetch("/api/push?action=sync-settings", { action: "sync-settings", settings: loadAlertSettings() });
  } catch { /* settings sync is best-effort */ }
}

// ---- seen markers --------------------------------------------------------------

function loadSeen(key: string, cap: number): Set<string> {
  const arr = readJson<string[]>(key, []);
  return new Set(Array.isArray(arr) ? arr.slice(-cap) : []);
}

function saveSeen(key: string, seen: Set<string>, cap: number): void {
  writeJson(key, Array.from(seen).slice(-cap));
}

export function getNewsSeen(): Set<string> {
  return loadSeen(SEEN_KEY, 600);
}

export function markNewsSeen(ids: string[]): void {
  const seen = getNewsSeen();
  for (const id of ids) seen.add(id);
  saveSeen(SEEN_KEY, seen, 600);
  void syncAlertStateToSW();
}

export function getCalSeen(): Set<string> {
  return loadSeen(CAL_SEEN_KEY, 200);
}

export function markCalSeen(ids: string[]): void {
  const seen = getCalSeen();
  for (const id of ids) seen.add(id);
  saveSeen(CAL_SEEN_KEY, seen, 200);
  void syncAlertStateToSW();
}

// ---- custom per-event alerts (Phase 5: "bell" any calendar row) ---------------

export interface EventAlert {
  id: string; // `${eventId}#${minutesBefore}`
  eventId: string;
  title: string;
  currency: string;
  date: number; // epoch ms of the release
  minutesBefore: number;
}

const EVENT_ALERTS_KEY = "inspire_event_alerts";
const EVENT_ALERTS_FIRED_KEY = "inspire_event_alerts_fired";

export function loadEventAlerts(): EventAlert[] {
  const raw = readJson<EventAlert[]>(EVENT_ALERTS_KEY, []);
  return Array.isArray(raw) ? raw.filter((a) => a && a.id && a.date > 0) : [];
}

export function saveEventAlerts(alerts: EventAlert[]): void {
  writeJson(EVENT_ALERTS_KEY, alerts.slice(0, 40));
  window.dispatchEvent(new CustomEvent(ALERTS_SETTINGS_EVENT));
}

export function addEventAlert(alert: Omit<EventAlert, "id">): void {
  const alerts = loadEventAlerts().filter((a) => a.id !== `${alert.eventId}#${alert.minutesBefore}`);
  alerts.push({ ...alert, id: `${alert.eventId}#${alert.minutesBefore}` });
  saveEventAlerts(alerts);
}

export function removeEventAlert(id: string): void {
  saveEventAlerts(loadEventAlerts().filter((a) => a.id !== id));
}

function loadFiredEventKeys(): Set<string> {
  const raw = readJson<string[]>(EVENT_ALERTS_FIRED_KEY, []);
  return new Set(Array.isArray(raw) ? raw : []);
}

function markFiredEventKeys(keys: Set<string>): void {
  writeJson(EVENT_ALERTS_FIRED_KEY, [...keys].slice(-200));
}

/** Due custom alerts = not yet fired, inside their window, event still ahead. */
export function dueCustomEventAlerts(now = Date.now()): { alert: EventAlert; key: string }[] {
  const alerts = loadEventAlerts();
  const fired = loadFiredEventKeys();
  const out: { alert: EventAlert; key: string }[] = [];
  for (const alert of alerts) {
    const key = alert.id;
    if (fired.has(key)) continue;
    const windowStart = alert.date - alert.minutesBefore * 60000;
    if (now >= windowStart && now < alert.date + 60000) out.push({ alert, key });
  }
  // prune stale entries (event > 24h past and fired) to keep storage tidy
  if (alerts.some((a) => a.date < now - 86400000)) {
    saveEventAlerts(alerts.filter((a) => a.date >= now - 86400000 || !fired.has(a.id)));
    const keep = new Set([...fired].filter((k) => alerts.find((a) => a.id === k && a.date >= now - 86400000)));
    markFiredEventKeys(keep);
  }
  return out;
}

export function markCustomEventFired(key: string): void {
  const fired = loadFiredEventKeys();
  fired.add(key);
  markFiredEventKeys(fired);
}

// ---- notification log -----------------------------------------------------------

const LOG_CAP = 30;

export function getAlertLog(): AlertLogEntry[] {
  const log = readJson<AlertLogEntry[]>(LOG_KEY, []);
  return Array.isArray(log) ? log : [];
}

export function appendAlertLog(entry: Omit<AlertLogEntry, "at">): void {
  const log = getAlertLog();
  log.unshift({ ...entry, at: Date.now() });
  writeJson(LOG_KEY, log.slice(0, LOG_CAP));
  window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT));
}

export function clearAlertLog(): void {
  writeJson(LOG_KEY, []);
  window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT));
}

export function getUnreadCount(): number {
  const lastRead = readJson<number>(READ_KEY, 0);
  return getAlertLog().filter((e) => e.at > lastRead).length;
}

export function markAllAlertsRead(): void {
  writeJson(READ_KEY, Date.now());
  window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT));
}
