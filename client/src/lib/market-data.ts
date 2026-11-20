/**
 * Market data layer — REAL data only, no generated prices.
 *
 * Provider abstraction:
 *  - BinanceProvider: real live crypto via public REST + WebSocket (no key).
 *  - QuotesProvider : real (delayed) forex/metals/indices via our server proxy
 *                     /api/quotes → Yahoo Finance (polling).
 * On failure the caller gets a thrown error and renders an error state with a
 * retry button — the chart never falls back to synthetic candles.
 *
 * Every feed normalizes to Bar[] (UNIX seconds UTC) and supports:
 *  - loadFeed(symbol, tf) once
 *  - subscribeFeed(symbol, tf, cb) live updates with duplicate-candle protection
 *  - automatic reconnect with backoff (WS) / polling interval (REST)
 */
import { authedFetch } from "@/lib/api";
import { getAllPrices } from "@/lib/price-store";
import {
  getInstrument, INSTRUMENTS, BINANCE_INTERVAL, BINANCE_AGGREGATE, YAHOO_INTERVAL, YAHOO_AGGREGATE, TF_SECONDS, type InstrumentSpec,
  aggregateBars, type Bar, type Timeframe,
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

/**
 * Upsert one bar into the live series. Hot path: called on EVERY tick.
 * Same-time ticks update the last element IN PLACE (no copy, no sort) — the
 * old copy+sort per tick was O(n log n) of main-thread work per chart.
 */
function upsert(bars: Bar[], bar: Bar): Bar[] {
  // canonical hot-path implementation (shared/candle-core.ts, unit-tested):
  // same-bucket in-place update · append on timeframe close · safe out-of-order insert
  return upsertBar(bars, bar, {
    onDuplicate: () => statsState.duplicateBars++,
    onOutOfOrder: () => statsState.outOfOrderTicks++,
  }) as Bar[];
}

/**
 * Deterministic seeded random walk — REMOVED.
 * Policy: the chart must never display generated prices. When a real feed is
 * unavailable the UI shows a clear error state with a retry button instead.
 */

// ---------------------------------------------------------------------------
// Binance (crypto — real live)
// ---------------------------------------------------------------------------

import { validateBars, dedupeBars, checkBar, minuteIslandFilter, type RawBar } from "@shared/feed-validation";
import { upsertBar, wsBackoffDelay, nextEndpointIndex, aggregateToSeconds } from "@shared/candle-core";

// Endpoints are tried in order and rotate on failure. The last WS entry and
// second REST host are Binance's official PUBLIC MARKET-DATA mirrors on a
// different domain (binance.vision) — ISP-level blocks of binance.com (common
// in several regions) do not take the live feed down with them.
const WS_ENDPOINTS = ["wss://stream.binance.com:9443", "wss://stream.binance.com:443", "wss://data-stream.binance.vision"];
const REST_HOSTS = ["api.binance.com", "data-api.binance.vision"];
const CONNECT_TIMEOUT_MS = 4000; // a blocked socket often hangs CONNECTING forever — force failover

class BinanceProvider {
  private ws: WebSocket | null = null;
  private streams = new Map<string, string>();     // "SYM:tf" → "sym@kline_int"
  private streamToKey = new Map<string, string>(); // incoming frame route
  private meta = new Map<string, { symbol: string; tf: Timeframe }>();
  private restHostIdx = 0;
  private wsEpIdx = 0;
  private wsWorks = false; // current endpoint delivered at least one frame
  private backoff = 1000;
  private lastMsgAt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private polls = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Map<string, Set<UpdateCb>>();
  private history = new Map<string, Bar[]>();
  private loadedAt = new Map<string, number>();

  async load(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const key = `${symbol}:${tf}`;
    // short-lived fresh cache — instant timeframe switching / remounts
    const fresh = this.history.get(key);
    if (fresh && Date.now() - (this.loadedAt.get(key) ?? 0) < 15000) return fresh;
    // Phase 24 BUG-2: sub-minute TFs walk THREE 1s kline pages back-to-back
    // (1000/page hard cap) — a single page held only ~16 minutes of 1s data,
    // so 15s/30s charts opened with a handful of candles
    let raw: Bar[];
    if (BINANCE_AGGREGATE[tf]) {
      const pages: Bar[] = [];
      let end: number | undefined = undefined;
      for (let page = 0; page < 3; page++) {
        const chunk = await this.fetchRecent(symbol, tf, 1000, end);
        if (!chunk.length) break;
        pages.unshift(...chunk);
        end = chunk[0].time * 1000 - 1;
        if (chunk.length < 1000) break;
      }
      raw = pages;
    } else {
      raw = await this.fetchRecent(symbol, tf, 1000);
    }
    // sub-minute TFs fetch the native 1s stream and aggregate honestly here
    const bars = BINANCE_AGGREGATE[tf] ? aggregateToSeconds(raw, TF_SECONDS[tf]) as Bar[] : raw;
    this.history.set(key, bars);
    this.loadedAt.set(key, Date.now());
    return bars;
  }

  /**
   * One-shot 24h ticker snapshot for the watchlist/explorer: { lastPrice,
   * priceChangePercent, open/high/low } per Binance symbol — a single REST
   * round-trip for every crypto row. The extra OHLC fields are the same
   * 24hr response's own numbers (no extra call, no synthetic data).
   */
  async ticker24h(binanceSymbols: string[]): Promise<Record<string, { price: number; changePct: number; open: number | null; high: number | null; low: number | null }>> {
    if (!binanceSymbols.length) return {};
    const q = encodeURIComponent(JSON.stringify(binanceSymbols));
    const raw: any[] = await this.restGet(`/api/v3/ticker/24hr?symbols=${q}`);
    const out: Record<string, { price: number; changePct: number; open: number | null; high: number | null; low: number | null }> = {};
    for (const t of raw) {
      const price = Number(t.lastPrice);
      const changePct = Number(t.priceChangePercent);
      if (!(price > 0)) continue;
      const open = Number(t.openPrice), high = Number(t.highPrice), low = Number(t.lowPrice);
      out[String(t.symbol)] = {
        price,
        changePct: Number.isFinite(changePct) ? changePct : 0,
        open: open > 0 ? open : null,
        high: high > 0 ? high : null,
        low: low > 0 ? low : null,
      };
    }
    return out;
  }

  /** REST klines fetch — used for history AND for gap-fill / safety polling. */
  private async fetchRecent(symbol: string, tf: Timeframe, limit: number, endTime?: number): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const endQ = endTime != null ? `&endTime=${endTime}` : "";
    const raw: any[] = await this.restGet(`/api/v3/klines?symbol=${inst.binance}&interval=${BINANCE_INTERVAL[tf]}&limit=${limit}${endQ}`);
    const mapped: RawBar[] = raw.map((k) => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      takerBuy: k[9] != null ? +k[9] : undefined,
    }));
    // Phase 10: every provider response passes OHLC validation (repair H/L
    // envelope, reject broken bars) before it can reach the chart
    const checked = validateBars(mapped);
    if (checked.invalid) statsState.invalidBars += checked.invalid;
    if (checked.repaired) statsState.repairedBars += checked.repaired;
    return checked.bars as Bar[];
  }

  /**
   * Progressive history: fetch up to `limit` closed candles OLDER than
   * `beforeTime` (exclusive). The chart prepends them when the user scrolls
   * or zooms out to the left edge. Binance-only — Yahoo ranges are fixed.
   */
  async loadOlder(symbol: string, tf: Timeframe, beforeTime: number, limit = 1000): Promise<Bar[]> {
    const raw = await this.fetchRecent(symbol, tf, limit, beforeTime * 1000 - 1);
    const filtered = raw.filter((b) => b.time < beforeTime);
    return BINANCE_AGGREGATE[tf] ? aggregateToSeconds(filtered, TF_SECONDS[tf]) as Bar[] : filtered;
  }

  /**
   * Phase 22 — fold one native-1s bar into its target sub-minute bucket.
   * Real OHLC semantics: running high/low, latest close, summed volume; a
   * late 1s frame folds into its OWN stored bucket instead of corrupting the
   * tail. Returns null when the tf needs no aggregation.
   */
  private aggBar(key: string, bar: Bar): Bar | null {
    const m = this.meta.get(key);
    if (!m || !BINANCE_AGGREGATE[m.tf]) return null;
    const sec = TF_SECONDS[m.tf];
    const t = Math.floor(bar.time / sec) * sec;
    const bars = this.history.get(key) || [];
    const cur = bars.length ? bars[bars.length - 1] : null;
    if (cur && cur.time === t) {
      return { time: t, open: cur.open, high: Math.max(cur.high, bar.high), low: Math.min(cur.low, bar.low), close: bar.close, volume: (cur.volume ?? 0) + (bar.volume ?? 0) };
    }
    const existing = bars.find((b) => b.time === t);
    if (existing) {
      // late frame for an older bucket — fold, never overwrite the history
      return { ...existing, high: Math.max(existing.high, bar.high), low: Math.min(existing.low, bar.low), close: bar.close, volume: (existing.volume ?? 0) + (bar.volume ?? 0) };
    }
    return { time: t, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  }

  /**
   * Phase 24 D3: merge scroll-back candles into the provider's OWN history —
   * the chart used to hold them only in its local ref, so the next WS frame
   * (which carries the provider's shorter series) wiped them 1-2s later and
   * every scroll re-fetched in a loop. Existing bars win on conflict.
   */
  prependHistory(symbol: string, tf: Timeframe, older: Bar[]): void {
    const key = `${symbol}:${tf}`;
    if (!older.length) return;
    const map = new Map<number, Bar>();
    for (const b of this.history.get(key) || []) map.set(b.time, b);
    for (const b of older) { if (!map.has(b.time)) map.set(b.time, b); }
    const merged = [...map.values()].sort((a, b) => a.time - b.time);
    this.history.set(key, merged);
  }

  /** REST with mirror failover: api.binance.com blocked → data-api.binance.vision. */
  private async restGet(path: string): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < REST_HOSTS.length; attempt++) {
      const idx = (this.restHostIdx + attempt) % REST_HOSTS.length;
      try {
        const res = await fetch(`https://${REST_HOSTS[idx]}${path}`);
        if (!res.ok) throw new Error(`binance ${res.status}`);
        const json = await res.json();
        this.restHostIdx = idx; // remember the working host
        return json;
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error("binance REST unreachable");
  }

  /** Fetch the last 2 klines and upsert them into the series (gap-fill).
   * Phase 24 D1: aggBar only folds for sub-minute TFs and returns null for
   * every standard timeframe — the old `if (folded)` gate made this entire
   * safety poll a NO-OP for 1m..1M, so a WS outage froze the chart and every
   * missed candle became a permanent gap. The raw bar is now used directly
   * when no aggregation applies. Phase 24 D2: bars fold SEQUENTIALLY against
   * the evolving series (the old two-at-once fold overwrote the first bar's
   * volume/H/L when both landed in the same sub-minute bucket). */
  private async resync(key: string, isRealtime = true) {
    const m = this.meta.get(key);
    if (!m || !this.listeners.get(key)?.size) return;
    const recentRaw = await this.fetchRecent(m.symbol, m.tf, 2);
    if (!recentRaw.length) return;
    let bars = this.history.get(key) || [];
    let changed = false;
    for (const raw of recentRaw) {
      const b = this.aggBar(key, raw) ?? raw; // sub-minute → fold · standard → as-is
      const prev = bars.find((x) => x.time === b.time);
      if (!prev || prev.close !== b.close || prev.high !== b.high || prev.low !== b.low || prev.volume !== b.volume) changed = true;
      bars = upsert(bars, b);
      if (this.aggBar(key, raw)) this.history.set(key, bars); // aggBar reads the live series — keep it current between folds
    }
    if (!changed) return;
    this.history.set(key, bars);
    this.loadedAt.set(key, Date.now());
    markTick();
    const lastBar = bars[bars.length - 1];
    this.listeners.get(key)?.forEach((c) => c({ bars, lastBar, isRealtime }));
  }

  subscribe(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    const stream = `${inst.binance!.toLowerCase()}@kline_${BINANCE_INTERVAL[tf]}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);
    const isNew = !this.streams.has(key);
    this.streams.set(key, stream);
    this.streamToKey.set(stream, key);
    this.meta.set(key, { symbol, tf });
    // ONE socket serves every open chart via a combined stream — a second
    // chart must never steal the first one's live feed (multi-chart layouts)
    if (!this.ws) this.openSocket();
    else if (isNew && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [stream], id: Date.now() % 1e9 })); } catch { /* resync covers it */ }
    }
    this.startWatchdog();
    // REST safety poll (2s): the chart must NEVER freeze. While the WS is
    // healthy (a message within the last 5s) the guard makes it free; the
    // moment the WS goes stale (blocked network, dead NAT, region issue) this
    // poll upserts the last 2 klines and keeps the candle moving.
    if (!this.polls.has(key)) {
      this.polls.set(key, setInterval(() => {
        if (this.history.get(key)?.length && Date.now() - this.lastMsgAt < 5000) return;
        void this.resync(key, false).catch(() => { /* transient — next tick retries */ });
      }, 2000));
    }
    return () => {
      const set = this.listeners.get(key);
      set?.delete(cb);
      if (set && set.size === 0) {
        const p = this.polls.get(key);
        if (p) { clearInterval(p); this.polls.delete(key); }
        const stream = this.streams.get(key);
        this.streams.delete(key);
        if (stream) this.streamToKey.delete(stream);
        this.meta.delete(key);
        if (this.ws && this.ws.readyState === WebSocket.OPEN && stream) {
          try { this.ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: [stream], id: Date.now() % 1e9 })); } catch { /* socket dying anyway */ }
        }
        if (this.streams.size === 0 && this.ws) {
          const ws = this.ws;
          this.ws = null;
          if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
          if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
          try { ws.close(); } catch { /* already dead */ }
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

  /** ONE combined-stream socket for every open chart. Endpoints are tried in
   * order and rotate on failure — data-stream.binance.vision is Binance's
   * official market-data mirror on a DIFFERENT domain, so ISP-level blocks of
   * binance.com (region issues) do not take the live feed down with it. */
  private openSocket() {
    const list = [...this.streams.values()];
    if (!list.length || this.ws) return;
    setConn({ binance: "connecting" });
    const host = WS_ENDPOINTS[this.wsEpIdx];
    const ws = new WebSocket(`${host}/stream?streams=${list.join("/")}`);
    this.ws = ws;
    this.lastMsgAt = Date.now();
    // a blocked socket often hangs CONNECTING forever — force failover
    this.connectTimer = setTimeout(() => { try { ws.close(); } catch { /* already dead */ } }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.backoff = 1000;
      setConn({ binance: "connected" });
      // explicit SUBSCRIBE covers streams added while the socket was opening
      try { ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [...this.streams.values()], id: Date.now() % 1e9 })); } catch { /* the combined URL already carries them */ }
      for (const key of this.streams.keys()) void this.resync(key).catch(() => { /* the WS stream will still update from now on */ });
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      this.wsWorks = true;
      setConn({ binance: "connected" });
      try {
        const payload = JSON.parse(ev.data);
        const k = payload?.data?.k ?? payload?.k;
        if (!k) return;
        const key = payload?.stream
          ? this.streamToKey.get(payload.stream)
          : (this.streamToKey.size === 1 ? [...this.streamToKey.values()][0] : undefined);
        if (!key) return;
        const bar: Bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, takerBuy: k.V != null ? +k.V : undefined };
        const chk = checkBar(bar);
        if (!chk.ok) { statsState.invalidBars++; return; } // corrupted frame — never reach the chart
        if (chk.repaired) { statsState.repairedBars++; bar.high = Math.max(bar.high, bar.open, bar.close); bar.low = Math.min(bar.low, bar.open, bar.close); }
        const folded = this.aggBar(key, bar) ?? bar;
        const bars = upsert(this.history.get(key) || [], folded);
        this.history.set(key, bars);
        this.loadedAt.set(key, Date.now());
        markTick();
        this.listeners.get(key)?.forEach((cb) => cb({ bars, lastBar: bar, isRealtime: true }));
      } catch { /* malformed frame — skip */ }
    };
    ws.onclose = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.ws = null;
      if (this.streams.size === 0) { setConn({ binance: "offline" }); return; } // last chart unmounted — normal shutdown
      setConn({ binance: "reconnecting" });
      // an endpoint that never delivered a frame is effectively blocked → rotate
      this.wsEpIdx = nextEndpointIndex(this.wsEpIdx, WS_ENDPOINTS.length, this.wsWorks);
      this.wsWorks = false;
      const delay = this.backoff;
      this.backoff = wsBackoffDelay(this.backoff);
      setTimeout(() => { if (this.streams.size && !this.ws) this.openSocket(); }, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* nothing */ } };
  }
}

// ---------------------------------------------------------------------------
// Quotes proxy (forex / metals / indices — real but delayed)
// ---------------------------------------------------------------------------

// ---- Phase 23 §5: deep history reads (server day-shard store) --------------
// The hist engine (api/_src/lib/hist.ts) holds years of genuine candles
// (stooq spot / Dukascopy / TwelveData) in per-day shards. Recorded live
// observations always WIN on conflicting timestamps — provider shards fill
// everything before them. Empty-window results are cached for 10 min so a
// not-yet-backfilled instrument never hammers the endpoint.
const histEmptyAt = new Map<string, number>();
const lastHistNote = new Map<string, string>();

async function fetchHistRange(symbol: string, tf: Timeframe, fromSec: number, toSec: number): Promise<{ bars: Bar[]; note: string }> {
  const cacheKey = `${symbol}:${tf}`;
  if (TF_SECONDS[tf] < 60) return { bars: [], note: "" }; // sub-minute: no stored history exists (live-built only)
  if (Date.now() - (histEmptyAt.get(cacheKey) || 0) < 600000) return { bars: [], note: "" };
  try {
    const res = await authedFetch<any>(`/api/quotes?action=hist-range&symbol=${encodeURIComponent(symbol)}&tf=${tf}&from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}`);
    if (res?.ok && Array.isArray(res.bars) && res.bars.length) {
      // client-side defense-in-depth: never trust the wire (§8)
      const checked = validateBars(res.bars as RawBar[]);
      const note = Object.keys(res.providers || {})[0] || "provider";
      lastHistNote.set(cacheKey, note);
      return { bars: checked.bars as Bar[], note };
    }
  } catch { /* engine not deployed yet / RTDB hiccup — the recorded path stands */ }
  histEmptyAt.set(cacheKey, Date.now());
  return { bars: [], note: "" };
}

/** Chart scroll-back loader: genuine stored history OLDER than the chart's
 * first bar — prepended by PriceChart's range handler without a reload. */
export async function quotesHistOlder(symbol: string, tf: Timeframe, beforeTime: number, targetBars = 3000): Promise<Bar[]> {
  if (beforeTime <= 0 || TF_SECONDS[tf] < 60) return [];
  const sec = TF_SECONDS[tf] || 60;
  const span = Math.min(targetBars * sec, 365 * 86400);
  const { bars } = await fetchHistRange(symbol, tf, Math.max(beforeTime - span, 0), beforeTime - 1);
  return bars.filter((b) => b.time < beforeTime);
}

class QuotesProvider {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Map<string, Set<UpdateCb>>();
  private history = new Map<string, Bar[]>();
  private loadedAt = new Map<string, number>();
  private inflight = new Set<string>();
  private source = new Map<string, string>(); // "yahoo" | "stooq" — surfaced in the feed message
  private spotOffs = new Map<string, () => void>(); // per-key unsubscribe from the shared spot ticker
  private spotProviderBars = new Map<string, number>(); // code → Twelve Data backfill bars
  private identity = new Map<string, string>(); // "spot" | "futures" — what the response actually represented
  // Phase 24 D3: scroll-back extensions kept SEPARATELY and re-merged into
  // every loadNetwork result — the poll replaces this.history from the wire,
  // so a naive prepend there would be wiped on the next 2s tick
  private extended = new Map<string, Bar[]>();

  prependHistory(symbol: string, tf: Timeframe, older: Bar[]): void {
    const key = `${symbol}:${tf}`;
    if (!older.length) return;
    const map = new Map<number, Bar>();
    for (const b of this.extended.get(key) || []) map.set(b.time, b);
    for (const b of this.history.get(key) || []) map.set(b.time, b); // live series wins on overlap
    for (const b of older) { if (!map.has(b.time)) map.set(b.time, b); }
    const merged = [...map.values()].sort((a, b) => a.time - b.time);
    this.extended.set(key, merged);
    // extended also seeds history directly so reads between polls see it
    this.history.set(key, merged);
  }

  /** Fold the stored extension back into a fresh server response (server wins
   * on overlapping times — its bars are the newest observation). */
  private mergeExtended(key: string, bars: Bar[]): Bar[] {
    const ext = this.extended.get(key);
    if (!ext?.length) return bars;
    const firstWire = bars.length ? bars[0].time : Infinity;
    const older = ext.filter((b) => b.time < firstWire);
    if (!older.length) return bars;
    return [...older, ...bars];
  }

  /** Drop the extension when the key is fully unsubscribed (memory bound). */
  forgetExtended(key: string): void {
    if (!this.listeners.get(key)?.size) this.extended.delete(key);
  }

  // network fetch + aggregation, always bypasses the fresh cache (poll path)
  private async loadNetwork(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const key = `${symbol}:${tf}`;
    const cfg = YAHOO_INTERVAL[tf];
    if (!cfg) throw new Error("NO_SOURCE_INTERVAL"); // sub-minute TFs never take this path (see availableTimeframes)
    const agg = YAHOO_AGGREGATE[tf];
    // prefer the target tf's own config when its interval equals the base
    // interval (4h: "1y/60m" gives ~4x deeper history than the 1h base's 3mo)
    const useCfg = agg
      ? (cfg.interval === YAHOO_INTERVAL[agg]?.interval ? cfg : YAHOO_INTERVAL[agg])
      : cfg;
    if (!useCfg) throw new Error("NO_SOURCE_INTERVAL");
    const res: any = await authedFetch(`/api/quotes?symbol=${encodeURIComponent(inst.yahoo!)}&range=${useCfg.range}&interval=${useCfg.interval}`);
    if (!res?.ok) throw new Error(res?.detail || "FEED_UNAVAILABLE");
    if (res.source) this.source.set(key, res.source);
    if (res.identity) this.identity.set(key, res.identity);
    if (res.delaySec != null) { statsState.delaySec = res.delaySec; statsState.delayBy[key] = res.delaySec; }
    // client-side defense-in-depth: the server already validates, but the
    // chart must never trust the wire — repair/drop before aggregation
    const checked = validateBars(res.bars as RawBar[]);
    const deduped = dedupeBars(checked.bars);
    statsState.invalidBars += checked.invalid;
    statsState.repairedBars += checked.repaired;
    statsState.duplicateBars += deduped.dropped;
    // Phase 17 → Phase 24 §3: SELF-HEALING Dukascopy store. The one-shot
    // session trigger left the FIRST chart load on Yahoo's close-only dots
    // and never retried when the store stayed thin. Now: fires on first
    // touch AND whenever the served 1m is flat-dominated (Yahoo fallback
    // won the chain) or thin (<200 bars) — with a 10-min per-pair cooldown.
    // The store fills in ~20s and the 2s poll then converges the chart to
    // genuine Dukascopy OHLC in the same session, no reload needed.
    if (inst.assetClass === "forex" && tf === "1m") {
      const served = deduped.bars as Bar[];
      const flatN = served.filter((b) => b.open === b.high && b.high === b.low && b.low === b.close).length;
      const needsHeal = served.length < 200 || (served.length > 0 && flatN / served.length > 0.2);
      const firstTouch = !fxBackfillTried.has(symbol);
      if ((needsHeal || firstTouch) && Date.now() - (fxSelfHealAt.get(symbol) ?? 0) > 600000) {
        fxBackfillTried.add(symbol);
        fxSelfHealAt.set(symbol, Date.now());
        authedFetch("/api/quotes?action=backfill-fx", { code: symbol, days: 35 }).catch(() => { /* cooldown/best-effort */ });
      }
    }
    let bars: Bar[] = deduped.bars as Bar[];
    // Phase 20 defense-in-depth: Yahoo's FX intraday 1m is CLOSE-ONLY
    // (O=H=L=C on every bar — verified 2026-11-19). The server rejects it
    // (FLAT_FX_OHLC), but the chart never trusts the wire: a flat FX
    // intraday series here means the whole server chain failed — refuse it
    // rather than render the dot-candle defect.
    if (inst.assetClass === "forex" && TF_SECONDS[tf] < 86400 && bars.length > 20
      && bars.filter((b) => b.open === b.high && b.high === b.low && b.low === b.close).length / bars.length >= 0.9) {
      throw new Error("FLAT_FX_OHLC: provider returned close-only bars — refusing dot candles");
    }
    // bucket length = the TARGET timeframe in minutes (3m→3, 2h→120, 4h→240).
    // The old TF_SECONDS[tf]/TF_SECONDS[agg] ratio only happens to be minutes
    // for the 1m base: from the 1h base it passed 2/4 "minutes" → 2- and
    // 4-MINUTE buckets → the 2h and 4h charts actually rendered 1h candles.
    if (agg) bars = aggregateBars(bars, TF_SECONDS[tf] / 60);
    bars = dedupSort(bars);
    const merged = this.mergeExtended(key, bars); // Phase 24 D3: scroll-back survives the 2s poll
    this.history.set(key, merged);
    this.loadedAt.set(key, Date.now());
    return merged;
  }

  async load(symbol: string, tf: Timeframe): Promise<{ bars: Bar[]; source?: string; identity?: string }> {
    const key = `${symbol}:${tf}`;
    // short-lived fresh cache: instant timeframe switching + remounts
    const fresh = this.history.get(key);
    if (fresh && Date.now() - (this.loadedAt.get(key) ?? 0) < 15000) {
      return { bars: fresh, source: this.source.get(key), identity: this.identity.get(key) };
    }
    const bars = await this.loadNetwork(symbol, tf);
    return { bars, source: this.source.get(key), identity: this.identity.get(key) };
  }

  subscribe(symbol: string, tf: Timeframe, cb: UpdateCb): () => void {
    const key = `${symbol}:${tf}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);
    const inst = getInstrument(symbol);
    const spotCode = inst?.spotCode;

    // ---- Phase 16: metals run on the SELF-RECORDED spot engine -------------
    // There is no keyless provider of real XAUUSD-SPOT 1m OHLC history, and
    // Yahoo GC=F is a COMEX futures contract (a different instrument, ~10 min
    // delayed) that must never be mixed into a spot chart. So metals charts
    // are built entirely from the terminal's own recorded spot candles: the
    // 1s gold-api poller folds each observed price into real minute candles
    // (local + server merge), higher timeframes aggregate up from m1, and no
    // Yahoo/stooq REST history poll runs for metals at all.
    if (!spotCode) {
      const tick = async () => {
        // in-flight guard: a slow response must never stack requests or let an
        // older answer overwrite a newer one (chart jumping backwards)
        if (this.inflight.has(key)) return;
        this.inflight.add(key);
        try {
          await this.loadNetwork(symbol, tf);
          const bars = this.history.get(key)!;
          if (bars.length) { markTick(); this.listeners.get(key)?.forEach((c) => cb({ bars, lastBar: bars[bars.length - 1], isRealtime: false })); }
        } catch { /* transient — next poll retries */ } finally {
          this.inflight.delete(key);
        }
      };
      // first tick right away — but skip it when the history was just fetched
      // (fresh cache), so mounting the chart never duplicates the load request
      if (Date.now() - (this.loadedAt.get(key) ?? 0) > 10000) void tick();
      // REST polling — forex majors poll every 2s: the server folds the LIVE
      // TrueFX bid into the tail per request (genuine interbank tick cadence,
      // ~0s fresh measured), so the poll WAS the visible bottleneck. Indices
      // keep 10s — Yahoo reference data is delayed regardless.
      if (!this.timers.has(key)) { // StrictMode double-subscribe: keep the FIRST handle, don't leak it
        const timer = setInterval(tick, inst?.assetClass === "forex" ? 2000 : 10000);
        this.timers.set(key, timer);
      }
    }

    // ---- real-time spot tail + recorder (metals) ----------------------------
    // gold-api.com serves the genuine spot price with CORS * and a fresh
    // updatedAt stamp — poll it DIRECTLY from the browser every second, paint
    // the live bucket, and RECORD the price into the self-built candle set.
    let spotResync: ReturnType<typeof setInterval> | null = null;
    if (spotCode) {
      ensureSpotFlusher();
      setSpotState({ state: "connecting", lastTickAt: 0, providerDelaySec: null });
      // Phase 18 tick-feed investigation: gold-api serves REST only — there is
      // NO WebSocket/tick stream, and its price stamp (updatedAt) advances
      // roughly every 5–15s (verified live). Phase 22: ONE shared 1s poll per
      // spot code now feeds EVERY open subscription (a second chart at another
      // timeframe used to run its own poller — duplicate connections); each
      // subscriber merges the tick into its own series below.
      // Sub-minute timeframes build LIVE candles from the actual received
      // quotes (first observed price = open, running high/low, latest close,
      // sample-count volume) — nothing fabricated, empty seconds stay empty.
      const sec = TF_SECONDS[tf];
      const offSpot = spotTickerOn(spotCode, key, (price) => {
        const bars = this.history.get(key);
        if (!bars?.length) {
          if (sec >= 60) {
            // the very first recorded minute just opened — pull it into the
            // chart immediately instead of waiting for the 3 min resync
            void this.loadRecordedSpot(symbol, tf).then((fresh) => {
              if (fresh?.length) {
                this.listeners.get(key)?.forEach((c) => cb({ bars: fresh, lastBar: fresh[fresh.length - 1], isRealtime: false }));
              }
            }).catch(() => { /* transient — the next tick retries */ });
            return;
          }
          // seconds candles start live from the first REAL observed quote
          const t = Math.floor(Date.now() / 1000 / sec) * sec;
          const first: Bar = { time: t, open: price, high: price, low: price, close: price, volume: 1 };
          this.history.set(key, [first]);
          markTick();
          this.listeners.get(key)?.forEach((c) => cb({ bars: [first], lastBar: first, isRealtime: true }));
          return;
        }
        if (tf !== "1d") {
          if (sec < 60) {
            const t = Math.floor(Date.now() / 1000 / sec) * sec;
            const last = bars[bars.length - 1];
            if (t < last.time) return; // stale sample — never rewrite history
            const cur: Bar = last.time === t
              ? { time: t, open: last.open, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, volume: (last.volume ?? 0) + 1 }
              : { time: t, open: price, high: price, low: price, close: price, volume: 1 };
            const next = last.time === t ? [...bars.slice(0, -1), cur] : [...bars, cur].slice(-3600);
            this.history.set(key, next);
            markTick();
            statsState.delaySec = getSpotState().providerDelaySec;
            statsState.delayBy[key] = getSpotState().providerDelaySec;
            this.listeners.get(key)?.forEach((c) => cb({ bars: next, lastBar: cur, isRealtime: true }));
            return;
          }
          // bridging fill-forward is capped at 5 buckets for recorded data:
          // beyond that the missing minutes stay an honest gap on the axis
          const merged = mergeSpotTail(bars, price, sec, 5);
          if (merged) {
            this.history.set(key, merged);
            statsState.delaySec = getSpotState().providerDelaySec;
            statsState.delayBy[key] = getSpotState().providerDelaySec;
            markTick();
            this.listeners.get(key)?.forEach((c) => cb({ bars: merged, lastBar: merged[merged.length - 1], isRealtime: true }));
          }
        }
      });
      this.spotOffs.set(key, offSpot);

      // slow resync of the recorded history (other devices' observations merge
      // in; 3 min cadence keeps RTDB reads negligible)
      spotResync = setInterval(async () => {
        if (this.inflight.has(key)) return;
        this.inflight.add(key);
        try {
          await this.loadRecordedSpot(symbol, tf);
          const bars = this.history.get(key)!;
          if (bars.length) this.listeners.get(key)?.forEach((c) => cb({ bars, lastBar: bars[bars.length - 1], isRealtime: false }));
        } catch { /* transient */ } finally {
          this.inflight.delete(key);
        }
      }, 180000);
      if (!this.timers.has(`${key}:rec`)) this.timers.set(`${key}:rec`, spotResync);
      else clearInterval(spotResync); // duplicate subscribe — drop the extra handle
    }
    return () => {
      const timer = this.timers.get(key);
      if (timer) clearInterval(timer);
      this.timers.delete(key);
      this.spotOffs.get(key)?.();
      this.spotOffs.delete(key);
      if (spotResync) { clearInterval(spotResync); this.timers.delete(`${key}:rec`); }
      this.listeners.get(key)?.delete(cb);
    };
  }

  /**
   * Phase 16 — load the SELF-RECORDED spot history for a metals instrument
   * and place the aggregated series for `tf` into the history cache. Sources:
   * server RTDB merge (all devices) ∪ localStorage (this device) ∪ the
   * in-progress minute. Pure spot — no futures, no delayed proxies.
   */
  async loadRecordedSpot(symbol: string, tf: Timeframe): Promise<Bar[]> {
    const inst = getInstrument(symbol)!;
    const code = inst.spotCode!;
    // sub-minute TFs have NO recorded history source (the recorder is
    // minute-grained by design) — seconds candles build LIVE from the actual
    // 1s quotes; this returns an empty series that the live tick fills.
    if (TF_SECONDS[tf] < 60) {
      const keyS = `${symbol}:${tf}`;
      if (!this.history.get(keyS)) this.history.set(keyS, []);
      this.source.set(keyS, "spot-live(seconds)");
      this.identity.set(keyS, "spot");
      this.loadedAt.set(keyS, Date.now());
      return this.history.get(keyS)!;
    }
    const now = Math.floor(Date.now() / 1000);
    const loadServerCandles = async (): Promise<SpotCandle[]> => {
      try {
        const res = await authedFetch<any>(`/api/quotes?action=spot-history&code=${code}`);
        if (res?.ok && Array.isArray(res.candles)) {
          const out = (res.candles as SpotCandle[]).filter((c: any) => validSpotCandle(c, now, 30 * 86400));
          const providerBars = out.filter((c: SpotCandle) => c.s === 0).length;
          if (providerBars > 0) this.spotProviderBars.set(code, providerBars);
          return out;
        }
      } catch { /* server unavailable → local records only */ }
      return [];
    };
    const assemble = async (serverCandles: SpotCandle[]) => {
      let cs = mergeSpotSeries(serverCandles, loadLocalSpot(code));
      // include the in-progress minute + unflushed completions
      const st = spotRec.get(code);
      if (st) cs = mergeSpotSeries(cs, [...st.unflushed, ...(st.minute ? [st.minute] : [])].filter((c) => validSpotCandle(c, now)));
      saveLocalSpot(code, cs);
      const m1raw: Bar[] = cs.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.s }));
      // Phase 20: reject stuck-price glitch islands ALREADY in the store (the
      // recorder guard only protects ticks recorded from now on) — a provider
      // that served a stale price for hours must not reach the chart as
      // "separate candle groups". The rejection count is surfaced honestly in
      // the feed badge message.
      const island = minuteIslandFilter(m1raw as RawBar[]);
      return { candles: cs, m1: island.bars as Bar[], islandRejected: island.rejected };
    };

    let { candles, m1, islandRejected } = await assemble(await loadServerCandles());

    // Phase 16 + Twelve Data backfill — Phase 20.3 widened triggers: a thin
    // store, a BIG RECENT GAP (chart closed, device asleep — the visible
    // 12:50→17:38 hole), SPARSE coverage of market hours (gold-api lagging →
    // the honest recorder skips minutes), or glitch bars the island filter
    // just rejected all mean the chart needs genuine provider 1m OHLC to be
    // continuous. Twelve Data carries today's real XAU/USD minutes; the
    // server merges with recorded-wins semantics and replaces >2%-conflicting
    // stuck bars. The key lives server-side, never in the repo.
    const inMarketHours = (t: number): boolean => {
      // metals session: Sun 22:00 UTC → Fri 21:00 UTC (the Fri-evening→Sunday
      // window is closed — missing minutes there are honest, not holes)
      const d = new Date(t * 1000);
      const dow = d.getUTCDay();
      const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
      if (dow === 6) return false; // Saturday
      if (dow === 5) return mins < 21 * 60; // Friday before 21:00
      if (dow === 0) return mins >= 22 * 60; // Sunday after 22:00
      return true;
    };
    const nowMin = Math.floor(now / 60) * 60;
    const back6h = m1.filter((b) => b.time >= nowMin - 6 * 3600 && b.time <= nowMin);
    let expected6h = 0;
    for (let t = nowMin - 6 * 3600; t <= nowMin; t += 60) if (inMarketHours(t)) expected6h++;
    const coverage = expected6h > 0 ? back6h.length / expected6h : 1;
    const recent = m1.filter((b) => b.time >= now - 86400);
    let recentGap = 0;
    for (let i = 1; i < recent.length; i++) recentGap = Math.max(recentGap, recent[i].time - recent[i - 1].time - 60);
    if (recent.length && recent[0].time > now - 86400 + 1800) recentGap = Math.max(recentGap, 1800);
    const needsBackfill = candles.length < 500 || islandRejected > 0 || recentGap >= 1800 || coverage < 0.75;
    if (needsBackfill && Date.now() - (spotBackfillAt.get(code) || 0) > SPOT_BACKFILL_TTL_MS) {
      spotBackfillAt.set(code, Date.now());
      try {
        const r = await authedFetch<any>("/api/quotes?action=backfill-spot", { code });
        if (r?.ok && r.written > 0) {
          ({ candles, m1, islandRejected } = await assemble(await loadServerCandles()));
        } else if (r && r.reason === "cooldown") {
          spotBackfillAt.delete(code); // gate-blocked — retry on the next resync
        }
      } catch { /* backfill is best-effort */ }
    }

    // ---- Phase 24 BUG: sub-minute timeframes are LIVE-ONLY ------------------
    // Folding minute candles into second buckets put every minute in exactly
    // ONE second bucket — a sparse string of flat dots that then BLOCKED the
    // live seconds builder (history looked non-empty). No free source carries
    // second-grain history for metals, so the honest answer is an empty
    // initial series; subscribeFeed's seconds branch builds real candles from
    // the first observed 1s gold-api quote onward (§7: nothing fabricated).
    const key = `${symbol}:${tf}`;
    const sec = TF_SECONDS[tf];
    if (sec < 60) {
      this.source.set(key, "spot-seconds-live");
      this.identity.set(key, "spot");
      this.history.set(key, []);
      this.loadedAt.set(key, Date.now());
      return [];
    }
    // ---- Phase 23 §5: deep history merge (day-shard store) ------------------
    // Minute grain: hist m1 + recorded m1 in one stream (recorded wins on
    // conflict), then aggregate as before. Hour+/daily: hist NATIVE shards
    // (stooq 60m/d1 — genuine OHLC, never folded futures) + the recorded
    // aggregate in front. Nothing fabricated; the island filter already ran
    // on the recorded side and every shard was validated at write time.
    const histWinDays = sec >= 86400 ? 365 : sec >= 3600 ? 90 : 10;
    let m1merged = m1;
    let deepBars: Bar[] = [];
    if (sec >= 60) {
      const hist = await fetchHistRange(symbol, sec >= 3600 ? tf : ("1m" as Timeframe), now - histWinDays * 86400, now);
      deepBars = hist.bars;
      if (deepBars.length) {
        if (sec < 3600) {
          const byTime = new Map<number, Bar>();
          for (const b of deepBars) byTime.set(b.time, b);
          for (const b of m1) byTime.set(b.time, b); // recorded wins
          m1merged = [...byTime.values()].sort((a, b) => a.time - b.time);
        }
      }
    }
    lastSpotIslandRejected = islandRejected;
    // seed the recorder's glitch anchor from the clean tail
    if (m1.length) spotAnchor.set(code, { close: m1[m1.length - 1].close, at: Date.now() });
    const bars = dedupSort(
      sec < 3600
        ? (sec === 60 ? m1merged.slice() : aggregateBars(m1merged, sec / 60))
        : (() => {
            const recAgg = aggregateBars(m1, sec / 60) as Bar[];
            if (!deepBars.length) return recAgg;
            const byTime = new Map<number, Bar>();
            for (const b of deepBars) byTime.set(b.time, b);
            for (const b of recAgg) byTime.set(b.time, b); // recorded wins
            return [...byTime.values()].sort((a, b) => a.time - b.time);
          })(),
    );
    this.source.set(key, deepBars.length ? `spot+deep-history(${lastHistNote.get(key) || "provider"})` : (tf === "1m" ? "spot-recorded(1m)" : `spot-recorded→${tf}`));
    this.identity.set(key, "spot");
    const merged = this.mergeExtended(key, bars);
    this.history.set(key, merged);
    this.loadedAt.set(key, Date.now());
    return merged;
  }

  /** Twelve Data backfill bars merged into the recorded set (for the badge). */
  providerBarCount(code: string): number {
    return this.spotProviderBars.get(code) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Live spot tail — see client/src/lib/spot-tail.ts (pure, unit-tested module).
// ---------------------------------------------------------------------------
import { mergeSpotTail, recordSpotTick, mergeSpotSeries, validSpotCandle, type SpotCandle } from "@/lib/spot-tail";
export { mergeSpotTail };

// ---- Phase 22: shared spot ticker (one 1s poll per code, N subscribers) ----
// One gold-api connection per metal no matter how many charts/timeframes are
// open, and MEASURED provider cadence: the interval between DISTINCT
// published prices — the honest "how often does this feed actually move"
// number (polling frequency ≠ provider frequency ≠ render frequency).
type SpotHandler = (price: number, providerAt: number) => void;
const spotTicker = new Map<string, {
  handlers: Map<string, SpotHandler>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
  fails: number;
  lastPrice: number;
  lastChangeAt: number;
  intervals: number[];
}>();

function spotTickerOn(code: string, key: string, handler: SpotHandler): () => void {
  let e = spotTicker.get(code);
  if (!e) {
    e = { handlers: new Map(), timer: null, inflight: false, fails: 0, lastPrice: 0, lastChangeAt: 0, intervals: [] };
    spotTicker.set(code, e);
  }
  e.handlers.set(key, handler);
  if (!e.timer) {
    void spotPoll(code); // immediate first observation
    e.timer = setInterval(() => void spotPoll(code), 1000);
  }
  return () => {
    const cur = spotTicker.get(code);
    if (!cur) return;
    cur.handlers.delete(key);
    if (!cur.handlers.size && cur.timer) { clearInterval(cur.timer); cur.timer = null; }
    if (!cur.handlers.size) spotTicker.delete(code);
  };
}

async function spotPoll(code: string): Promise<void> {
  const e = spotTicker.get(code);
  if (!e || e.inflight) return;
  e.inflight = true;
  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`https://api.gold-api.com/price/${code}`, { signal: controller.signal });
    clearTimeout(abortTimer);
    if (!res.ok) throw new Error(`gold-api ${res.status}`);
    const data: any = await res.json();
    const price = Number(data?.price);
    // the provider stamps its own price — that stamp is the honest latency
    // number the badge reports (not our poll round-trip)
    const providerAt = Date.parse(data?.updatedAt || "") || 0;
    if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
    const providerDelaySec = providerAt ? Math.max(0, Math.round((Date.now() - providerAt) / 1000)) : null;
    if (providerDelaySec != null && providerDelaySec > 600) throw new Error("STALE_SPOT"); // market closed
    const now = Date.now();
    if (e.lastPrice && price !== e.lastPrice && e.lastChangeAt) {
      e.intervals.push(now - e.lastChangeAt);
      if (e.intervals.length > 24) e.intervals.shift();
    }
    if (price !== e.lastPrice) { e.lastPrice = price; e.lastChangeAt = now; }
    // record the observed price into the self-built candle set (every
    // timeframe benefits — the recorder is timeframe-independent)
    recordSpot(code, price);
    e.fails = 0;
    setSpotState({ state: "live", lastTickAt: now, providerDelaySec });
    for (const h of e.handlers.values()) h(price, providerAt);
  } catch {
    e.fails += 1;
    if (e.fails >= 5) setSpotState({ state: "disconnected", lastTickAt: getSpotState().lastTickAt, providerDelaySec: null });
  } finally {
    e.inflight = false;
  }
}

