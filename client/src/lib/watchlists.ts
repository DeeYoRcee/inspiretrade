/**
 * watchlists — multi-list instrument collections with favorites + recents
 * (Phase 21 spec §2). Device-local first (instant paint, works logged out),
 * RTDB `users/{uid}/watchlists` debounced 800ms, newest-savedAt-wins merge.
 * Symbols are always validated against the terminal catalog — a stale or
 * renamed symbol can never enter a list.
 */
import { useSyncExternalStore } from "react";
import { getDatabase, ref, get, update } from "firebase/database";
import { getInstrument } from "../../../shared/terminal.ts";

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface WatchlistsDoc {
  version: 1;
  savedAt: number;
  activeId: string;
  favorites: string[];
  recents: string[];
  lists: Watchlist[];
}

const MAX_LISTS = 20;
const MAX_SYMBOLS = 100;
const MAX_RECENTS = 12;
const MAX_NAME = 40;

export const DEFAULT_WATCHLISTS: WatchlistsDoc = {
  version: 1,
  savedAt: 0,
  activeId: "main",
  favorites: [],
  recents: [],
  lists: [{ id: "main", name: "Main", symbols: ["XAUUSD", "BTCUSD", "EURUSD"] }],
};

const LS_KEY = (uid: string | null) => `it_watchlists_${uid || "anon"}`;
const RTDB_PATH = (uid: string) => `users/${uid}/watchlists`;

const cleanSymbols = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((s) => typeof s === "string" && getInstrument(s))).values()].slice(0, max)
    : [];

/** test hook — the pure validator behind every read/write */
export const __sanitizeWatchlists = sanitize;

function sanitize(raw: unknown): WatchlistsDoc {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  let lists: Watchlist[] = Array.isArray(r.lists)
    ? r.lists
        .filter((l: any) => l && typeof l === "object" && typeof l.id === "string" && l.id.length <= 40)
        .slice(0, MAX_LISTS)
        .map((l: any) => ({
          id: String(l.id),
          name: String(l.name || "Watchlist").slice(0, MAX_NAME),
          symbols: cleanSymbols(l.symbols, MAX_SYMBOLS),
        }))
    : [];
  if (!lists.length) lists = DEFAULT_WATCHLISTS.lists.map((l) => ({ ...l, symbols: [...l.symbols] }));
  const ids = new Set(lists.map((l) => l.id));
  const activeId = typeof r.activeId === "string" && ids.has(r.activeId) ? r.activeId : lists[0].id;
  return {
    version: 1,
    savedAt: Number.isFinite(Number(r.savedAt)) ? Number(r.savedAt) : 0,
    activeId,
    favorites: cleanSymbols(r.favorites, MAX_SYMBOLS),
    recents: cleanSymbols(r.recents, MAX_RECENTS),
    lists,
  };
}

// store ---------------------------------------------------------------------

let current: WatchlistsDoc = DEFAULT_WATCHLISTS;
const listeners = new Set<() => void>();
let userUid: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loadToken = 0;

function notify() {
  listeners.forEach((l) => l());
}

function persistLocal() {
  try {
    localStorage.setItem(LS_KEY(userUid), JSON.stringify(current));
  } catch { /* private mode / quota */ }
}

function persistRemote() {
  if (!userUid) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await update(ref(getDatabase(), RTDB_PATH(userUid!)), { ...current, savedAt: Date.now() });
    } catch { /* offline — LS mirror stays authoritative */ }
  }, 800);
}

function commit(next: WatchlistsDoc, { remote = true } = {}) {
  current = next;
  persistLocal();
  if (remote) persistRemote();
  notify();
}

