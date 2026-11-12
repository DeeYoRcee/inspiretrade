/**
 * Terminal market data layer.
 *
 * Provider abstraction (REAL data only — no generated prices):
 *  - BinanceProvider: real live crypto via public REST + WebSocket (no key).
 *  - QuotesProvider : real (delayed) forex/metals/indices via our server proxy
 *                     /api/quotes → Yahoo Finance (polling).
 * On failure the caller gets a thrown error and renders an error state with a
 * retry button — the chart never falls back to synthetic candles.
 *
 * Every feed normalizes to Bar[] (UNIX seconds UTC) and supports:
 *  - loadHistory(tf) once
 *  - subscribe(tf, cb) live updates with duplicate-candle protection
 *  - automatic reconnect with backoff (WS) / polling interval (REST)
 */
import { authedFetch } from "@/lib/api";
import {
  getInstrument, INSTRUMENTS, BINANCE_INTERVAL, YAHOO_INTERVAL, YAHOO_AGGREGATE, TF_SECONDS,
  aggregateBars, type Bar, type InstrumentSpec, type Timeframe,
} from "@shared/terminal";

export type FeedStatus = "connecting" | "live" | "polling" | "error";

export interface FeedUpdate {
  bars: Bar[];        // full updated series (safe copy)
  lastBar: Bar;       // most recent bar
  isRealtime: boolean;
}

type UpdateCb = (u: FeedUpdate) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupSort(bars: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const b of bars) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function upsert(bars: Bar[], bar: Bar): Bar[] {
  const out = bars.slice();
  const i = out.findIndex((b) => b.time === bar.time);
  if (i >= 0) out[i] = bar;
  else {
    out.push(bar);
    out.sort((a, b) => a.time - b.time);
    if (out.length > 3000) out.splice(0, out.length - 3000);
  }
  return out;
}

/**
 * Deterministic seeded random walk — REMOVED.
 * Policy: the chart must never display generated prices. When a real feed is
 * unavailable the UI shows a clear error state with a retry button instead.
 */

// ---------------------------------------------------------------------------
// Binance (crypto — real live)
// ---------------------------------------------------------------------------

class BinanceProvider {
  private ws: WebSocket | null = null;
  private wsKey = "";
  private backoff = 1000;
  private listeners = new Map<string, Set<UpdateCb>>();
  private history = new Map<string, Bar[]>();

  async load(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    const url = `https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${BINANCE_INTERVAL[tf]}&limit=1000`;
    const raw: any[] = await (await fetch(url)).json();
    const bars: Bar[] = raw.map((k) => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    this.history.set(key, bars);
    return bars;
  }

  subscribe(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);

    if (this.wsKey !== key) this.openSocket(symbol, tf, key);
    return () => {
      const set = this.listeners.get(key);
      set?.delete(cb);
      if (set && set.size === 0 && this.wsKey === key) {
        this.ws?.close();
        this.ws = null;
        this.wsKey = "";
      }
    };
  }

