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
  private lastMsgAt = 0;
  private wsFails = 0;
  private wsAltPort = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private polls = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Map<string, Set<UpdateCb>>();
  private history = new Map<string, Bar[]>();
  private loadedAt = new Map<string, number>();

  async load(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    // short-lived fresh cache — instant timeframe switching / remounts
    const fresh = this.history.get(key);
    if (fresh && Date.now() - (this.loadedAt.get(key) ?? 0) < 15000) return fresh;
    const bars = await this.fetchRecent(symbol, tf, 1000);
    this.history.set(key, bars);
    this.loadedAt.set(key, Date.now());
    return bars;
  }

  /** REST klines fetch — used for history AND for gap-fill / safety polling. */
  private async fetchRecent(symbol: string, tf: Timeframe, limit: number): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const url = `https://api.binance.com/api/v3/klines?symbol=${inst.binance}&interval=${BINANCE_INTERVAL[tf]}&limit=${limit}`;
    const raw: any[] = await (await fetch(url)).json();
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      takerBuy: k[9] != null ? +k[9] : undefined,
    }));
  }

  subscribe(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
    const key = `${symbol}:${tf}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);

    if (this.wsKey !== key) this.openSocket(symbol, tf, key);
    this.startWatchdog();
    // REST safety poll (10s): the chart must NEVER freeze. While the WS is
    // healthy (a message within the last 5s) it costs nothing; the moment the
    // WS goes stale (blocked network, dead NAT, region issue) this poll
    // upserts the last 2 klines and keeps the last candle moving instead.
    if (!this.polls.has(key)) {
      this.polls.set(key, setInterval(async () => {
        if (this.history.get(key)?.length && Date.now() - this.lastMsgAt < 5000) return;
        try {
          const recent = await this.fetchRecent(symbol, tf, 2);
          if (!recent.length) return;
          let bars = this.history.get(key) || [];
          let changed = false;
          for (const b of recent) {
            const prev = bars.find((x) => x.time === b.time);
            if (!prev || prev.close !== b.close || prev.high !== b.high || prev.low !== b.low || prev.volume !== b.volume) changed = true;
            bars = upsert(bars, b);
          }
          if (!changed) return;
          this.history.set(key, bars);
          this.loadedAt.set(key, Date.now());
          const lastBar = bars[bars.length - 1];
          this.listeners.get(key)?.forEach((c) => c({ bars, lastBar, isRealtime: false }));
        } catch { /* transient — next tick retries */ }
      }, 10000));
    }
    return () => {
      const set = this.listeners.get(key);
      set?.delete(cb);
      if (set && set.size === 0) {
        const p = this.polls.get(key);
        if (p) { clearInterval(p); this.polls.delete(key); }
        if (this.wsKey === key) {
          this.ws?.close();
          this.ws = null;
          this.wsKey = "";
          if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
        }
      }
    };
  }

  /** Kills a silently-dead socket: kline streams push every ~1-2s when live. */
  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastMsgAt > 15000) {
        this.lastMsgAt = Date.now(); // avoid double-fire while reconnecting
        this.ws.close(); // onclose → reconnect (with REST resync)
      }
    }, 5000);
  }

  private openSocket(symbol: string, tf: Timeframe, key: string) {
    this.ws?.close();
    const inst = getInstrument(symbol)!;
    const stream = `${inst.binance!.toLowerCase()}@kline_${BINANCE_INTERVAL[tf]}`;
    // some networks/regions block :9443 — fall back to :443 after 2 fails
    if (this.wsFails >= 2) this.wsAltPort = !this.wsAltPort;
    if (this.wsFails >= 2) this.wsFails = 0;
    const host = this.wsAltPort ? "stream.binance.com:443" : "stream.binance.com:9443";
    const ws = new WebSocket(`wss://${host}/ws/${stream}`);
    this.ws = ws;
    this.wsKey = key;
    this.lastMsgAt = Date.now();
    ws.onopen = () => {
      this.backoff = 1000;
      // resync right after (re)connect: candles traded while the socket was
      // down are fetched via REST and upserted — no gap, no stale candle
      this.fetchRecent(symbol, tf, 2)
        .then((recent) => {
          if (!recent.length || this.wsKey !== key) return;
          let bars = this.history.get(key) || [];
          let changed = false;
          for (const b of recent) {
            const prev = bars.find((x) => x.time === b.time);
            if (!prev || prev.close !== b.close || prev.high !== b.high || prev.low !== b.low || prev.volume !== b.volume) changed = true;
            bars = upsert(bars, b);
          }
          if (!changed) return;
          this.history.set(key, bars);
          const lastBar = bars[bars.length - 1];
          this.listeners.get(key)?.forEach((c) => c({ bars, lastBar, isRealtime: true }));
        })
        .catch(() => { /* the WS stream will still update from now on */ });
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      this.wsFails = 0; // this port works
      try {
        const k = JSON.parse(ev.data)?.k;
        if (!k) return;
        const bar: Bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, takerBuy: k.V != null ? +k.V : undefined };
        const bars = upsert(this.history.get(key) || [], bar);
        this.history.set(key, bars);
        this.listeners.get(key)?.forEach((cb) => cb({ bars, lastBar: bar, isRealtime: true }));
      } catch { /* malformed frame — skip */ }
    };
    ws.onclose = () => {
      if (this.wsKey !== key) return;
      this.wsFails++;
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
  private loadedAt = new Map<string, number>();
  private inflight = new Set<string>();

  // network fetch + aggregation, always bypasses the fresh cache (poll path)
  private async loadNetwork(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    const cfg = YAHOO_INTERVAL[tf];
    const agg = YAHOO_AGGREGATE[tf];
    // prefer the target tf's own config when its interval equals the base
    // interval (4h: "1y/60m" gives ~4x deeper history than the 1h base's 3mo)
    const useCfg = agg
      ? (cfg.interval === YAHOO_INTERVAL[agg].interval ? cfg : YAHOO_INTERVAL[agg])
      : cfg;
    const res: any = await authedFetch(`/api/quotes?symbol=${encodeURIComponent(inst.yahoo!)}&range=${useCfg.range}&interval=${useCfg.interval}`);
    if (!res?.ok) throw new Error(res?.detail || "FEED_UNAVAILABLE");
    let bars: Bar[] = res.bars;
    // bucket length = the TARGET timeframe in minutes (3m→3, 2h→120, 4h→240).
    // The old TF_SECONDS[tf]/TF_SECONDS[agg] ratio only happens to be minutes
    // for the 1m base: from the 1h base it passed 2/4 "minutes" → 2- and
    // 4-MINUTE buckets → the 2h and 4h charts actually rendered 1h candles.
    if (agg) bars = aggregateBars(bars, TF_SECONDS[tf] / 60);
    bars = dedupSort(bars);
    this.history.set(key, bars);
    this.loadedAt.set(key, Date.now());
    return bars;
  }

  async load(symbol: string, tf: Timeframe): Promise<{ bars: Bar[]; delayed: boolean }> {
    const key = `${symbol}:${tf}`;
    // short-lived fresh cache: instant timeframe switching + remounts
    const fresh = this.history.get(key);
    if (fresh && Date.now() - (this.loadedAt.get(key) ?? 0) < 15000) {
      return { bars: fresh, delayed: true };
    }
    const bars = await this.loadNetwork(symbol, tf);
    return { bars, delayed: true };
  }

  subscribe(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
    const key = `${symbol}:${tf}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);
    const tick = async () => {
      // in-flight guard: a slow response must never stack requests or let an
      // older answer overwrite a newer one (chart jumping backwards)
      if (this.inflight.has(key)) return;
      this.inflight.add(key);
      try {
        await this.loadNetwork(symbol, tf);
        const bars = this.history.get(key)!;
        if (bars.length) this.listeners.get(key)?.forEach((c) => cb({ bars, lastBar: bars[bars.length - 1], isRealtime: false }));
      } catch { /* transient — next poll retries */ } finally {
        this.inflight.delete(key);
      }
    };
    // first tick right away — but skip it when the history was just fetched
    // (fresh cache), so mounting the chart never duplicates the load request
    if (Date.now() - (this.loadedAt.get(key) ?? 0) > 10000) void tick();
    // REST polling — 10s; Yahoo data is delayed anyway, this keeps the last
    // candle moving without hammering the proxy.
    const timer = setInterval(tick, 10000);
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

// ---------------------------------------------------------------------------
// TTL-cached multi-instrument loader (screener / MTF / heatmap / backtester).
// sessionStorage keeps one browser session inside provider rate limits.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
const memCache = new Map<string, { at: number; bars: Bar[] }>();

export async function loadBarsCached(symbol: string, tf: Timeframe, maxBars = 500): Promise<Bar[]> {
  const key = `bars:${symbol}:${tf}`;
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.bars;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw) as { at: number; bars: Bar[] };
      if (Date.now() - p.at < CACHE_TTL_MS) { memCache.set(key, p); return p.bars; }
    }
  } catch { /* storage unavailable */ }
  const res = await loadFeed(symbol, tf);
  const bars = res.bars.slice(-maxBars);
  const entry = { at: Date.now(), bars };
  memCache.set(key, entry);
  try { sessionStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota */ }
  return bars;
}

export function clearBarsCache() {
  memCache.clear();
  try {
    Object.keys(sessionStorage).filter((k) => k.startsWith("bars:")).forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

/** Load bars for many symbols with limited concurrency (staggered batches). */
export async function loadBarsMany(symbols: string[], tf: Timeframe, maxBars = 500, batchSize = 3): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {};
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((s) => loadBarsCached(s, tf, maxBars)));
    results.forEach((r, j) => { if (r.status === "fulfilled") out[batch[j]] = r.value; });
  }
  return out;
}
