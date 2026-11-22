/**
 * notification-center — PHASE 47 Part 2: ONE unified notification store.
 *
 * Categories: news · calendar · alert (trading alerts) · system.
 *
 * Sources merged in chronological order:
 *  · RTDB `notifications/{uid}` — the SYNCED store (server cron writes
 *    trading-alert triggers here; the client engine writes local detections).
 *    User-scoped rules; every device sees the same list.
 *  · localStorage alert log (notifications.ts) — the EXISTING device-local
 *    record that news/calendar AlertsEngine entries have always gone to.
 *    Pre-existing records stay readable (no migration, nothing overwritten).
 *
 * Read state: per-entry `readAt` for RTDB records; a global lastRead marker
 * for the legacy log (getUnreadCount semantics preserved).
 */
import { ref as dbRef, onValue, remove as dbRemove, update as dbUpdate } from "firebase/database";
import { db, auth } from "@/lib/firebase";
import { getAlertLog, type AlertLogEntry } from "@/lib/notifications";

export type NotifCategory = "news" | "calendar" | "alert" | "system";

export interface NotifItem {
  id: string;
  category: NotifCategory;
  title: string;
  body?: string;
  at: number;
  /** deep link — /news · /terminal?symbol=… · /wallet … */
  url?: string;
  symbol?: string;
  readAt?: number | null;
  /** synced (RTDB) vs local (legacy log) */
  source: "synced" | "local";
}

export const NOTIFS_CHANGED_EVENT = "inspire-notifications-changed";

// ---- legacy log bridging (existing records stay first-class) ------------------

function localLogToItems(): NotifItem[] {
  return getAlertLog().map((e: AlertLogEntry) => ({
    id: `local-${e.kind}-${e.id}-${e.at}`,
    category: (e.kind === "news" ? "news" : "calendar") as NotifCategory,
    title: e.title,
    symbol: e.symbol,
    at: e.at,
    url: e.kind === "news" || e.kind === "calendar" ? "/news" : "/terminal",
    source: "local" as const,
  }));
}

// ---- RTDB synced store ---------------------------------------------------------

let remoteItems: NotifItem[] = [];
let remoteReady = false;

function remoteValToItems(val: Record<string, any> | null): NotifItem[] {
  if (!val) return [];
  return Object.entries(val).map(([id, n]) => ({
    id,
    category: (["news", "calendar", "alert", "system"].includes(n?.category) ? n.category : "system") as NotifCategory,
    title: String(n?.title ?? ""),
    body: n?.body ? String(n.body) : undefined,
    at: Number(n?.at ?? 0),
    url: n?.url ? String(n.url) : undefined,
    symbol: n?.symbol ? String(n.symbol) : undefined,
    readAt: n?.readAt ?? null,
    source: "synced" as const,
  })).filter((n) => n.title && n.at > 0);
}

/** Live sync while signed in; no-op (local only) when signed out. */
export function subscribeNotificationCenter(cb: () => void): () => void {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    remoteItems = [];
    remoteReady = true;
    return () => {};
  }
  const r = dbRef(db, `notifications/${uid}`);
  const off = onValue(r, (snap) => {
    remoteItems = remoteValToItems(snap.val());
    remoteReady = true;
    cb();
  }, () => {
    // rules hiccup / offline — the local log still works
    remoteItems = [];
    remoteReady = true;
    cb();
  });
  return off;
}

/** Merged, newest-first view. Synced records win over legacy duplicates. */
export function getNotifItems(limit = 200): NotifItem[] {
  const merged = [...remoteItems, ...localLogToItems()];
  merged.sort((a, b) => b.at - a.at);
  // legacy log entries are also mirrored to RTDB by the engine — drop local
  // twins (same category+title+at-minute) so nothing shows twice
  const seenKey = new Set(remoteItems.map((n) => `${n.category}|${n.title}|${Math.floor(n.at / 60000)}`));
  const out: NotifItem[] = [];
  for (const n of merged) {
    if (n.source === "local" && seenKey.has(`${n.category}|${n.title}|${Math.floor(n.at / 60000)}`)) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export function getUnreadNotifCount(): number {
  // remote unread from per-entry readAt; the legacy local log's unread badge
  // is already covered by notifications.ts getUnreadCount() (bell merges both)
  return remoteItems.filter((n) => !n.readAt).length;
}

export async function markNotifRead(id: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  const item = remoteItems.find((n) => n.id === id);
  if (uid && item?.source === "synced") {
    await dbUpdate(dbRef(db, `notifications/${uid}/${id}`), { readAt: Date.now() }).catch(() => {});
  }
}

export async function markAllNotifsRead(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const patch: Record<string, number> = {};
  for (const n of remoteItems) if (!n.readAt) patch[`${n.id}/readAt`] = Date.now();
  if (Object.keys(patch).length) await dbUpdate(dbRef(db, `notifications/${uid}`), patch).catch(() => {});
}

export async function deleteNotif(id: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (uid && remoteItems.some((n) => n.id === id)) {
    await dbRemove(dbRef(db, `notifications/${uid}/${id}`)).catch(() => {});
  }
}

export async function clearNotifs(category?: NotifCategory): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const ids = remoteItems.filter((n) => !category || n.category === category).map((n) => n.id);
  for (const id of ids) await dbRemove(dbRef(db, `notifications/${uid}/${id}`)).catch(() => {});
}

/** Idempotent record write — id embeds the trigger identity so a re-run of
 *  the same condition (server cron + client engine) cannot duplicate. */
export async function pushSyncedNotif(entry: {
  id: string;
  category: NotifCategory;
  title: string;
  body?: string;
  url?: string;
  symbol?: string;
  at?: number;
}): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const id = entry.id.length > 700 ? entry.id.slice(0, 700) : entry.id;
  try {
    await dbUpdate(dbRef(db, `notifications/${uid}/${id}`), {
      category: entry.category,
      title: entry.title.slice(0, 200),
      body: entry.body?.slice(0, 400),
      url: entry.url,
      symbol: entry.symbol,
      at: entry.at ?? Date.now(),
      readAt: null,
    });
  } catch { /* rules/offline — the local log still records it */ }
}

/** Server cron namespaces its records so client writes can never collide. */
export function cronNotifId(alertId: string, triggerAt: number): string {
  return `srv-${alertId}-${triggerAt}`;
}