/** Measured mean interval (s) between DISTINCT provider prices — null until
 *  at least two different prices were observed this session. */
export function spotMeasuredUpdateSec(code: string): number | null {
  const e = spotTicker.get(code);
  if (!e || e.intervals.length === 0) return null;
  const mean = e.intervals.reduce((s, x) => s + x, 0) / e.intervals.length;
  return Math.round((mean / 1000) * 10) / 10;
}

// ---- Phase 16: self-recorded spot candles (XAU / XAG) ----------------------
// Every 1s gold-api observation is folded into a real minute candle. Finished
// minutes persist to localStorage immediately and batch-merge to the server
// every ~20s so ALL devices converge on the same recorded candle set. There
// is deliberately NO seeding: candles exist only where ticks were actually
// observed — gaps stay gaps.
const SPOT_REC_KEY = (code: string) => `it_spot_rec_${code}`;
const SPOT_REC_MAX = 4320; // 3 days of minutes per code (quota-safe)
const spotRec = new Map<string, { minute: SpotCandle | null; unflushed: SpotCandle[] }>();
/** last successful Twelve Data backfill trigger per code — a 45-minute TTL
 *  lets a still-sparse store re-trigger on later resyncs while the server's
 *  2-minute gate protects TD's 8 req/min budget */
const spotBackfillAt = new Map<string, number>();
const SPOT_BACKFILL_TTL_MS = 45 * 60000;
const fxBackfillTried = new Set<string>();
const fxSelfHealAt = new Map<string, number>(); // per-pair self-heal cooldown
/** glitch-island bars rejected from the recorded spot history (last load) —
 *  surfaced in the feed badge so the data rejection is visible, not silent */