  private openSocket(symbol: string, tf: Timeframe, key: string) {
    this.ws?.close();
    const inst = getInstrument(symbol)!;
    const stream = `${inst.binance!.toLowerCase()}@kline_${BINANCE_INTERVAL[tf]}`;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
    this.ws = ws;
    this.wsKey = key;
    ws.onopen = () => { this.backoff = 1000; };
    ws.onmessage = (ev) => {
      try {
        const k = JSON.parse(ev.data)?.k;
        if (!k) return;
        const bar: Bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        const bars = upsert(this.history.get(key) || [], bar);
        this.history.set(key, bars);
        this.listeners.get(key)?.forEach((cb) => cb({ bars, lastBar: bar, isRealtime: true }));
      } catch { /* malformed frame — skip */ }
    };
    ws.onclose = () => {
      if (this.wsKey !== key) return;
      this.ws = null;
      this.wsKey = "";
      setTimeout(() => {
        if (this.listeners.get(key)?.size) this.openSocket(symbol, tf, key);
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.onerror = () => ws.close();
  }
}

// ---------------------------------------------------------------------------
// Quotes proxy (forex / metals / indices — real but delayed)
// ---------------------------------------------------------------------------

class QuotesProvider {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Map<string, Set<UpdateCb>>();
  private history = new Map<string, Bar[]>();

  async load(symbol: string, tf: Timeframe): Promise<{ bars: Bar[]; delayed: boolean }> {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    const cfg = YAHOO_INTERVAL[tf];
    const agg = YAHOO_AGGREGATE[tf];
    const useCfg = agg ? YAHOO_INTERVAL[agg] : cfg;
    const res: any = await authedFetch(`/api/quotes?symbol=${encodeURIComponent(inst.yahoo!)}&range=${useCfg.range}&interval=${useCfg.interval}`);
    if (!res?.ok) throw new Error(res?.detail || "FEED_UNAVAILABLE");
    let bars: Bar[] = res.bars;
    if (agg) bars = aggregateBars(bars, TF_SECONDS[tf] / TF_SECONDS[agg]);
    bars = dedupSort(bars);
    this.history.set(key, bars);
    return { bars, delayed: !!res.delayed };
  }

  subscribe(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
    const key = `${symbol}:${tf}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);
    // REST polling — 15s is enough for delayed quotes and keeps request volume low.
    const timer = setInterval(async () => {
      try {
        await this.load(symbol, tf);
        const bars = this.history.get(key)!;
        if (bars.length) this.listeners.get(key)?.forEach((c) => cb({ bars, lastBar: bars[bars.length - 1], isRealtime: false }));
      } catch { /* transient — next poll retries */ }
    }, 15000);
    this.timers.set(key, timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(key);
      this.listeners.get(key)?.delete(cb);
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const binanceProvider = new BinanceProvider();
export const quotesProvider = new QuotesProvider();

export interface LoadResult {
  bars: Bar[];
  status: FeedStatus;
  message?: string;
}

/**
 * Load history for an instrument+tf from REAL providers only.
 * Throws a descriptive error on failure — the chart shows an error state with
 * a retry button. No generated/random prices, ever.
 */
export async function loadFeed(symbol: string, tf: Timeframe): Promise<LoadResult> {
  const inst = getInstrument(symbol);
  if (!inst) throw new Error(`Unknown instrument: ${symbol}`);
  if (inst.feed === "binance") {
    const bars = await binanceProvider.load(symbol, tf);
    return { bars, status: "live" };
  }
  const { bars, delayed } = await quotesProvider.load(symbol, tf);
  return { bars, status: "polling", message: delayed ? "Delayed data (Yahoo)" : undefined };
}

/** Subscribe to live updates. Returns an unsubscribe function. */
export function subscribeFeed(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
  const inst = getInstrument(symbol);
  if (!inst) return () => {};
  if (inst.feed === "binance") {
    try { return binanceProvider.subscribe(symbol, tf, cb); } catch { return () => {}; }
  }
  try { return quotesProvider.subscribe(symbol, tf, cb); } catch { return () => {}; }
}

/** Latest mid price for market-watch rows (one-shot REST). */
export async function fetchLastPrices(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const binanceSyms = symbols.filter((s) => getInstrument(s)?.feed === "binance").map((s) => getInstrument(s)!.binance!);
  const yahooSyms = symbols.filter((s) => getInstrument(s)?.feed === "quotes").map((s) => getInstrument(s)!.yahoo!);

  if (binanceSyms.length) {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(binanceSyms))}`);
      const arr: any[] = await res.json();
      for (const row of arr) {
        const inst = INSTRUMENT_BY_BINANCE.get(row.symbol);
        if (inst) out[inst.symbol] = +row.price;
      }
    } catch { /* ignore */ }
  }
  if (yahooSyms.length) {
    try {
      const res: any = await authedFetch(`/api/quotes?symbols=${encodeURIComponent(yahooSyms.join(","))}`);
      for (const q of res?.quotes || []) {
        const inst = INSTRUMENT_BY_YAHOO.get(q.symbol);
        if (inst && q.price != null) out[inst.symbol] = q.price;
      }
    } catch { /* ignore */ }
  }
  return out;
}

const INSTRUMENT_BY_BINANCE = new Map<string, InstrumentSpec>();
const INSTRUMENT_BY_YAHOO = new Map<string, InstrumentSpec>();
for (const inst of INSTRUMENTS) {
  if (inst.binance) INSTRUMENT_BY_BINANCE.set(inst.binance, inst);
  if (inst.yahoo) INSTRUMENT_BY_YAHOO.set(inst.yahoo, inst);
}
