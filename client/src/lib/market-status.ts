/**
 * market-status — thin client wrapper over the SHARED authoritative module
 * (shared/market-hours.ts). Phase 27: one source of truth for market hours —
 * the same NY-wall-clock, DST-correct logic guards backend orders and drives
 * every client indicator. Kept exports stable for existing consumers
 * (Watchlist, InstrumentExplorer, TerminalSettingsDialog, PriceChart badge).
 */
import { marketHours, nextOpen } from "../../../shared/market-hours.ts";

export type MarketStatus = "open" | "closed";

/** Legacy boolean view used by watchlist dots and the feed badge. */
export function marketStatus(symbol: string, at: number = Date.now()): MarketStatus {
  return marketHours(symbol, at).open ? "open" : "closed";
}

export type MarketClosedReason = "open" | "weekend" | "daily-break" | "holiday" | "unknown";

export interface MarketHoursInfo {
  open: boolean;
  reason: MarketClosedReason;
  /** next opening instant (ms) in UTC, or null when open */
  nextOpenMs: number | null;
}

/** Full info for the trading panel banner + countdown. */
export function marketHoursInfo(symbol: string, at: number = Date.now()): MarketHoursInfo {
  return marketHours(symbol, at);
}

export { nextOpen };

