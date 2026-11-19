/**
 * terminal-settings — the unified GLOBAL terminal settings store (Phase 21).
 *
 * Design rules (spec §8):
 *  · stable keys, validated values, safe handling of missing/corrupt data
 *  · device-local first (localStorage, immediate) + RTDB sync (debounced,
 *    newest-savedAt-wins so two devices converge instead of fighting)
 *  · one-time migration seeds defaults from the scattered legacy keys the
 *    terminal already persisted — it never runs again after first save
 *  · per-INSTRUMENT preferences live in instrument-settings.ts, never here
 *
 * Chart-section and notifications-section preferences keep their existing
 * homes (it_chart_settings / it_chart_scale / it_cursor_mode and
 * inspire_alert_settings — audited in Phase 21); this store owns what had no
 * persistent home: trading defaults (lot/risk/confirm/one-click/sound),
 * appearance (font size/density/backdrop) and general (default symbol/tf,
 * timezone, number format).
 */
import { useSyncExternalStore } from "react";
import { getDatabase, ref, get, update } from "firebase/database";
import { getInstrument } from "../../../shared/terminal.ts";

export type TimeframeValue = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1W" | "1M";
const TFS: TimeframeValue[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];

export interface TerminalSettings {
  version: 1;
  savedAt: number;
  general: {
    defaultSymbol: string;
    defaultTf: TimeframeValue;
    /** IANA zone or "" (= the browser's zone) */
    timezone: string;
    numberFormat: "plain" | "grouped";
  };
  appearance: {
    /** base UI font size px (12-16), applied to the terminal shell */
    fontSize: number;
    density: "compact" | "cozy";
    /** animated theme backdrops (money/f1/knight videos) on/off */
    themeBackdrop: boolean;
  };
  trading: {
    defaultLot: string;
    defaultRisk: string;
    confirmOrders: boolean;
    oneClick: boolean;
    entrySoundOnOrder: boolean;
    defaultOrderType: "market" | "limit";
  };
}

export const TERMINAL_SETTINGS_VERSION = 1;

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  version: 1,
  savedAt: 0,
  general: { defaultSymbol: "BTCUSD", defaultTf: "5m", timezone: "", numberFormat: "plain" },
  appearance: { fontSize: 16, density: "compact", themeBackdrop: true },
  trading: { defaultLot: "0.10", defaultRisk: "1", confirmOrders: true, oneClick: false, entrySoundOnOrder: false, defaultOrderType: "market" },
};

// ---------------------------------------------------------------------------
// sanitize — every read passes through this; corrupt shapes fall back to
// defaults field-by-field instead of crashing the terminal
// ---------------------------------------------------------------------------

const asStr = (v: unknown, fallback: string, max = 40): string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v : fallback;
const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const asNum = (v: unknown, fallback: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const asEnum = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const asLot = (v: unknown, fallback: string): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? String(n) : fallback;
};
/** risk is a PERCENT — 0 < n ≤ 100, anything else falls back */
const asRisk = (v: unknown, fallback: string): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100 ? String(n) : fallback;
};

/** test hook — the pure validator behind every read/write */
export const __sanitizeTerminalSettings = sanitize;

function sanitize(raw: unknown): TerminalSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const g = (r.general && typeof r.general === "object" ? r.general : {}) as Record<string, any>;
  const a = (r.appearance && typeof r.appearance === "object" ? r.appearance : {}) as Record<string, any>;
  const t = (r.trading && typeof r.trading === "object" ? r.trading : {}) as Record<string, any>;
  const symbol = asStr(g.defaultSymbol, DEFAULT_TERMINAL_SETTINGS.general.defaultSymbol, 20);
  return {
    version: 1,
    savedAt: asNum(r.savedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    general: {
      // only catalog symbols count as a default — otherwise BTCUSD
      defaultSymbol: getInstrument(symbol) ? symbol : DEFAULT_TERMINAL_SETTINGS.general.defaultSymbol,
      defaultTf: asEnum<TimeframeValue>(g.defaultTf, TFS, DEFAULT_TERMINAL_SETTINGS.general.defaultTf),
      timezone: asStr(g.timezone, "", 64),
      numberFormat: asEnum(g.numberFormat, ["plain", "grouped"] as const, "plain"),
    },
    appearance: {
      fontSize: asNum(a.fontSize, DEFAULT_TERMINAL_SETTINGS.appearance.fontSize, 12, 16),
      density: asEnum(a.density, ["compact", "cozy"] as const, "compact"),
      themeBackdrop: asBool(a.themeBackdrop, true),
    },
    trading: {
      defaultLot: asLot(t.defaultLot, DEFAULT_TERMINAL_SETTINGS.trading.defaultLot),
      defaultRisk: asRisk(t.defaultRisk, DEFAULT_TERMINAL_SETTINGS.trading.defaultRisk),
      confirmOrders: asBool(t.confirmOrders, true),
      oneClick: asBool(t.oneClick, false),
      entrySoundOnOrder: asBool(t.entrySoundOnOrder, false),
      defaultOrderType: asEnum(t.defaultOrderType, ["market", "limit"] as const, "market"),
    },
  };
}