let lastSpotIslandRejected = 0;

function loadLocalSpot(code: string): SpotCandle[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SPOT_REC_KEY(code)) || "[]");
    return Array.isArray(arr) ? arr.filter((c: any) => c && Number.isFinite(c.t)) : [];
  } catch { return []; }
}

function saveLocalSpot(code: string, candles: SpotCandle[]) {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 8 * 86400;
    localStorage.setItem(SPOT_REC_KEY(code), JSON.stringify(candles.filter((c) => c.t >= cutoff).slice(-SPOT_REC_MAX)));
  } catch { /* quota exceeded — recorder degrades to in-memory */ }
}

/** Fold one observed spot price into the recorder (minute bucketing).
 *  Phase 20 glitch guard: gold-api once served a STALE price (~3655 vs the
 *  real ~3700-3740 market) stamped with a FRESH updatedAt for hours — every
 *  bad tick became a "real" recorded candle and the store grew a ~2% price
 *  island that rendered as disconnected candle groups. A recorded tick must
 *  sit within 2% of the last accepted close: metals cannot move 2% between
 *  1-second observations (the same bound the live-tail outlier guard uses).
 *  The anchor follows every accepted tick, so genuine trends record fine. */
const spotAnchor = new Map<string, { close: number; at: number }>();
const SPOT_GLITCH_REJECT_MS = 30 * 60000; // a stale anchor never blocks fresh truth

