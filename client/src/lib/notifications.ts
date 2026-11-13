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
    browser: raw.browser ?? DEFAULT_SETTINGS.browser,
  };
}

export function saveAlertSettings(settings: AlertSettings): void {
  writeJson(SETTINGS_KEY, settings);
  window.dispatchEvent(new CustomEvent(ALERTS_SETTINGS_EVENT));
}

/**
 * Telegram-style OS/browser notification. Works while any tab of the site is
 * open (web apps cannot push without a server sender-id; Vercel Hobby has no
 * cron budget for that — the 45s in-tab poller is the trigger).
 */
export function browserNotify(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body: body.slice(0, 180), tag: title + body, icon: "/favicon.ico" });
    n.onclick = () => { try { window.focus(); n.close(); } catch { /* ignore */ } };
  } catch { /* notifications unavailable — silent */ }
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
}

export function getCalSeen(): Set<string> {
  return loadSeen(CAL_SEEN_KEY, 200);
}

export function markCalSeen(ids: string[]): void {
  const seen = getCalSeen();
  for (const id of ids) seen.add(id);
  saveSeen(CAL_SEEN_KEY, seen, 200);
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
