/**
 * instrument-settings — per-INSTRUMENT preferences (Phase 21 spec §4).
 *
 * Every field is optional: a missing field means "inherit the global default"
 * (it_chart_settings / terminal-settings.trading), so an instrument only
 * overrides what the user actually customized there. EURUSD preferences can
 * never leak into XAUUSD — storage is keyed per symbol.
 *
 * Persistence: localStorage mirror (instant paint, works logged-out) + RTDB
 * `users/{uid}/instrumentSettings/{symbol}` (debounced 400ms, follows the
 * chart-persistence pattern used by drawings/indicators).
 */
import { useSyncExternalStore } from "react";
import { getDatabase, ref, get, update, remove } from "firebase/database";

export type InstrumentChartType = "candles" | "hollow" | "bars" | "baseline" | "line" | "area" | "heikin";

export interface InstrumentSettings {
  chartType?: InstrumentChartType;
  timeframe?: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1W" | "1M";
  /** candle colors — the chart engine supports per-series colors */
  upColor?: string;
  downColor?: string;
  grid?: boolean;
  bidAsk?: boolean;
  /** Phase 34: price-axis decimal override (undefined = instrument default) */
  precision?: number;
  /** last-price line + axis label on the main series */
  lastPrice?: boolean;
  /** previous-day-close dotted line (from the instrument's own daily history) */
  prevClose?: boolean;
  /** which side the price axis sits on */
  priceScaleSide?: "right" | "left";
  /** IANA timezone for the time axis / crosshair ("" = viewer locale) */
  timezone?: string;
  /** trading defaults that only make sense per instrument */
  defaultLot?: string;
  defaultRisk?: string;
  slPips?: string;
  tpPips?: string;
}

const LS_KEY = (uid: string | null, symbol: string) => `it_instrument_settings_${uid || "anon"}_${symbol}`;
const RTDB_PATH = (uid: string, symbol: string) => `users/${uid}/instrumentSettings/${symbol}`;

const CHART_TYPES: InstrumentChartType[] = ["candles", "hollow", "bars", "baseline", "line", "area", "heikin"];
const TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"] as const;

const asColor = (v: unknown): string | undefined =>
  typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : undefined;
const asOptBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const asOptEnum = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
const asOptNum = (v: unknown, lo: number, hi: number): string | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > lo && n <= hi ? String(n) : undefined;
};

/** test hook — the pure validator behind every read/write */
export const __sanitizeInstrumentSettings = sanitize;

function sanitize(raw: unknown): InstrumentSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const out: InstrumentSettings = {};
  const chartType = asOptEnum(r.chartType, CHART_TYPES);
  if (chartType) out.chartType = chartType;
  const tf = asOptEnum(r.timeframe, TFS);
  if (tf) out.timeframe = tf;
  const up = asColor(r.upColor);
  if (up) out.upColor = up;
  const down = asColor(r.downColor);
  if (down) out.downColor = down;
  const grid = asOptBool(r.grid);
  if (grid !== undefined) out.grid = grid;
  const bidAsk = asOptBool(r.bidAsk);
  if (bidAsk !== undefined) out.bidAsk = bidAsk;
  // Phase 34 fields
  const prec = asOptNum(r.precision, -1, 8);
  if (prec) out.precision = Number(prec);
  const lastPrice = asOptBool(r.lastPrice);
  if (lastPrice !== undefined) out.lastPrice = lastPrice;
  const prevClose = asOptBool(r.prevClose);
  if (prevClose !== undefined) out.prevClose = prevClose;
  const side = asOptEnum(r.priceScaleSide, ["right", "left"] as const);
  if (side) out.priceScaleSide = side;
  if (typeof r.timezone === "string" && r.timezone.length <= 64) out.timezone = r.timezone;
  const lot = asOptNum(r.defaultLot, 0, 1000);
  if (lot) out.defaultLot = lot;
  const risk = asOptNum(r.defaultRisk, 0, 100);
  if (risk) out.defaultRisk = risk;
  const sl = asOptNum(r.slPips, 0, 100000);
  if (sl) out.slPips = sl;
  const tp = asOptNum(r.tpPips, 0, 100000);
  if (tp) out.tpPips = tp;
  return out;
}

// store ---------------------------------------------------------------------

const cache = new Map<string, InstrumentSettings>();
const listeners = new Map<string, Set<() => void>>();
let userUid: string | null = null;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let loadToken = 0;