function recordSpot(code: string, price: number) {
  if (!(price > 0)) return;
  const anchor = spotAnchor.get(code);
  if (anchor && anchor.close > 0 && Date.now() - anchor.at < SPOT_GLITCH_REJECT_MS
    && Math.abs(price / anchor.close - 1) > 0.02) {
    statsState.spotGlitchTicks++;
    return; // glitched provider tick — never recorded, never rendered
  }
  const state = spotRec.get(code) ?? { minute: null as SpotCandle | null, unflushed: [] as SpotCandle[] };
  const prev = state.minute;
  const next = recordSpotTick(prev, price, Math.floor(Date.now() / 1000));
  if (prev && next.t !== prev.t) {
    // minute completed → persist locally + queue for the server merge
    saveLocalSpot(code, mergeSpotSeries(loadLocalSpot(code), [prev]));
    if (prev.s > 0 && state.unflushed.length < 60) state.unflushed.push(prev);
  }
  state.minute = next;
  spotRec.set(code, state);
  spotAnchor.set(code, { close: next.c, at: Date.now() });
}

/** Push unflushed minute candles to the server (bounded, idempotent merge). */
async function flushSpotRecords() {
  for (const [code, st] of spotRec) {
    if (!st.unflushed.length) continue;
    const batch = st.unflushed.splice(0, 30);
    try {
      const res = await authedFetch<any>("/api/quotes?action=spot-record", { records: [{ code, candles: batch }] });
      if (!res?.ok) st.unflushed.unshift(...batch); // retry later
    } catch {
      st.unflushed.unshift(...batch); // offline — keep, localStorage already has them
    }
  }
}
/** Recorded m1 minutes for a code (server-unknown here: local + in-progress). */
export function recordedMinuteCount(code: string): number {
  const st = spotRec.get(code);
  const pending = st ? st.unflushed.length + (st.minute ? 1 : 0) : 0;
  return loadLocalSpot(code).length + pending;
}

