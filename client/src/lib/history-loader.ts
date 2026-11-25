/**
 * Historical range loader for replay & backtesting — REAL data only.
 *
 * Crypto (feed "binance"): paginated Binance klines with startTime/endTime —
 * arbitrary windows, years deep, no keys, public market-data mirrors.
 *
 * Forex / metals / indices (feed "quotes"): the /api/quotes proxy in period
 * mode (Yahoo Finance chart API). Yahoo caps intraday history per interval —
 * historyAvailability() reports the honest window so the UI can clamp the
 * date pickers instead of guessing.
 */
import { authedFetch } from "@/lib/api";
import { binanceProvider } from "@/lib/market-data";
import {
  getInstrument, YAHOO_INTERVAL, aggregateBars, TF_SECONDS,
  type Bar, type Timeframe,
} from "@shared/terminal";

const MAX_BARS = 20000;

/** Phase 59: true when the provider interval IS already the target
 * granularity — those bars must pass through untouched (weekly/monthly
 * re-aggregation re-anchored weeks to Thursday and months to a 30-day grid). */
export function sourceAlreadyAggregated(interval: string, aggMinutes: number): boolean {
  if (interval === "1w") return aggMinutes === 10080; // 604800 s
  if (interval === "1mo") return aggMinutes === 43200; // 2592000 s
  return false;
}

export interface HistoryLoadResult {
  bars: Bar[];
  source: "binance" | "yahoo" | "stooq";
  /** true when the window was truncated by the MAX_BARS guard */
  capped: boolean;
}

export interface Availability {
  /** how many days back the provider can serve this timeframe (null = years) */
  maxDaysBack: number | null;
  note: string;
}

/** Honest per-provider history windows for the date pickers. */
export function historyAvailability(symbol: string, tf: Timeframe): Availability {
  const inst = getInstrument(symbol);
  if (!inst) return { maxDaysBack: 7, note: "Unknown instrument" };
  if (inst.feed === "binance") {
    return { maxDaysBack: null, note: "Binance provides years of real history for this timeframe" };
  }
  // Phase 16 honesty: replay/backtest history still comes from the delayed
  // Yahoo provider — for metals that underlier is a COMEX futures contract,
  // never presented as spot
  const suffix = inst.assetClass === "metal" ? " · COMEX futures underlier (not spot)" : "";
  // sub-minute TFs have no delayed-provider source at all
  if (!YAHOO_INTERVAL[tf]) return { maxDaysBack: 0, note: "Sub-minute candles are live-built only (no historical source)" };
  const interval = YAHOO_INTERVAL[tf]!.interval;
  switch (interval) {
    case "1m": return { maxDaysBack: 30, note: `The delayed provider keeps ~30 days of 1-minute history${suffix}` };
    case "5m": case "15m": case "30m": return { maxDaysBack: 60, note: `The delayed provider keeps ~60 days of this granularity${suffix}` };
    case "60m": return { maxDaysBack: 730, note: `The delayed provider keeps ~2 years of hourly history${suffix}` };
    default: return { maxDaysBack: 730, note: `The delayed provider keeps ~2 years of this granularity${suffix}` };
  }
}

const DAY = 86400;

