/**
 * price-store — external live price store (the F7 fix).
 *
 * TerminalPage used to keep prices in useState: every WebSocket tick re-rendered
 * the ENTIRE terminal page. Now charts push ticks here; only components that
 * actually display a price subscribe, and notifications are coalesced to at
 * most one render per FLUSH_MS. Non-reactive readers (the alerts evaluator,
 * which runs on its own 30s interval) use getAllPrices().
 */
import { useSyncExternalStore } from "react";

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