let spotFlushTimer: ReturnType<typeof setInterval> | null = null;
function ensureSpotFlusher() {
  if (spotFlushTimer) return;
  spotFlushTimer = setInterval(() => { void flushSpotRecords(); }, 20000);
  // also flush when the tab hides/closes — candles must not be lost
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => { if (document.hidden) void flushSpotRecords(); });
  }
}

// ---- spot connection store — honest badge state for the live tail ----------
export type SpotConn = "connecting" | "live" | "disconnected";
export interface SpotState {
  state: SpotConn;
  lastTickAt: number;
  /** the provider's own freshness (updatedAt stamp age) in seconds */
  providerDelaySec: number | null;
}
let spotState: SpotState = { state: "connecting", lastTickAt: 0, providerDelaySec: null };
let spotSnapshot: SpotState = { ...spotState };
const spotListeners = new Set<() => void>();
function setSpotState(next: SpotState) {
  if (spotState.state === next.state && spotState.providerDelaySec === next.providerDelaySec
    && next.state === "live" && Date.now() - spotState.lastTickAt < 500) return;
  spotState = next;
  spotSnapshot = { ...next };
  spotListeners.forEach((l) => l());
}
export function getSpotState(): SpotState { return spotSnapshot; }
export function subscribeSpot(cb: () => void): () => void {
  spotListeners.add(cb);
  return () => spotListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const binanceProvider = new BinanceProvider();
export const quotesProvider = new QuotesProvider();

/** Phase 24 D3: chart scroll-back persists at the provider level (see
 * QuotesProvider.prependHistory) — exposed without leaking the instance. */
export function quotesPrependHistory(symbol: string, tf: Timeframe, older: Bar[]): void {
  quotesProvider.prependHistory(symbol, tf, older);
}

// ---------------------------------------------------------------------------
// Connection state store — honest feed status for the chart badge.
// binance: connecting → connected | reconnecting (WS down, REST safety poll
// keeps the candle moving) · lastTickAt: the moment the latest real update
// arrived (WS frame OR REST resync/poll — never fabricated).
// ---------------------------------------------------------------------------

export type BinanceConn = "connecting" | "connected" | "reconnecting" | "offline";

export interface ConnectionState {
  binance: BinanceConn;
  /** epoch ms of the last real data update (any provider) */
  lastTickAt: number;
}

const connState: ConnectionState = { binance: "connecting", lastTickAt: 0 };
const connListeners = new Set<() => void>();
let connSnapshot: ConnectionState = { ...connState };

// hot per-tick counters live OUTSIDE the connection snapshot: they change on
// every data delivery, and firing React subscriptions per frame would
// re-render the chart for every WS message (Phase 10 perf fix).
export interface FeedStats {
  invalidBars: number;
  /** bars kept but High/Low widened to cover the body */
  repairedBars: number;
  duplicateBars: number;
  outOfOrderTicks: number;
  /** provider ticks rejected by the recorder's 2% glitch guard (Phase 20) */
  spotGlitchTicks: number;
  /** epoch ms of the last real data delivery (any provider) */
  lastTickAt: number;
  /** epoch ms of the last chart-applied update */
  lastChartUpdateAt: number;
  /** data ticks delivered in the last 10 seconds */
  tps10s: number;
  /** measured provider delay in seconds when the provider reports it */
  delaySec: number | null;
  /** per symbol:tf delay map — badges must never show another pair's delay */
  delayBy: Record<string, number | null>;
}

const statsState: FeedStats = {
  invalidBars: 0, repairedBars: 0, duplicateBars: 0, outOfOrderTicks: 0, spotGlitchTicks: 0,
  lastTickAt: 0, lastChartUpdateAt: 0, tps10s: 0, delaySec: null,
  delayBy: {} as Record<string, number | null>, // per symbol:tf — one pair's delay must never label another's badge
};
const tickTimes: number[] = [];

function setConn(patch: Partial<ConnectionState>) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "lastTickAt") continue; // hot field — stats store owns it
    if ((connState as any)[k] !== v) { (connState as any)[k] = v; changed = true; }
  }
  if (changed) {
    connSnapshot = { binance: connState.binance, lastTickAt: statsState.lastTickAt };
    connListeners.forEach((l) => l());
  }
}

