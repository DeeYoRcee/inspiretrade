/**
 * Chart persistence — drawings, indicators and named layouts per user in
 * Firebase Realtime Database, with a localStorage mirror so the chart looks
 * identical on the very first paint (RTDB round-trip ~100ms+).
 *
 * Paths (readable only via the user's auth — see firestore/RTDB rules):
 *   chart/{uid}/drawings/{symbol}   → { [id]: Drawing }
 *   chart/{uid}/indicators/{symbol} → { [id]: IndicatorConfig }
 *   chart/{uid}/layouts             → { [name]: LayoutSnapshot }
 */
import { get, onValue, ref as dbRef, remove, set } from "firebase/database";
import { auth, db } from "@/lib/firebase";
import type { Drawing } from "@/lib/drawings";
import type { IndicatorConfig } from "@/lib/indicators-config";

export interface LayoutSnapshot {
  symbol: string;
  timeframe: string;
  indicators: IndicatorConfig[];
  settings: Record<string, unknown>;
  savedAt: number;
}

const LS_KEY = (uid: string, kind: string, symbol: string) => `it_chart_${kind}_${uid}_${symbol}`;

function localGet<T>(uid: string, kind: string, symbol: string): T | null {
  try {
    const raw = localStorage.getItem(LS_KEY(uid, kind, symbol));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

function localSet(uid: string, kind: string, symbol: string, value: unknown): void {
  try { localStorage.setItem(LS_KEY(uid, kind, symbol), JSON.stringify(value)); } catch { /* quota — ignore */ }
}

function localDel(uid: string, kind: string, symbol: string): void {
  try { localStorage.removeItem(LS_KEY(uid, kind, symbol)); } catch { /* ignore */ }
}

const uidOf = (): string | null => auth.currentUser?.uid ?? null;
const rtdb = (path: string) => dbRef(db, path);

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

export function subscribeDrawings(
  uid: string,
  symbol: string,
  cb: (drawings: Drawing[]) => void,
): () => void {
  const cached = localGet<Record<string, Drawing>>(uid, "drawings", symbol);
  if (cached) cb(Object.values(cached));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = (list: Drawing[]) => {
    const map = Object.fromEntries(list.map((d) => [d.id, d]));
    localSet(uid, "drawings", symbol, map);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void set(rtdb(`chart/${uid}/drawings/${symbol}`), map).catch(() => { /* offline — LS keeps it */ });
    }, 350);
  };
  const off = onValue(
    rtdb(`chart/${uid}/drawings/${symbol}`),
    (snap) => {
      const remote = snap.val() as Record<string, Drawing> | null;
      if (remote && Object.keys(remote).length >= 0) {
        cb(Object.values(remote));
        localSet(uid, "drawings", symbol, remote);
      }
    },
    () => { /* rules/offline — LS only */ },
  );
  return () => { if (timer) clearTimeout(timer); off(); };
}

export function saveDrawings(uid: string, symbol: string, drawings: Drawing[]): void {
  const map = Object.fromEntries(drawings.map((d) => [d.id, d]));
  localSet(uid, "drawings", symbol, map);
  void set(rtdb(`chart/${uid}/drawings/${symbol}`), map).catch(() => { /* LS covers it */ });
}

export function clearDrawings(uid: string, symbol: string): void {
  localDel(uid, "drawings", symbol);
  void remove(rtdb(`chart/${uid}/drawings/${symbol}`)).catch(() => { /* ignore */ });
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export function subscribeIndicators(
  uid: string,
  symbol: string,
  cb: (indicators: IndicatorConfig[]) => void,
): () => void {
  const cached = localGet<Record<string, IndicatorConfig>>(uid, "indicators", symbol);
  if (cached) cb(Object.values(cached));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = (list: IndicatorConfig[]) => {
    const map = Object.fromEntries(list.map((i) => [i.id, i]));
    localSet(uid, "indicators", symbol, map);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void set(rtdb(`chart/${uid}/indicators/${symbol}`), map).catch(() => { /* offline */ });
    }, 350);
  };
  const off = onValue(
    rtdb(`chart/${uid}/indicators/${symbol}`),
    (snap) => {
      const remote = snap.val() as Record<string, IndicatorConfig> | null;
      if (remote) {
        cb(Object.values(remote));
        localSet(uid, "indicators", symbol, remote);
      }
    },
    () => { /* rules/offline — LS only */ },
  );
  return () => { if (timer) clearTimeout(timer); off(); };
}

export function saveIndicators(uid: string, symbol: string, indicators: IndicatorConfig[]): void {
  const map = Object.fromEntries(indicators.map((i) => [i.id, i]));
  localSet(uid, "indicators", symbol, map);
  void set(rtdb(`chart/${uid}/indicators/${symbol}`), map).catch(() => { /* LS covers it */ });
}

// ---------------------------------------------------------------------------
// Layouts (named snapshots)
// ---------------------------------------------------------------------------

export async function loadLayouts(uid: string): Promise<Record<string, LayoutSnapshot>> {
  const snap = await get(rtdb(`chart/${uid}/layouts`));
  return (snap.val() as Record<string, LayoutSnapshot>) ?? {};
}

export async function saveLayout(uid: string, name: string, snapshot: Omit<LayoutSnapshot, "savedAt">): Promise<void> {
  await set(rtdb(`chart/${uid}/layouts/${name}`), { ...snapshot, savedAt: Date.now() });
}

export async function deleteLayout(uid: string, name: string): Promise<void> {
  await remove(rtdb(`chart/${uid}/layouts/${name}`));
}
