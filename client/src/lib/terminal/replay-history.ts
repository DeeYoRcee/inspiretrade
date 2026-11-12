/**
 * Replay history loader — deep, paginated REAL OHLC data.
 *
 * Binance: walks backwards with endTime pagination (1000 bars per request,
 * up to `maxBars`) — taker-buy volume preserved. Yahoo instruments: single
 * request with the provider's largest available range for the timeframe
 * (see YAHOO_INTERVAL); the response is deduplicated and time-sorted.
 *
 * Guarantees required by the replay engine: ascending time order, no
 * duplicate timestamps, no generated candles. Results are cached in memory
 * + sessionStorage (10 min TTL) so seeking around a session never re-downloads.
 */
import type { Bar, Timeframe } from "@shared/terminal";
import { getInstrument, BINANCE_INTERVAL, YAHOO_INTERVAL } from "@shared/terminal";
import { authedFetch } from "@/lib/api";

const TTL = 10 * 60_000;
const mem = new Map<string, { at: number; bars: Bar[] }>();

function cacheGet(key: string): Bar[] | null {
  const m = mem.get(key);
  if (m && Date.now() - m.at < TTL) return m.bars;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw) as { at: number; bars: Bar[] };
      if (Date.now() - p.at < TTL) { mem.set(key, p); return p.bars; }
    }
  } catch { /* storage unavailable */ }
  return null;
}

function cacheSet(key: string, bars: Bar[]) {
  const entry = { at: Date.now(), bars };
  mem.set(key, entry);
  try { sessionStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota — memory only */ }
}

/** Merge overlapping/ascending batches: dedupe by time, sort ascending. */
function mergeBatches(batches: Bar[][]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const b of batches) for (const bar of b) if (!byTime.has(bar.time)) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function binanceDeep(binance: string, tf: Timeframe, maxBars: number): Promise<Bar[]> {
  const interval = BINANCE_INTERVAL[tf];
  const batches: Bar[][] = [];
  let endTime: number | undefined = undefined;
  let received = 0;
  for (let page = 0; page < Math.ceil(maxBars / 1000); page++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${binance}&interval=${interval}&limit=1000${endTime ? `&endTime=${endTime}` : ""}`;
    const raw: any[] = await (await fetch(url)).json();
    if (!Array.isArray(raw) || !raw.length) break;
    const bars: Bar[] = raw.map((k) => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      takerBuy: k[9] != null ? +k[9] : undefined,
    }));
    batches.push(bars);
    received += bars.length;
    endTime = bars[0].time * 1000 - 1;
    if (raw.length < 1000 || received >= maxBars) break;
    await sleep(120); // gentle on the public API
  }
  return mergeBatches(batches).slice(-maxBars);
}

async function yahooRange(yahoo: string, tf: Timeframe): Promise<Bar[]> {
  const cfg = YAHOO_INTERVAL[tf];
  const res: any = await authedFetch(`/api/quotes?symbol=${encodeURIComponent(yahoo)}&range=${cfg.range}&interval=${cfg.interval}`);
  const bars = (res?.bars ?? []) as Bar[];
  if (!Array.isArray(bars) || !bars.length) throw new Error("EMPTY_HISTORY");
  return mergeBatches([bars]);
}

/**
 * Deep history for replay. Throws a descriptive error when the provider
 * cannot serve the timeframe — the UI shows the limitation and NEVER
 * generates substitute candles.
 */
export async function loadReplayHistory(symbol: string, tf: Timeframe, maxBars = 5000): Promise<Bar[]> {
  const key = `rhist:${symbol}:${tf}:${maxBars}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const i = getInstrument(symbol);
  if (!i) throw new Error(`Unknown instrument ${symbol}`);
  let bars: Bar[];
  if (i.feed === "binance" && i.binance) {
    bars = await binanceDeep(i.binance, tf, maxBars);
  } else if (i.feed === "quotes" && i.yahoo) {
    bars = await yahooRange(i.yahoo, tf);
  } else {
    throw new Error("No historical provider for this instrument");
  }
  if (!bars.length) throw new Error("Provider returned no history for this timeframe");
  cacheSet(key, bars);
  return bars;
}

export function clearReplayHistoryCache() {
  mem.clear();
  try {
    Object.keys(sessionStorage).filter((k) => k.startsWith("rhist:")).forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}