/** Mark a real data delivery (WS frame, REST resync, quotes poll tick). */
export function markTick() {
  const now = Date.now();
  statsState.lastTickAt = now;
  tickTimes.push(now);
  while (tickTimes.length && now - tickTimes[0] > 10000) tickTimes.shift();
  statsState.tps10s = tickTimes.length;
  connSnapshot = { binance: connState.binance, lastTickAt: now };
}

/** The chart applied an update to the series (bars actually moved). */
export function markChartUpdate() {
  statsState.lastChartUpdateAt = Date.now();
}

export function bumpStat(kind: "invalidBars" | "duplicateBars" | "outOfOrderTicks") {
  statsState[kind]++;
}

export function setMeasuredDelay(sec: number | null, key?: string) {
  statsState.delaySec = sec;
  if (key) statsState.delayBy[key] = sec;
}

export function getFeedStats(): FeedStats {
  return { ...statsState, tps10s: tickTimes.length };
}

export function getConnectionState(): ConnectionState {
  return connSnapshot;
}

export function subscribeConnection(cb: () => void): () => void {
  connListeners.add(cb);
  return () => connListeners.delete(cb);
}

export interface LoadResult {
  bars: Bar[];
  status: FeedStatus;
  message?: string;
  /** measured provider delay (seconds) when the provider reports it */
  delaySec?: number | null;
}

