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
import { get, onValue, ref as dbRef, remove, set, update } from "firebase/database";
import { auth, db } from "@/lib/firebase";
import { __sanitizeDrawingList, filterTombstonedDrawings } from "@/lib/drawings";
import { readFavoritesLocal, writeFavoritesLocal, MAX_FAVORITES } from "@/lib/drawing-favorites";
import { sanitizeGroups, type DrawingGroup } from "@/lib/drawing-tree";
import type { Drawing, FibLevel } from "@/lib/drawings";
import { sanitizeFibLevels } from "@/lib/drawings";
import { sanitizeIndicatorList } from "@/lib/indicators-config";
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
// P40 — write bookkeeping: per-child diffed uploads + deletion tombstones
// ---------------------------------------------------------------------------

/** last successfully-written child map per (uid|symbol) — the debounced
 *  writer diffs against it, so each commit uploads ONLY changed/deleted
 *  children instead of re-serializing the whole symbol's drawing set. */
const lastSavedDrawings = new Map<string, Map<string, Drawing>>();
/** deletion tombstones: id → deletion time (local time). A stale remote
 *  echo of a deleted drawing is suppressed until a NEWER edit appears. */
const drawingTombstones = new Map<string, Map<string, number>>();
const TOMBSTONE_TTL = 30 * 60 * 1000;

function drawingsKey(uid: string, symbol: string): string {
  return `${uid}|${symbol}`;
}

/** P40 — remember ids deleted locally so a stale remote echo cannot
 *  resurrect them (pruned after TTL; superseded by newer edits). */
export function recordDrawingTombstones(uid: string, symbol: string, ids: string[]): void {
  if (!ids.length) return;
  const map = drawingTombstones.get(drawingsKey(uid, symbol)) ?? new Map<string, number>();
  const now = Date.now();
  for (const id of ids) map.set(id, now);
  for (const [id, ts] of map) if (now - ts > TOMBSTONE_TTL) map.delete(id);
  drawingTombstones.set(drawingsKey(uid, symbol), map);
}

/** Fire any drawing write still sitting in the 400 ms debounce window
 *  (symbol switch / unmount): nothing is lost on the way out. */
export function flushPendingDrawingWrites(): void {
  for (const [key, timer] of [...pendingDrawingWrites]) {
    clearTimeout(timer);
    pendingDrawingWrites.delete(key);
    const job = pendingDrawingJobs.get(key);
    if (job) void job().catch(() => { /* offline — LS keeps it */ });
  }
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

export function subscribeDrawings(
  uid: string,
  symbol: string,
  cb: (drawings: Drawing[]) => void,
): () => void {
  const key = drawingsKey(uid, symbol);
  const cached = localGet<Record<string, Drawing>>(uid, "drawings", symbol);
  if (cached) cb(__sanitizeDrawingList(Object.values(cached)));
  const off = onValue(
    rtdb(`chart/${uid}/drawings/${symbol}`),
    (snap) => {
      const remote = snap.val() as Record<string, Drawing> | null;
      if (remote) {
        // Phase 35: sanitize remote snapshots — corrupted entries are dropped
        // and duplicates collapsed. No extra RTDB write here; the healed list
        // is persisted to RTDB with the user's next edit.
        const list = __sanitizeDrawingList(Object.values(remote));
        // P40 — a stale echo of a locally-deleted drawing must not resurrect
        const tombs: Record<string, number> = Object.fromEntries(drawingTombstones.get(key) ?? []);
        const kept = filterTombstonedDrawings(list, tombs);
        cb(kept);
        localSet(uid, "drawings", symbol, Object.fromEntries(kept.map((d) => [d.id, d])));
        // the debounce diff is computed against what RTDB actually holds
        lastSavedDrawings.set(key, new Map(kept.map((d) => [d.id, d])));
      } else {
        // the new symbol has NO stored drawings — clear the previous
        // symbol's list instead of leaving it on the chart (isolation)
        cb([]);
        lastSavedDrawings.set(key, new Map());
      }
    },
    (err) => console.warn("[chart] drawing listener error (LS mirror active):", err),
  );
  return () => off();
}

/** Phase 37 §5 — one RTDB write per burst: the property bar commits style
 *  changes per slider tick, so remote writes coalesce on a 400 ms trailing
 *  debounce. localStorage stays immediate (sync + cheap) and clearDrawings
 *  cancels a pending save so it can never resurrect deleted drawings. */
const pendingDrawingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDrawingJobs = new Map<string, () => Promise<void>>();

export function saveDrawings(uid: string, symbol: string, drawings: Drawing[]): void {
  const map = Object.fromEntries(drawings.map((d) => [d.id, d]));
  localSet(uid, "drawings", symbol, map);
  const key = drawingsKey(uid, symbol);
  const job = () => writeDrawingsMap(uid, symbol, map);
  const prev = pendingDrawingWrites.get(key);
  if (prev) clearTimeout(prev);
  pendingDrawingWrites.set(key, setTimeout(() => {
    pendingDrawingWrites.delete(key);
    pendingDrawingJobs.delete(key);
    job().catch((err) => console.warn("[chart] drawing save failed — kept in localStorage:", err));
  }, 400));
  pendingDrawingJobs.set(key, job);
}

/** P40 — upload ONLY the children that changed or were deleted since the
 *  last successful write (multi-path update with null deletes), never the
 *  whole map. Offline failures keep the LS mirror and are retried with the
 *  user's next edit. */
async function writeDrawingsMap(uid: string, symbol: string, map: Record<string, Drawing>): Promise<void> {
  const path = `chart/${uid}/drawings/${symbol}`;
  const last = lastSavedDrawings.get(drawingsKey(uid, symbol));
  if (!last) {
    await set(rtdb(path), map);
  } else {
    const updates: Record<string, Drawing | null> = {};
    for (const [id, d] of Object.entries(map)) {
      const old = last.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(d)) updates[`${path}/${id}`] = d;
    }
    for (const id of last.keys()) if (!(id in map)) updates[`${path}/${id}`] = null;
    if (Object.keys(updates).length) await update(rtdb("/"), updates);
  }
  lastSavedDrawings.set(drawingsKey(uid, symbol), new Map(Object.entries(map)));
}

