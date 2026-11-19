import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/api";

export interface ServerQuote {
  bid: number;
  ask: number;
  mid: number;
  time: number;
  source: string;
  live: boolean;
}

/**
 * Phase 19 §1: the trading ticket's displayed bid/ask must be the ENGINE's
 * quote — polled from the same server price service that fills orders, so
 * what the user sees is exactly what a market order gets (genuine TrueFX
 * spreads for majors, SPREAD_PIPS around the gold-api spot mid for metals,
 * both × the platform spreadMultiplier). 3s cadence; the server applies its
 * own upstream TTL caches. Returns null while loading/offline — the panel
 * then falls back to its price-bus estimate.
 */
export function useServerQuote(symbol: string | null): ServerQuote | null {
  const [quote, setQuote] = useState<ServerQuote | null>(null);
  useEffect(() => {
    if (!symbol) {
      setQuote(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const res = await authedFetch<any>(`/api/trading?action=quote&symbol=${encodeURIComponent(symbol)}`);
        if (alive) setQuote(res?.quote ?? null);
      } catch { /* offline — keep the last quote */ }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [symbol]);
  return quote;
}