function dedupeSort(bars: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  // P63R — drop null/malformed elements: a null entry in a period response
  // crashed exactly like the recurring "reading 'time'" terminal error
  for (const b of bars) {
    if (!b || typeof b.time !== "number" || !Number.isFinite(b.time)) continue;
    map.set(b.time, b);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/** Crypto: paginated Binance klines across [from, to]. */
async function loadBinanceRange(
  symbol: string, tf: Timeframe, fromSec: number, toSec: number,
  onProgress?: (done: number, total: number) => void,
): Promise<HistoryLoadResult> {
  const collected: Bar[] = [];
  let capped = false;
  const totalEstimate = Math.min(MAX_BARS, Math.ceil((toSec - fromSec) / TF_SECONDS[tf]));
  // BinanceProvider.fetchRecent is private; page backwards through the public
  // loadOlder (endTime exclusive) collecting 1000-candle pages.
  let endExclusive = toSec;
  while (endExclusive > fromSec && collected.length < MAX_BARS) {
    const older = await binanceProvider.loadOlder(symbol, tf, endExclusive, 1000);
    if (!older.length) break;
    collected.push(...older);
    onProgress?.(Math.min(collected.length, totalEstimate), totalEstimate);
    const oldest = older[0].time;
    if (older.length < 1000 || oldest <= fromSec) break;
    endExclusive = oldest;
  }
  let bars = dedupeSort(collected.filter((b) => b.time >= fromSec && b.time <= toSec));
  if (bars.length > MAX_BARS) {
    bars = bars.slice(bars.length - MAX_BARS);
    capped = true;
  }
  return { bars, source: "binance", capped };
}

/** Non-crypto: /api/quotes period mode, chunked by the provider's per-request window. */
async function loadProxyRange(
  symbol: string, tf: Timeframe, fromSec: number, toSec: number,
  onProgress?: (done: number, total: number) => void,
): Promise<HistoryLoadResult> {
  const inst = getInstrument(symbol)!;
  const yCfg = YAHOO_INTERVAL[tf];
  if (!yCfg) throw new Error("NO_SOURCE_INTERVAL"); // sub-minute TFs are live-built only
  const interval = yCfg.interval;
  const agg = TF_SECONDS[tf] / 60; // bucket minutes for client-side aggregation
  // chunk length so each Yahoo request stays within its per-interval cap
  const chunkDays = interval === "1m" ? 5 : interval === "5m" || interval === "15m" || interval === "30m" ? 30 : 240;
  const chunks: [number, number][] = [];
  let cur = fromSec;
  while (cur < toSec) {
    const end = Math.min(toSec, cur + chunkDays * DAY);
    chunks.push([cur, end]);
    cur = end;
  }
  const collected: Bar[] = [];
  let capped = false;
  let source: HistoryLoadResult["source"] = "yahoo";
  for (let i = 0; i < chunks.length; i++) {
    const [c1, c2] = chunks[i];
    const res: any = await authedFetch(
      `/api/quotes?symbol=${encodeURIComponent(inst.yahoo!)}&period1=${c1}&period2=${c2}&interval=${interval}`,
    );
    if (!res?.ok) throw new Error(res?.detail || "History unavailable for this window");
    if (res.source) source = res.source;
    let bars: Bar[] = res.bars || [];
    // Phase 59: never re-aggregate bars that are ALREADY at the target
    // granularity — re-folding Yahoo's weekly stamps through the epoch floor
    // re-anchored weeks to Thursday and months to a drifting 30-day grid,
    // mislabeling every W1/1M candle in replay/backtest
    if (agg && agg !== 1 && !sourceAlreadyAggregated(interval, agg)) bars = aggregateBars(bars, agg);
    collected.push(...bars);
    onProgress?.(i + 1, chunks.length);
    if (collected.length > MAX_BARS) { capped = true; break; }
  }
  let bars = dedupeSort(collected).filter((b) => b.time >= fromSec && b.time <= toSec);
  if (bars.length > MAX_BARS) {
    bars = bars.slice(bars.length - MAX_BARS);
    capped = true;
  }
  return { bars, source, capped };
}

/**
 * Load REAL candles for [fromSec, toSec] (UNIX seconds, UTC) for any
 * instrument + timeframe. Throws a descriptive error when the window is not
 * available from the provider — the UI clamps pickers via historyAvailability.
 */
export async function loadHistoryRange(
  symbol: string, tf: Timeframe, fromSec: number, toSec: number,
  onProgress?: (done: number, total: number) => void,
): Promise<HistoryLoadResult> {
  const inst = getInstrument(symbol);
  if (!inst) throw new Error(`Unknown instrument: ${symbol}`);
  if (!(toSec > fromSec)) throw new Error("End date must be after the start date");
  if (toSec - fromSec > 400 * DAY) throw new Error("Replay/backtest window is limited to 400 days per run");
  if (inst.feed === "binance") return loadBinanceRange(symbol, tf, fromSec, toSec, onProgress);
  return loadProxyRange(symbol, tf, fromSec, toSec, onProgress);
}