/**
 * Load history for an instrument+tf from REAL providers only.
 * Throws a descriptive error on failure — the chart shows an error state with
 * a retry button. No generated/random prices, ever.
 */
import { assertPriceIdentity } from "@shared/feed-validation";
export { assertPriceIdentity };

export async function loadFeed(symbol: string, tf: Timeframe): Promise<LoadResult> {
  const inst = getInstrument(symbol);
  if (!inst) throw new Error(`Unknown instrument: ${symbol}`);
  if (inst.feed === "binance") {
    const bars = await binanceProvider.load(symbol, tf);
    assertPriceIdentity(inst, bars);
    return { bars, status: "live" };
  }
  // ---- Phase 16: metals = SELF-RECORDED spot engine ------------------------
  // Real XAUUSD Spot candles built from observed gold-api ticks. COMEX
  // futures (GC=F) and stooq CSV are NEVER mixed into a spot chart; history
  // availability is reported honestly (candles exist only where ticks were
  // actually observed).
  if (inst.spotCode) {
    const bars = await quotesProvider.loadRecordedSpot(symbol, tf);
    assertPriceIdentity(inst, bars);
    const m1 = recordedMinuteCount(inst.spotCode);
    const td = quotesProvider.providerBarCount(inst.spotCode);
    const delaySec = getSpotState().providerDelaySec;
    const hist = m1 > 0 ? `m1 history: ${m1} min${td > 0 ? ` (${td} Twelve Data backfill)` : ""}` : "recording started — candles build in real time";
    const deep = lastHistNote.get(`${symbol}:${tf}`);
    const secNote = TF_SECONDS[tf] < 60 ? "second candles build LIVE from 1s spot quotes (no second-grain history exists free)" : "";
    const glitch = lastSpotIslandRejected > 0 ? ` · ${lastSpotIslandRejected} glitch bars rejected` : "";
    // Phase 19 §6: name the underlier explicitly — Spot Gold/Silver (physical
    // spot, gold-api), never "Gold" which reads as the COMEX futures contract
    const metalName = symbol === "XAUUSD" ? "Spot Gold" : symbol === "XAGUSD" ? "Spot Silver" : `${symbol} Spot`;
    const message = `${metalName} · gold-api live 1s · ${hist}${deep ? ` · deep history: ${deep}` : ""}${secNote ? ` · ${secNote}` : ""}${glitch}`;
    return { bars, status: "polling", message, delaySec };
  }
  const { bars, source, identity } = await quotesProvider.load(symbol, tf);
  assertPriceIdentity(inst, bars);
  // honest labelling — FX/indices keep their real (delayed) providers and the
  // badge names the ACTUAL underlier of every bar. Per-key delay: the module
  // global carried the LAST LOADED symbol's number onto every other badge.
  const keyNow = `${symbol}:${tf}`;
  const delaySec = statsState.delayBy[keyNow] ?? statsState.delayBy[symbol] ?? null;
  const delayNote = delaySec != null && delaySec >= 60 ? ` · ~${Math.max(1, Math.round(delaySec / 60))} min` : delaySec != null && delaySec > 5 ? ` · ~${delaySec}s` : "";
  let message: string;
  if (source?.startsWith("spot+stooq") || source === "stooq") {
    message = `Gold spot · live gold-api tail + stooq spot history${delayNote}`;
  } else if (source?.startsWith("spot+yahoo")) {
    message = `Live spot (gold-api) tail · older bars delayed${delayNote}`;
  } else if (source?.startsWith("truefx")) {
    message = `FX live (TrueFX) real-time tail${delayNote}`;
  } else if (inst.assetClass === "forex") {
    const srcName = source === "fx-store+live" ? "Dukascopy + TrueFX live" : source === "dukascopy-store" ? "Dukascopy store" : source === "twelvedata" ? "Twelve Data" : "Yahoo";
    message = `FX spot (${srcName}) — delayed${delayNote}`;
  } else {
    message = `Delayed data (${source || "Yahoo"})${delayNote}`;
  }
  if (identity === "futures") message = `Futures fallback · ${message}`;
  return { bars, status: "polling", message, delaySec };
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


// ---------------------------------------------------------------------------
// Watchlist snapshot — one refresh cycle for every catalog instrument.
// crypto: Binance 24h ticker (one call) · the rest: /api/quotes daily bars
// (last close + previous close → real day change). No synthetic prices.
// ---------------------------------------------------------------------------

export interface WatchlistQuote { price: number; changePct: number }

export async function fetchWatchlistQuotes(): Promise<Record<string, WatchlistQuote>> {
  const out: Record<string, WatchlistQuote> = {};
  const crypto = INSTRUMENTS.filter((i) => i.feed === "binance" && i.binance);
  const quoted = INSTRUMENTS.filter((i) => i.feed !== "binance" && i.yahoo);

  const tasks: Promise<void>[] = [
    binanceProvider
      .ticker24h(crypto.map((i) => i.binance!))
      .then((snap) => {
        for (const i of crypto) {
          const s = snap[i.binance!];
          if (s) out[i.symbol] = s;
        }
      })
      .catch(() => { /* transient — next refresh retries */ }),
  ];

  for (const i of quoted) {
    tasks.push(
      authedFetch<any>(`/api/quotes?symbol=${encodeURIComponent(i.yahoo!)}&range=5d&interval=1d`)
        .then((res) => {
          const bars: Bar[] = res?.bars || [];
          if (bars.length < 1) return;
          const last = bars[bars.length - 1];
          const prev = bars.length > 1 ? bars[bars.length - 2] : null;
          if (!(last.close > 0)) return;
          const changePct = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
          out[i.symbol] = { price: last.close, changePct };
        })
        .catch(() => { /* transient — next refresh retries */ }),
    );
  }
  await Promise.all(tasks);
  return out;
}

/**
 * Phase 21 — the enriched quotes snapshot the explorer/watchlist/info panel
 * consume: price, day change (abs + %), daily OHLC, prev close and the
 * quote time for EVERY catalog instrument, all from real provider data.
 * crypto: the Binance 24h ticker's own numbers · the rest: /api/quotes
 * daily bars (last OHLC + previous close → real day change). Live prices
 * already streaming in the price-store override the (older) daily close.
 */
export interface QuoteRow {
  symbol: string;
  price: number | null;
  changeAbs: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  at: number;
  source: "binance" | "yahoo";
}

export async function fetchQuotesSnapshot(): Promise<Record<string, QuoteRow>> {
  const out: Record<string, QuoteRow> = {};
  const crypto = INSTRUMENTS.filter((i) => i.feed === "binance" && i.binance);
  const quoted = INSTRUMENTS.filter((i) => i.feed !== "binance" && i.yahoo);
  const now = Date.now();

  const tasks: Promise<void>[] = [
    binanceProvider
      .ticker24h(crypto.map((i) => i.binance!))
      .then((snap) => {
        for (const i of crypto) {
          const s = snap[i.binance!];
          if (!s) continue;
          const prevClose = s.open && s.open > 0 ? s.open : null;
          out[i.symbol] = {
            symbol: i.symbol,
            price: s.price,
            changeAbs: prevClose ? s.price - prevClose : (s.changePct ? (s.price * s.changePct) / (100 + s.changePct) : null),
            changePct: s.changePct || null,
            open: s.open,
            high: s.high,
            low: s.low,
            prevClose,
            at: now,
            source: "binance",
          };
        }
      })
      .catch(() => { /* transient — next refresh retries */ }),
  ];

  for (const i of quoted) {
    tasks.push(
      authedFetch<any>(`/api/quotes?symbol=${encodeURIComponent(i.yahoo!)}&range=5d&interval=1d`)
        .then((res) => {
          const bars: Bar[] = res?.bars || [];
          if (bars.length < 1) return;
          const last = bars[bars.length - 1];
          const prev = bars.length > 1 ? bars[bars.length - 2] : null;
          if (!(last.close > 0)) return;
          out[i.symbol] = {
            symbol: i.symbol,
            price: last.close,
            changeAbs: prev && prev.close > 0 ? last.close - prev.close : null,
            changePct: prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null,
            open: Number(last.open) || null,
            high: Number(last.high) || null,
            low: Number(last.low) || null,
            prevClose: prev && prev.close > 0 ? prev.close : null,
            at: Number(res?.at) || now,
            source: "yahoo",
          };
        })
        .catch(() => { /* transient — next refresh retries */ }),
    );
  }
  await Promise.all(tasks);
  // live tick wins over the daily close (fresh > stale, never fabricated)
  const live = getAllPrices();
  for (const sym of Object.keys(out)) {
    const lp = live[sym];
    const row = out[sym];
    if (lp && lp > 0 && row.price && Math.abs(lp - row.price) / row.price < 0.5) {
      row.price = lp;
      row.at = now;
    }
  }
  return out;
}