// ---------------------------------------------------------------------------
// Drawing templates — named snapshots of a drawing set, reusable on any symbol
// ---------------------------------------------------------------------------

export interface DrawingTemplate { name: string; drawings: Drawing[]; savedAt: number }

export function saveDrawingTemplate(uid: string, name: string, drawings: Drawing[]): void {
  const tpl: DrawingTemplate = { name, drawings, savedAt: Date.now() };
  try {
    const raw = localStorage.getItem(`it_chart_templates_${uid}`);
    const map = raw ? (JSON.parse(raw) as Record<string, DrawingTemplate>) : {};
    map[name] = tpl;
    localStorage.setItem(`it_chart_templates_${uid}`, JSON.stringify(map));
  } catch { /* quota — RTDB still gets it */ }
  void set(rtdb(`chart/${uid}/templates/${name}`), tpl).catch(() => { /* LS covers it */ });
}

export async function loadDrawingTemplates(uid: string): Promise<DrawingTemplate[]> {
  try {
    const snap = await get(rtdb(`chart/${uid}/templates`));
    const map = (snap.val() || {}) as Record<string, DrawingTemplate>;
    const remote = Object.values(map);
    if (remote.length) return remote;
  } catch { /* offline / rules — fall through to LS */ }
  try {
    const raw = localStorage.getItem(`it_chart_templates_${uid}`);
    return raw ? Object.values(JSON.parse(raw) as Record<string, DrawingTemplate>) : [];
  } catch { return []; }
}

export function deleteDrawingTemplate(uid: string, name: string): void {
  try {
    const raw = localStorage.getItem(`it_chart_templates_${uid}`);
    if (raw) {
      const map = JSON.parse(raw) as Record<string, DrawingTemplate>;
      delete map[name];
      localStorage.setItem(`it_chart_templates_${uid}`, JSON.stringify(map));
    }
  } catch { /* ignore */ }
  void remove(rtdb(`chart/${uid}/templates/${name}`)).catch(() => { /* ignore */ });
}

export function clearDrawings(uid: string, symbol: string): void {
  const key = drawingsKey(uid, symbol);
  const prev = pendingDrawingWrites.get(key);
  if (prev) { clearTimeout(prev); pendingDrawingWrites.delete(key); }
  pendingDrawingJobs.delete(key);
  localDel(uid, "drawings", symbol);
  lastSavedDrawings.delete(key); // next save does a full set, not a diff
  void remove(rtdb(`chart/${uid}/drawings/${symbol}`)).catch(() => { /* ignore */ });
}

















