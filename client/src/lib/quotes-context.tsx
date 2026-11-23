/**
 * quotes-context — app-wide enriched quotes snapshot (Phase 21).
 *
 * The explorer, watchlist and info panel all need the same data (price, day
 * change, daily OHLC, status, freshness). One polling store instead of three
 * separate fetch loops: consumers subscribe on mount; while ≥1 consumer is
 * mounted the snapshot refreshes every 45s (the proven watchlist cadence),
 * with zero network traffic when nothing is listening. Every row comes from
 * real provider data (fetchQuotesSnapshot) — nothing fabricated.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchQuotesSnapshot, type QuoteRow } from "@/lib/market-data";
import { priceBusUpdateMany } from "@/lib/price-store";

const REFRESH_MS = 45000;

let snapshot: Record<string, QuoteRow> = {};
let updatedAt = 0;
let loading = false;
let timer: ReturnType<typeof setInterval> | null = null;
let consumerCount = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const next = await fetchQuotesSnapshot();
    // keep at least the previous rows for symbols whose provider hiccuped
    for (const [sym, row] of Object.entries(next)) snapshot[sym] = row;
    updatedAt = Date.now();
    // feed the shared price store — ticket/blotter/rows see every instrument
    const mids: Record<string, number> = {};
    for (const [sym, row] of Object.entries(snapshot)) if (row.price && row.price > 0) mids[sym] = row.price;
    priceBusUpdateMany(mids);
    notify();
  } catch {
    // Phase 59: a failed snapshot must not throw out of the 45s interval tick
    // (unhandled rejection + notify() skipped → the watchlist silently froze)
    // — keep the previous rows; the next tick retries
  } finally {
    loading = false;
  }
}

function start() {
  consumerCount++;
  if (timer == null) {
    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
  }
}

function stop() {
  consumerCount = Math.max(0, consumerCount - 1);
  if (consumerCount === 0 && timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Non-React read (rows for a symbol list). */
export function getQuoteRow(symbol: string): QuoteRow | null {
  return snapshot[symbol] || null;
}

export function getQuotesUpdatedAt(): number {
  return updatedAt;
}

/** Subscribe raw (tests, non-React consumers). Returns an unsubscribe fn. */
export function subscribeQuotes(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => { listeners.delete(cb); stop(); };
}

/** React hook — mounts a consumer subscription + latest snapshot. */
export function useQuotes(): { rows: Record<string, QuoteRow>; updatedAt: number } {
  const [, bump] = useState(0);
  useEffect(() => {
    const unsub = subscribeQuotes(() => bump((n) => n + 1));
    return unsub;
  }, []);
  return { rows: snapshot, updatedAt };
}

const QuotesContext = createContext(true);

/**
 * Mount once high in the tree (App) — not strictly required (useQuotes
 * self-subscribes) but keeps a stable home for future consumers.
 */
export function QuotesProvider({ children }: { children: ReactNode }) {
  return <QuotesContext.Provider value={true}>{children}</QuotesContext.Provider>;
}

export function useQuotesReady(): boolean {
  return useContext(QuotesContext);
}