function notify(symbol: string) {
  listeners.get(symbol)?.forEach((l) => l());
}

function persistLocal(symbol: string, s: InstrumentSettings) {
  try {
    if (Object.keys(s).length === 0) localStorage.removeItem(LS_KEY(userUid, symbol));
    else localStorage.setItem(LS_KEY(userUid, symbol), JSON.stringify(s));
  } catch { /* private mode / quota */ }
}

function persistRemote(symbol: string, s: InstrumentSettings) {
  if (!userUid) return;
  const key = `${userUid}:${symbol}`;
  if (saveTimers.has(key)) clearTimeout(saveTimers.get(key)!);
  saveTimers.set(
    key,
    setTimeout(async () => {
      saveTimers.delete(key);
      try {
        const db = getDatabase();
        const path = ref(db, RTDB_PATH(userUid!, symbol));
        if (Object.keys(s).length === 0) await remove(path);
        else await update(path, s);
      } catch { /* offline / rules — LS mirror stays authoritative */ }
    }, 400),
  );
}

/** Wire to the signed-in user (call on auth change; null = anon). */
export async function setInstrumentSettingsUser(uid: string | null) {
  if (userUid === uid) return;
  // flush in-flight remote writes of the previous user before switching
  if (userUid) {
    for (const [key, t] of [...saveTimers.entries()]) {
      if (key.startsWith(`${userUid}:`)) { clearTimeout(t); saveTimers.delete(key); }
    }
  }
  userUid = uid;
  loadToken++;
  for (const sym of [...cache.keys()]) { cache.delete(sym); notify(sym); }
}

const remoteFetched = new Set<string>();

export function getInstrumentSettings(symbol: string): InstrumentSettings {
  let s = cache.get(symbol);
  if (!s) {
    try {
      const raw = localStorage.getItem(LS_KEY(userUid, symbol));
      s = raw ? sanitize(JSON.parse(raw)) : {};
    } catch { s = {}; }
    cache.set(symbol, s);
    // this device never stored the instrument → adopt the user's cloud copy
    // (devices that edited locally keep their own, LS-wins semantics)
    if (userUid && !Object.keys(s).length && !remoteFetched.has(`${userUid}:${symbol}`)) {
      remoteFetched.add(`${userUid}:${symbol}`);
      const token = loadToken;
      get(ref(getDatabase(), RTDB_PATH(userUid, symbol)))
        .then((snap) => {
          if (token !== loadToken) return;
          const remote = snap.val();
          if (!remote || typeof remote !== "object") return;
          const clean = sanitize(remote);
          if (!Object.keys(clean).length) return;
          const local = cache.get(symbol) || {};
          if (Object.keys(local).length) return; // local edit wins
          cache.set(symbol, clean);
          persistLocal(symbol, clean);
          notify(symbol);
        })
        .catch(() => { /* offline */ });
    }
  }
  return s;
}

export function updateInstrumentSettings(symbol: string, patch: InstrumentSettings) {
  const merged = sanitize({ ...getInstrumentSettings(symbol) });
  // every patch key goes through validation on its own; undefined/null/""
  // clears that override so the field inherits the global default again
  for (const k of Object.keys(patch) as (keyof InstrumentSettings)[]) {
    const v = (patch as any)[k];
    if (v === undefined || v === null || v === "") delete (merged as any)[k];
    else {
      const validated = sanitize({ [k]: v }) as Record<string, any>;
      if (validated[k] !== undefined) (merged as any)[k] = validated[k];
    }
  }
  cache.set(symbol, merged);
  persistLocal(symbol, merged);
  persistRemote(symbol, merged);
  notify(symbol);
}

export function resetInstrumentSettings(symbol: string) {
  cache.set(symbol, {});
  persistLocal(symbol, {});
  persistRemote(symbol, {});
  notify(symbol);
}

export function subscribeInstrumentSettings(symbol: string, cb: () => void): () => void {
  let set = listeners.get(symbol);
  if (!set) { set = new Set(); listeners.set(symbol, set); }
  set.add(cb);
  return () => set.delete(cb);
}

/** React hook — per-symbol subscription; changes re-render only that symbol. */
export function useInstrumentSettings(symbol: string): InstrumentSettings {
  return useSyncExternalStore(
    (cb) => subscribeInstrumentSettings(symbol, cb),
    () => getInstrumentSettings(symbol),
  );
}