// ---------------------------------------------------------------------------
// P41 — the global chart look (candle colors, chart type, grid…) syncs to
// RTDB as well: it used to be localStorage-only, so a fresh browser or a
// logout/login lost the user's candle colors even though drawings survived.
// ---------------------------------------------------------------------------

const pendingChartSettingsWrites = new Map<string, ReturnType<typeof setTimeout>>();

export function saveChartSettingsCloud(uid: string, cfg: Record<string, unknown>): void {
  if (!uid) return;
  const key = `chartSettings|${uid}`;
  const prev = pendingChartSettingsWrites.get(key);
  if (prev) clearTimeout(prev);
  pendingChartSettingsWrites.set(key, setTimeout(() => {
    pendingChartSettingsWrites.delete(key);
    void set(rtdb(`users/${uid}/chartSettings`), { ...cfg, savedAt: Date.now() })
      .catch((err) => console.warn("[chart] settings save failed:", err));
  }, 500));
}

// ---------------------------------------------------------------------------
// P42 — object tree GROUPS per chart: `chart/{uid}/groups/{symbol}` +
// LS mirror (LS-first paint). Groups are metadata only — the member states
// (hidden/locked/group id) live on the drawings themselves, so nothing here
// needs tombstones: a stale remote just re-sends the same small record.
// ---------------------------------------------------------------------------

const pendingGroupWrites = new Map<string, ReturnType<typeof setTimeout>>();

export function subscribeGroups(uid: string, symbol: string, cb: (groups: Record<string, DrawingGroup>) => void): () => void {
  try {
    const raw = localStorage.getItem(`it_chart_groups_${uid}_${symbol}`);
    if (raw) {
      const g = sanitizeGroups(JSON.parse(raw));
      if (Object.keys(g).length) cb(g);
    }
  } catch { /* private mode */ }
  if (!uid) return () => {};
  return onValue(
    rtdb(`chart/${uid}/groups/${symbol}`),
    (snap) => {
      const val = snap.val() as Record<string, unknown> | null;
      const clean = val && typeof val === "object" ? sanitizeGroups(val) : {};
      cb(clean);
      try { localStorage.setItem(`it_chart_groups_${uid}_${symbol}`, JSON.stringify(clean)); } catch { /* private mode */ }
    },
    (err) => console.warn("[chart] groups listener error (LS mirror active):", err),
  );
}

export function saveGroups(uid: string, symbol: string, groups: Record<string, DrawingGroup>): void {
  try { localStorage.setItem(`it_chart_groups_${uid}_${symbol}`, JSON.stringify(groups)); } catch { /* private mode */ }
  if (!uid) return;
  const key = `groups|${uid}|${symbol}`;
  const prev = pendingGroupWrites.get(key);
  if (prev) clearTimeout(prev);
  pendingGroupWrites.set(key, setTimeout(() => {
    pendingGroupWrites.delete(key);
    void set(rtdb(`chart/${uid}/groups/${symbol}`), groups)
      .catch((err) => console.warn("[chart] groups save failed — kept in localStorage:", err));
  }, 400));
}