export async function setWatchlistsUser(uid: string | null) {
  if (userUid === uid) return;
  userUid = uid;
  const token = ++loadToken;
  let base: WatchlistsDoc = DEFAULT_WATCHLISTS;
  try {
    const raw = localStorage.getItem(LS_KEY(uid));
    if (raw) base = sanitize(JSON.parse(raw));
  } catch { /* corrupt → defaults */ }
  current = base;
  notify();
  if (!uid) { persistLocal(); return; }
  try {
    const snap = await get(ref(getDatabase(), RTDB_PATH(uid)));
    if (token !== loadToken) return;
    const remote = snap.val();
    if (remote && typeof remote === "object" && Number(remote.savedAt || 0) > current.savedAt) {
      current = sanitize(remote);
      persistLocal();
      notify();
    } else if (current.savedAt > 0) {
      persistRemote();
    }
  } catch { /* offline */ }
}

const newId = () => `wl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// public API ----------------------------------------------------------------

export function getWatchlists(): WatchlistsDoc {
  return current;
}

export function useWatchlists(): WatchlistsDoc {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

export function createList(name: string): string | null {
  const clean = String(name || "").trim().slice(0, MAX_NAME);
  if (!clean || current.lists.length >= MAX_LISTS) return null;
  const id = newId();
  commit({
    ...current,
    lists: [...current.lists, { id, name: clean, symbols: [] }],
    activeId: id,
    savedAt: Date.now(),
  });
  return id;
}

export function renameList(id: string, name: string) {
  const clean = String(name || "").trim().slice(0, MAX_NAME);
  if (!clean || !current.lists.some((l) => l.id === id)) return;
  commit({
    ...current,
    lists: current.lists.map((l) => (l.id === id ? { ...l, name: clean } : l)),
    savedAt: Date.now(),
  });
}

export function deleteList(id: string) {
  if (current.lists.length <= 1 || !current.lists.some((l) => l.id === id)) return;
  const lists = current.lists.filter((l) => l.id !== id);
  commit({
    ...current,
    lists,
    activeId: current.activeId === id ? lists[0].id : current.activeId,
    savedAt: Date.now(),
  });
}

export function setActiveList(id: string) {
  if (!current.lists.some((l) => l.id === id) || current.activeId === id) return;
  commit({ ...current, activeId: id, savedAt: Date.now() });
}

export function addToList(id: string, symbol: string) {
  const list = current.lists.find((l) => l.id === id);
  if (!list || !getInstrument(symbol) || list.symbols.includes(symbol)) return;
  const lists = current.lists.map((l) =>
    l.id === id ? { ...l, symbols: [...l.symbols, symbol].slice(0, MAX_SYMBOLS) } : l,
  );
  commit({ ...current, lists, savedAt: Date.now() });
}

export function removeFromList(id: string, symbol: string) {
  const list = current.lists.find((l) => l.id === id);
  if (!list || !list.symbols.includes(symbol)) return;
  const lists = current.lists.map((l) =>
    l.id === id ? { ...l, symbols: l.symbols.filter((s) => s !== symbol) } : l,
  );
  commit({ ...current, lists, savedAt: Date.now() });
}

/** Move a symbol within a list (drag-and-drop ordering). */
export function reorderList(id: string, from: number, to: number) {
  const list = current.lists.find((l) => l.id === id);
  if (!list || from < 0 || from >= list.symbols.length || to < 0 || to >= list.symbols.length || from === to) return;
  const symbols = [...list.symbols];
  const [moved] = symbols.splice(from, 1);
  symbols.splice(to, 0, moved);
  commit({
    ...current,
    lists: current.lists.map((l) => (l.id === id ? { ...l, symbols } : l)),
    savedAt: Date.now(),
  });
}

export function toggleFavorite(symbol: string) {
  if (!getInstrument(symbol)) return;
  const favorites = current.favorites.includes(symbol)
    ? current.favorites.filter((s) => s !== symbol)
    : [...current.favorites, symbol];
  commit({ ...current, favorites, savedAt: Date.now() });
}

/** Recently viewed instruments (capped, deduped, most-recent-first). */
export function touchRecent(symbol: string) {
  if (!getInstrument(symbol)) return;
  const recents = [symbol, ...current.recents.filter((s) => s !== symbol)].slice(0, MAX_RECENTS);
  commit({ ...current, recents, savedAt: Date.now() });
}
