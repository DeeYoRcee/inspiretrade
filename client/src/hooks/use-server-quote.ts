import { useCallback, useSyncExternalStore } from "react";
import { authedFetch } from "@/lib/api";

export interface ServerQuote {
  bid: number;
  ask: number;
  mid: number;
  time: number;
  source: string;
  live: boolean;
  /** PHASE 67 — true when the LAST poll failed and the shown quote is the
   *  previous one (consumers can disclose staleness honestly). */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// PHASE 67 §5 (MEDIUM-4) — ONE shared 3s quote poll per symbol.
//
// useServerQuote used to run its own setInterval per mounted component: with
// the terminal open (TradingPanel + MarketInfoPanel + PriceChart + the chart
// trade overlay) the SAME /api/trading?action=quote request fired up to 4×
// per 3s window — duplicated server work and duplicated provider spend.
//
// The poller is now module-level and reference-counted: the first subscriber
// of a symbol starts the timer, further subscribers attach for free, and the
// LAST unsubscribe stops it. Every subscriber re-renders from one stable
// snapshot (useSyncExternalStore), so all panels show the SAME quote with
// the SAME timestamp. The EXECUTION semantics are unchanged — this is still
// the engine's quote service, never merged with the chart's spot feed.
// ---------------------------------------------------------------------------

interface QuoteEntry {
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  snapshot: ServerQuote | null; // stable identity — replaced only on updates
  inflight: boolean;
}

const entries = new Map<string, QuoteEntry>();

function getEntry(symbol: string): QuoteEntry {
  let e = entries.get(symbol);
  if (!e) {
    e = { listeners: new Set(), timer: null, snapshot: null, inflight: false };
    entries.set(symbol, e);
  }
  return e;
}

async function pollQuote(symbol: string): Promise<void> {
  const e = getEntry(symbol);
  if (e.inflight) return; // a slow response must never stack requests
  e.inflight = true;
  try {
    const res = await authedFetch<any>(`/api/trading?action=quote&symbol=${encodeURIComponent(symbol)}`);
    const q = res?.quote ?? null;
    if (q && typeof q.mid === "number" && q.mid > 0) {
      // new stable snapshot object only when the quote actually changed
      const prev = e.snapshot;
      const same = prev && !prev.stale
        && prev.bid === q.bid && prev.ask === q.ask && prev.mid === q.mid
        && prev.time === q.time && prev.source === q.source;
      if (!same) e.snapshot = { ...q, stale: false };
    } else if (e.snapshot && !e.snapshot.stale) {
      // a malformed answer keeps the last known quote, marked stale
      e.snapshot = { ...e.snapshot, stale: true };
    }
  } catch {
    if (e.snapshot && !e.snapshot.stale) e.snapshot = { ...e.snapshot, stale: true };
  } finally {
    e.inflight = false;
    e.listeners.forEach((l) => l());
  }
}

/** Subscribe one consumer to the shared symbol poller (refcounted). */
export function subscribeServerQuote(symbol: string, cb: () => void): () => void {
  const e = getEntry(symbol);
  e.listeners.add(cb);
  if (!e.timer) {
    void pollQuote(symbol); // immediate first quote for the first subscriber
    e.timer = setInterval(() => void pollQuote(symbol), 3000);
  }
  return () => {
    const cur = entries.get(symbol);
    if (!cur) return;
    cur.listeners.delete(cb);
    if (!cur.listeners.size && cur.timer) {
      clearInterval(cur.timer);
      entries.delete(symbol); // last consumer gone — timer + cache released
    }
  };
}

function getServerQuoteSnapshot(symbol: string): ServerQuote | null {
  return entries.get(symbol)?.snapshot ?? null;
}

/**
 * The trading ticket / info panel / chart trade overlay quote — the ENGINE's
 * execution quote (TrueFX spreads for majors, spread-widened gold-api spot
 * for metals, × platform multiplier). One shared poll serves every mounted
 * consumer of the same symbol.
 */
export function useServerQuote(symbol: string | null): ServerQuote | null {
  const key = symbol ?? "";
  const subscribe = useCallback(
    (cb: () => void) => (symbol ? subscribeServerQuote(symbol, cb) : () => {}),
    [symbol],
  );
  const getSnapshot = useCallback(
    () => (symbol ? getServerQuoteSnapshot(symbol) : null),
    [symbol],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
