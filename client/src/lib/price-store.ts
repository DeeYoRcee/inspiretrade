/**
 * price-store — external live price store (the F7 fix).
 *
 * TerminalPage used to keep prices in useState: every WebSocket tick re-rendered
 * the ENTIRE terminal page. Now charts push ticks here; only components that
 * actually display a price subscribe, and notifications are coalesced to at
 * most one render per FLUSH_MS. Non-reactive readers (the alerts evaluator,
 * which runs on its own 30s interval) use getAllPrices().
 */
import { useCallback, useSyncExternalStore } from "react";

const FLUSH_MS = 250;

const prices = new Map<string, number>();
const dirty = new Set<string>();
const symbolListeners = new Map<string, Set<() => void>>();
const mapListeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let mapSnapshot: Record<string, number> = {}; // rebuilt on every flush

function flush() {
  flushTimer = null;
  if (!dirty.size) return;
  for (const sym of dirty) {
    prices.set(sym, pending.get(sym)!);
    symbolListeners.get(sym)?.forEach((l) => l());
  }
  pending.clear();
  dirty.clear();
  mapSnapshot = Object.fromEntries(prices);
  mapListeners.forEach((l) => l());
}

const pending = new Map<string, number>();

/** Chart tick entry point — cheap, never renders, coalesced flush. */
export function priceBusUpdate(symbol: string, price: number) {
  if (!Number.isFinite(price)) return;
  pending.set(symbol, price);
  dirty.add(symbol);
  if (flushTimer == null) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** Bulk set (e.g. market-watch batch fetch). */
export function priceBusUpdateMany(values: Record<string, number>) {
  for (const [sym, px] of Object.entries(values)) priceBusUpdate(sym, px);
}

export function getPrice(symbol: string): number | null {
  const v = prices.get(symbol);
  return v == null ? null : v;
}

export function getAllPrices(): Record<string, number> {
  return mapSnapshot;
}

function subscribeSymbol(symbol: string, cb: () => void) {
  let set = symbolListeners.get(symbol);
  if (!set) { set = new Set(); symbolListeners.set(symbol, set); }
  set.add(cb);
  return () => { set!.delete(cb); if (!set!.size) symbolListeners.delete(symbol); };
}

function subscribeMap(cb: () => void) {
  mapListeners.add(cb);
  return () => mapListeners.delete(cb);
}

/** Subscribe to one symbol's live price (renders at most 4×/s). */
export function usePrice(symbol: string): number | null {
  return useSyncExternalStore(
    (cb) => subscribeSymbol(symbol, cb),
    () => prices.get(symbol) ?? null,
    () => null,
  );
}

/** Subscribe to the whole price map (panels showing many instruments). */
export function usePriceMap(): Record<string, number> {
  return useSyncExternalStore(subscribeMap, () => mapSnapshot, () => mapSnapshot);
}

// PHASE 67 §8 (MEDIUM-5) — narrow per-symbol subscription for components that
// only need a handful of prices. PriceChart used usePriceMap() for its P/L
// chips: the chart then re-rendered on EVERY flush of ANY instrument (every
// crypto chart tick of every other open panel), not just its own position
// symbols. usePrices subscribes per symbol and keeps a per-key snapshot so
// useSyncExternalStore sees a stable identity between actual changes.
const narrowCache = new Map<string, { sig: string; obj: Record<string, number> }>();

export function usePrices(symbols: string[]): Record<string, number> {
  const key = symbols.slice().sort().join(",");
  const getSnapshot = useCallback(() => {
    const sig = symbols.map((s) => `${s}:${prices.get(s) ?? ""}`).join("|");
    const hit = narrowCache.get(key);
    if (hit && hit.sig === sig) return hit.obj;
    const obj: Record<string, number> = {};
    for (const s of symbols) { const v = prices.get(s); if (v != null) obj[s] = v; }
    narrowCache.set(key, { sig, obj });
    return obj;
  }, [key, symbols]);
  const subscribe = useCallback(
    (cb: () => void) => {
      const unsubs = symbols.map((s) => subscribeSymbol(s, cb));
      return () => { for (const u of unsubs) u(); };
    },
    [key, symbols],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => {
    const obj: Record<string, number> = {};
    for (const s of symbols) { const v = prices.get(s); if (v != null) obj[s] = v; }
    return obj;
  });
}
