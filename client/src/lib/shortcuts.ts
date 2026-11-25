/**
 * shortcuts — P55 §11: the terminal keyboard-shortcut registry.
 *
 * Pure module (node --test loadable): default bindings, capture/normalize
 * helpers, conflict detection, and persistence (localStorage mirror + RTDB
 * `users/{uid}/prefs/shortcuts` debounced 400ms — same pattern as
 * instrument-settings). A binding is "ctrl+k", "shift+alt+b", "d" — modifier
 * combos only for letters to keep plain typing safe.
 */

export type ShortcutAction =
  | "buy" | "sell" | "openTicket" | "openWatchlist" | "openAlerts"
  | "toggleStayDrawing" | "undo" | "redo" | "fullscreen" | "crosshair";

export interface ShortcutDef {
  action: ShortcutAction;
  label: string;
  hint: string;
  /** the default binding; "" = no default (must be customized first) */
  def: string;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { action: "buy", label: "Market Buy", hint: "Place a market buy on the ticket's instrument", def: "shift+b" },
  { action: "sell", label: "Market Sell", hint: "Place a market sell on the ticket's instrument", def: "shift+s" },
  // P78 — default unbound: "t" is the trend-line tool's chart shortcut, and
  // the chart handler always won this race (the ticket binding never fired).
  // Remappable in Settings → Shortcuts if a user prefers the ticket.
  { action: "openTicket", label: "Order ticket", hint: "Open the right-rail order ticket", def: "" },
  { action: "openWatchlist", label: "Watchlist", hint: "Open the right-rail watchlist", def: "w" },
  { action: "openAlerts", label: "Alerts", hint: "Open the right-rail alerts panel", def: "alt+a" },
  { action: "toggleStayDrawing", label: "Stay in drawing mode", hint: "Toggle whether the drawing tool stays armed", def: "" },
  { action: "undo", label: "Undo drawing", hint: "Undo the last chart drawing change", def: "ctrl+z" },
  { action: "redo", label: "Redo drawing", hint: "Redo a previously undone drawing change", def: "ctrl+y" },
  { action: "fullscreen", label: "Fullscreen chart", hint: "Toggle the chart fullscreen", def: "" },
  { action: "crosshair", label: "Cross cursor", hint: "Activate the cross cursor", def: "" },
];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> =
  Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.action, d.def])) as Record<ShortcutAction, string>;

const LS_KEY = "it_shortcuts_v1";

/** normalize "CTRL+K" / "K+ctrl" → "ctrl+k" (modifiers sorted, key lowercase) */
export function normalizeBinding(raw: string): string {
  const parts = raw.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const mods = parts.filter((p) => ["ctrl", "alt", "shift", "meta"].includes(p)).sort();
  const keys = parts.filter((p) => !["ctrl", "alt", "shift", "meta"].includes(p));
  if (keys.length !== 1) return "";
  return [...mods, keys[0]].join("+");
}

/** pretty label for the UI: "ctrl+k" → "Ctrl+K" */
export function formatBinding(b: string): string {
  return normalizeBinding(b).split("+").map((p) =>
    p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1),
  ).join("+");
}

/** does a KeyboardEvent match a normalized binding? (caller must exclude inputs) */
export function matchesShortcut(e: KeyboardEvent, binding: string): boolean {
  const b = normalizeBinding(binding);
  if (!b) return false;
  const mods = b.split("+").slice(0, -1);
  const key = b.split("+").at(-1)!;
  const wantCtrl = mods.includes("ctrl");
  const wantAlt = mods.includes("alt");
  const wantShift = mods.includes("shift");
  const wantMeta = mods.includes("meta");
  if (!!e.ctrlKey !== wantCtrl || !!e.altKey !== wantAlt || !!e.shiftKey !== wantShift || !!e.metaKey !== wantMeta) return false;
  return e.key.toLowerCase() === key;
}

/** two bindings conflict when they normalize to the same non-empty string */
export function findConflicts(bindings: Record<string, string>): string[][] {
  const by = new Map<string, string[]>();
  for (const [action, raw] of Object.entries(bindings)) {
    const b = normalizeBinding(raw);
    if (!b) continue;
    by.set(b, [...(by.get(b) ?? []), action]);
  }
  return [...by.values()].filter((list) => list.length > 1);
}

/** user overrides (only DIFFERENT-from-default entries are stored) */
export function loadShortcuts(): Record<ShortcutAction, string> {
  const out = { ...DEFAULT_SHORTCUTS };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<ShortcutAction, string>>;
      for (const [k, v] of Object.entries(saved)) {
        if (k in out && typeof v === "string") out[k as ShortcutAction] = normalizeBinding(v);
      }
    }
  } catch { /* private mode */ }
  return out;
}

export function saveShortcuts(bindings: Record<ShortcutAction, string>): void {
  const diffs: Partial<Record<ShortcutAction, string>> = {};
  for (const d of SHORTCUT_DEFS) {
    if (normalizeBinding(bindings[d.action] ?? "") !== normalizeBinding(d.def)) diffs[d.action] = normalizeBinding(bindings[d.action] ?? "");
  }
  try {
    if (Object.keys(diffs).length) localStorage.setItem(LS_KEY, JSON.stringify(diffs));
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode */ }
}

/** RTDB sync (debounced) — mirrors the instrument-settings persistence pattern */
export function bindShortcutSync(
  uid: string | null,
  apply: (b: Record<ShortcutAction, string>) => void,
): () => void {
  if (!uid) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = "";
  void import("firebase/database").then(({ getDatabase, ref, get, onValue }) => {
    void import("@/lib/firebase").then(() => {
      const r = ref(getDatabase(), `users/${uid}/prefs/shortcuts`);
      void get(r).then((snap) => {
        if (snap.exists()) {
          const remote = snap.val() as Partial<Record<ShortcutAction, string>>;
          apply({ ...loadShortcuts(), ...Object.fromEntries(Object.entries(remote).filter(([, v]) => typeof v === "string")) } as Record<ShortcutAction, string>);
        }
      }).catch(() => { /* offline → local only */ });
      onValue(r, (snap) => {
        if (!snap.exists()) return;
        const remote = snap.val() as Partial<Record<ShortcutAction, string>>;
        const json = JSON.stringify(remote);
        if (json === last) return; // echo of our own write
        last = json;
        apply({ ...loadShortcuts(), ...Object.fromEntries(Object.entries(remote).filter(([, v]) => typeof v === "string")) } as Record<ShortcutAction, string>);
      }, () => { /* permission/offline */ });
    }).catch(() => { /* firebase unavailable */ });
  }).catch(() => { /* firebase unavailable */ });
  return () => { if (timer) clearTimeout(timer); };
}

export function pushShortcutsToRtdb(uid: string, bindings: Record<ShortcutAction, string>): void {
  void import("firebase/database").then(({ getDatabase, ref, set }) => {
    void import("@/lib/firebase").then(() => {
      const diffs: Partial<Record<ShortcutAction, string>> = {};
      for (const d of SHORTCUT_DEFS) {
        if (normalizeBinding(bindings[d.action] ?? "") !== normalizeBinding(d.def)) diffs[d.action] = normalizeBinding(bindings[d.action] ?? "");
      }
      void set(ref(getDatabase(), `users/${uid}/prefs/shortcuts`), diffs);
    }).catch(() => { /* offline → LS only */ });
  }).catch(() => { /* offline → LS only */ });
}