// ---------------------------------------------------------------------------
// one-time migration from the legacy scattered keys (only when no settings
// exist anywhere yet — never clobbers a saved state)
// ---------------------------------------------------------------------------

function migrateLegacy(): TerminalSettings | null {
  try {
    const ls = (k: string) => localStorage.getItem(k);
    const tf = ls("it_terminal_tf");
    const sym = ls("it_terminal_symbol");
    const cursor = ls("it_cursor_mode");
    const econ = ls("it_econ_warn");
    let econConfirm: boolean | null = null;
    try {
      const e = econ ? JSON.parse(econ) : null;
      if (e && typeof e === "object" && typeof e.confirmTrades === "boolean") econConfirm = e.confirmTrades;
    } catch { /* corrupt legacy value — ignore */ }
    const seeded = sanitize({
      general: { defaultSymbol: sym || undefined, defaultTf: tf || undefined },
      trading: { confirmOrders: econConfirm === null ? undefined : !econConfirm },
    });
    // nothing meaningful persisted → don't create a migration artifact
    if (sym === null && tf === null && econConfirm === null) return null;
    return seeded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// store — listeners + cached snapshot + LS/RTDB persistence
// ---------------------------------------------------------------------------

const LS_KEY = (uid: string | null) => `it_terminal_settings_${uid || "anon"}`;
const RTDB_PATH = (uid: string) => `users/${uid}/terminalSettings`;

let current: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;
let snapshotListeners = new Set<() => void>();
let userUid: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loadToken = 0;

function notify() {
  snapshotListeners.forEach((l) => l());
}

function persistLocal() {
  try {
    localStorage.setItem(LS_KEY(userUid), JSON.stringify(current));
  } catch { /* private mode / quota — memory store still works */ }
}

function persistRemote() {
  if (!userUid) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const db = getDatabase();
      await update(ref(db, RTDB_PATH(userUid!)), { ...current, savedAt: Date.now() });
    } catch { /* offline / rules — device-local copy stays authoritative */ }
  }, 800);
}

function commit(next: TerminalSettings, { remote = true } = {}) {
  current = next;
  persistLocal();
  if (remote) persistRemote();
  notify();
}

/**
 * Wire the store to a signed-in user: load the remote copy once (the newer
 * savedAt wins), switch the LS mirror, and start debounced remote writes.
 * Call with null on logout — device-local copy keeps working.
 */
export async function setTerminalSettingsUser(uid: string | null) {
  if (userUid === uid) return;
  userUid = uid;
  const token = ++loadToken;
  // device-local copy first (instant paint, works offline)
  let base: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;
  try {
    const raw = localStorage.getItem(LS_KEY(uid));
    if (raw) base = sanitize(JSON.parse(raw));
  } catch { /* corrupt JSON → defaults */ }
  // first-ever load with no LS copy → seed from the legacy scattered keys
  if (!localStorage.getItem(LS_KEY(uid))) {
    const migrated = migrateLegacy();
    if (migrated) base = migrated;
  }
  current = base;
  notify();
  if (!uid) { persistLocal(); return; }
  try {
    const db = getDatabase();
    const snap = await get(ref(db, RTDB_PATH(uid)));
    if (token !== loadToken) return; // user switched mid-flight
    const remote = snap.val();
    if (remote && typeof remote === "object" && Number(remote.savedAt || 0) > current.savedAt) {
      current = sanitize(remote);
      persistLocal();
      notify();
    } else if (current.savedAt > 0) {
      persistRemote(); // push the local copy once
    }
  } catch { /* offline — device-local copy stays */ }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function getTerminalSettings(): TerminalSettings {
  return current;
}

/** deep partial patch (one level of section nesting) */
export type TerminalSettingsPatch = {
  [K in keyof Omit<TerminalSettings, "version" | "savedAt">]?: Partial<TerminalSettings[K]>;
};

export function updateTerminalSettings(patch: TerminalSettingsPatch) {
  commit(sanitize({
    general: { ...current.general, ...(patch.general || {}) },
    appearance: { ...current.appearance, ...(patch.appearance || {}) },
    trading: { ...current.trading, ...(patch.trading || {}) },
    savedAt: Date.now(),
  }));
}

export type TerminalSettingsSection = keyof TerminalSettingsPatch;

export function resetTerminalSettings(section?: TerminalSettingsSection) {
  const defaults = { ...DEFAULT_TERMINAL_SETTINGS };
  if (!section) { commit({ ...defaults, savedAt: Date.now() }); return; }
  commit(sanitize({ ...current, [section]: { ...defaults[section] }, savedAt: Date.now() }));
}

/** React hook — re-renders only when the settings object actually changes. */
export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(
    (cb) => { snapshotListeners.add(cb); return () => snapshotListeners.delete(cb); },
    () => current,
  );
}

/** subscribe for non-React consumers (tests, future settings surfaces) */
export function subscribeTerminalSettings(cb: () => void): () => void {
  snapshotListeners.add(cb);
  return () => snapshotListeners.delete(cb);
}