export async function loadChartSettingsCloud(uid: string): Promise<Record<string, unknown> | null> {
  try {
    const snap = await get(rtdb(`users/${uid}/chartSettings`));
    const val = snap.val() as Record<string, unknown> | null;
    return val && typeof val === "object" ? val : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// P41 §2 — favorites: RTDB `chart/{uid}/favorites` (owner-only rules) with
// the LS mirror for the first paint; the pure toggle/reorder logic lives in
// drawing-favorites.ts and is unit-tested.
// ---------------------------------------------------------------------------

export function saveFavorites(uid: string, list: string[]): void {
  writeFavoritesLocal(uid, list);
  if (!uid) return; // anonymous → localStorage only
  void set(rtdb(`chart/${uid}/favorites`), list.slice(0, MAX_FAVORITES))
    .catch((err) => console.warn("[chart] favorites save failed — kept in localStorage:", err));
}

export function subscribeFavorites(uid: string, cb: (list: string[]) => void): () => void {
  const cached = readFavoritesLocal(uid);
  if (cached.length) cb(cached);
  if (!uid) return () => {};
  return onValue(
    dbRef(db, `chart/${uid}/favorites`),
    (snap) => {
      const val = snap.val();
      const list = Array.isArray(val)
        ? [...new Set(val.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, MAX_FAVORITES)
        : [];
      cb(list);
      writeFavoritesLocal(uid, list);
    },
    (err) => console.warn("[chart] favorites listener error (LS mirror active):", err),
  );
}

/** P40 — drop this user's chart localStorage mirrors (logout hygiene). */
export function clearChartLocalCache(uid: string): void {
  if (!uid) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("it_chart_") && k.includes(`_${uid}_`)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Phase 37 §2/§5 — custom Fibonacci presets: a named level list reusable on
// any fib drawing, per user, RTDB + LS mirror like drawing templates.
// ---------------------------------------------------------------------------

export interface FibPreset { name: string; tool: string; levels: FibLevel[]; savedAt: number }

export function saveFibPreset(uid: string, name: string, tool: string, levels: FibLevel[]): void {
  const preset: FibPreset = { name, tool, levels, savedAt: Date.now() };
  try {
    const raw = localStorage.getItem(`it_chart_fibpresets_${uid}`);
    const map = raw ? (JSON.parse(raw) as Record<string, FibPreset>) : {};
    map[name] = preset;
    localStorage.setItem(`it_chart_fibpresets_${uid}`, JSON.stringify(map));
  } catch { /* quota — RTDB still gets it */ }
  void set(rtdb(`chart/${uid}/fib-presets/${name}`), preset).catch(() => { /* LS covers it */ });
}

export async function loadFibPresets(uid: string): Promise<FibPreset[]> {
  try {
    const snap = await get(rtdb(`chart/${uid}/fib-presets`));
    const map = (snap.val() || {}) as Record<string, FibPreset>;
    const remote = Object.values(map);
    if (remote.length) return remote;
  } catch { /* offline / rules — fall through to LS */ }
  try {
    const raw = localStorage.getItem(`it_chart_fibpresets_${uid}`);
    return raw ? Object.values(JSON.parse(raw) as Record<string, FibPreset>) : [];
  } catch { return []; }
}

export function deleteFibPreset(uid: string, name: string): void {
  try {
    const raw = localStorage.getItem(`it_chart_fibpresets_${uid}`);
    if (raw) {
      const map = JSON.parse(raw) as Record<string, FibPreset>;
      delete map[name];
      localStorage.setItem(`it_chart_fibpresets_${uid}`, JSON.stringify(map));
    }
  } catch { /* ignore */ }
  void remove(rtdb(`chart/${uid}/fib-presets/${name}`)).catch(() => { /* ignore */ });
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export function subscribeIndicators(
  uid: string,
  symbol: string,
  cb: (indicators: IndicatorConfig[]) => void,
): () => void {
  // Phase 36: validate snapshots like drawings — unknown types are dropped,
  // params clamped into catalog ranges, duplicate ids collapsed.
  const cached = localGet<Record<string, IndicatorConfig>>(uid, "indicators", symbol);
  if (cached) cb(sanitizeIndicatorList(Object.values(cached)));
  const off = onValue(
    rtdb(`chart/${uid}/indicators/${symbol}`),
    (snap) => {
      const remote = snap.val() as Record<string, IndicatorConfig> | null;
      // null must CLEAR too (like subscribeDrawings): switching to an
      // instrument with no stored indicators otherwise keeps the previous
      // instrument's configs active over the new bars
      const list = remote ? sanitizeIndicatorList(Object.values(remote)) : [];
      cb(list);
      if (remote) localSet(uid, "indicators", symbol, Object.fromEntries(list.map((i) => [i.id, i])));
    },
    (err) => console.warn("[chart] indicator listener error (LS mirror active):", err),
  );
  return () => off();
}

export function saveIndicators(uid: string, symbol: string, indicators: IndicatorConfig[]): void {
  const map = Object.fromEntries(indicators.map((i) => [i.id, i]));
  localSet(uid, "indicators", symbol, map);
  void set(rtdb(`chart/${uid}/indicators/${symbol}`), map).catch(() => { /* LS covers it */ });
}

/** Phase 36 §6 — Remove All Indicators: clears the LS mirror + RTDB node. */
export function clearIndicators(uid: string, symbol: string): void {
  localDel(uid, "indicators", symbol);
  void remove(rtdb(`chart/${uid}/indicators/${symbol}`)).catch(() => { /* LS covers it */ });
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
