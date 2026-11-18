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
import {
  getInstrument, INSTRUMENTS, BINANCE_INTERVAL, YAHOO_INTERVAL, YAHOO_AGGREGATE, TF_SECONDS, type InstrumentSpec,
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

import { validateBars, dedupeBars, checkBar, type RawBar } from "@shared/feed-validation";
import { upsertBar, wsBackoffDelay, nextEndpointIndex } from "@shared/candle-core";

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
    const bars = await this.fetchRecent(symbol, tf, 1000);
    this.history.set(key, bars);
    this.loadedAt.set(key, Date.now());
    return bars;
  }

  /**
   * One-shot 24h ticker snapshot for the watchlist: { lastPrice, priceChangePercent }
   * per Binance symbol — a single REST round-trip for every crypto row.
   */
  async ticker24h(binanceSymbols: string[]): Promise<Record<string, { price: number; changePct: number }>> {
    if (!binanceSymbols.length) return {};
    const q = encodeURIComponent(JSON.stringify(binanceSymbols));
    const raw: any[] = await this.restGet(`/api/v3/ticker/24hr?symbols=${q}`);
    const out: Record<string, { price: number; changePct: number }> = {};
    for (const t of raw) {
      const price = Number(t.lastPrice);
      const changePct = Number(t.priceChangePercent);
      if (Number.isFinite(price) && price > 0) out[String(t.symbol)] = { price, changePct: Number.isFinite(changePct) ? changePct : 0 };
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
    return raw.filter((b) => b.time < beforeTime);
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

  /** Fetch the last 2 klines and upsert them into the series (gap-fill). */
  private async resync(key: string, isRealtime = true) {
    const m = this.meta.get(key);
    if (!m || !this.listeners.get(key)?.size) return;
    const recent = await this.fetchRecent(m.symbol, m.tf, 2);
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
        const bars = upsert(this.history.get(key) || [], bar);
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

class QuotesProvider {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Map<string, Set<UpdateCb>>();
  private history = new Map<string, Bar[]>();
  private loadedAt = new Map<string, number>();
  private inflight = new Set<string>();
  private source = new Map<string, string>(); // "yahoo" | "stooq" — surfaced in the feed message
  private identity = new Map<string, string>(); // "spot" | "futures" — what the response actually represented

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
    if (res.source) this.source.set(key, res.source);
    if (res.identity) this.identity.set(key, res.identity);
    if (res.delaySec != null) statsState.delaySec = res.delaySec;
    // client-side defense-in-depth: the server already validates, but the
    // chart must never trust the wire — repair/drop before aggregation
    const checked = validateBars(res.bars as RawBar[]);
    const deduped = dedupeBars(checked.bars);
    statsState.invalidBars += checked.invalid;
    statsState.repairedBars += checked.repaired;
    statsState.duplicateBars += deduped.dropped;
    let bars: Bar[] = deduped.bars as Bar[];
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
      // REST polling — 10s; Yahoo data is delayed anyway, this keeps the last
      // candle moving without hammering the proxy.
      const timer = setInterval(tick, 10000);
      this.timers.set(key, timer);
    }

    // ---- real-time spot tail + recorder (metals) ----------------------------
    // gold-api.com serves the genuine spot price with CORS * and a fresh
    // updatedAt stamp — poll it DIRECTLY from the browser every second, paint
    // the live bucket, and RECORD the price into the self-built candle set.
    let spotTimer: ReturnType<typeof setInterval> | null = null;
    let spotResync: ReturnType<typeof setInterval> | null = null;
    let spotInflight = false;
    if (spotCode) {
      ensureSpotFlusher();
      setSpotState({ state: "connecting", lastTickAt: 0, providerDelaySec: null });
      const spotTick = async () => {
        if (spotInflight) return;
        spotInflight = true;
        try {
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), 3500);
          const res = await fetch(`https://api.gold-api.com/price/${spotCode}`, { signal: controller.signal });
          clearTimeout(abortTimer);
          if (!res.ok) throw new Error(`gold-api ${res.status}`);
          const data: any = await res.json();
          const price = Number(data?.price);
          // the provider stamps its own price — that stamp is the honest
          // latency number the badge reports (not our poll round-trip)
          const providerAt = Date.parse(data?.updatedAt || "") || 0;
          if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
          const providerDelaySec = providerAt ? Math.max(0, Math.round((Date.now() - providerAt) / 1000)) : null;
          if (providerDelaySec != null && providerDelaySec > 600) throw new Error("STALE_SPOT"); // market closed
          // record the observed price into the self-built candle set (every
          // timeframe benefits — the recorder is timeframe-independent)
          recordSpot(spotCode, price);
          const bars = this.history.get(key);
          if (!bars?.length) {
            // the very first recorded minute just opened — pull it into the
            // chart immediately instead of waiting for the 3 min resync
            await this.loadRecordedSpot(symbol, tf);
            const fresh = this.history.get(key);
            if (fresh?.length) {
              this.listeners.get(key)?.forEach((c) => cb({ bars: fresh, lastBar: fresh[fresh.length - 1], isRealtime: false }));
            }
            return;
          }
          if (tf !== "1d") {
            const sec = TF_SECONDS[tf];
            // bridging fill-forward is capped at 5 buckets for recorded data:
            // beyond that the missing minutes stay an honest gap on the axis
            const merged = mergeSpotTail(bars, price, sec, 5);
            if (merged) {
              this.history.set(key, merged);
              statsState.delaySec = providerDelaySec;
              markTick();
              this.listeners.get(key)?.forEach((c) => cb({ bars: merged, lastBar: merged[merged.length - 1], isRealtime: true }));
            }
          }
          spotFails = 0;
          setSpotState({ state: "live", lastTickAt: Date.now(), providerDelaySec });
        } catch {
          spotFails += 1;
          if (spotFails >= 5) setSpotState({ state: "disconnected", lastTickAt: getSpotState().lastTickAt, providerDelaySec: null });
        } finally {
          spotInflight = false;
        }
      };
      let spotFails = 0;
      void spotTick();
      spotTimer = setInterval(spotTick, 1000);
      this.timers.set(`${key}:spot`, spotTimer);

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
      this.timers.set(`${key}:rec`, spotResync);
    }
    return () => {
      const timer = this.timers.get(key);
      if (timer) clearInterval(timer);
      this.timers.delete(key);
      if (spotTimer) { clearInterval(spotTimer); this.timers.delete(`${key}:spot`); }
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
    const now = Math.floor(Date.now() / 1000);
    // server merge first (authoritative across devices), fall back to local
    let candles: SpotCandle[] = [];
    try {
      const res = await authedFetch<any>(`/api/quotes?action=spot-history&code=${code}`);
      if (res?.ok && Array.isArray(res.candles)) {
        candles = res.candles.filter((c: any) => validSpotCandle(c, now));
      }
    } catch { /* server unavailable → local records only */ }
    candles = mergeSpotSeries(candles, loadLocalSpot(code));
    // include the in-progress minute + unflushed completions
    const st = spotRec.get(code);
    if (st) candles = mergeSpotSeries(candles, [...st.unflushed, ...(st.minute ? [st.minute] : [])].filter((c) => validSpotCandle(c, now)));
    saveLocalSpot(code, candles);
    const m1: Bar[] = candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.s }));
    const key = `${symbol}:${tf}`;
    const sec = TF_SECONDS[tf];
    const bars = dedupSort(tf === "1m" ? m1.slice() : aggregateBars(m1, sec / 60));
    this.source.set(key, tf === "1m" ? "spot-recorded(1m)" : `spot-recorded→${tf}`);
    this.identity.set(key, "spot");
    this.history.set(key, bars);
    this.loadedAt.set(key, Date.now());
    return bars;
  }
}

// ---------------------------------------------------------------------------
// Live spot tail — see client/src/lib/spot-tail.ts (pure, unit-tested module).
// ---------------------------------------------------------------------------
import { mergeSpotTail, recordSpotTick, mergeSpotSeries, validSpotCandle, type SpotCandle } from "@/lib/spot-tail";
export { mergeSpotTail };

// ---- Phase 16: self-recorded spot candles (XAU / XAG) ----------------------
// Every 1s gold-api observation is folded into a real minute candle. Finished
// minutes persist to localStorage immediately and batch-merge to the server
// every ~20s so ALL devices converge on the same recorded candle set. There
// is deliberately NO seeding: candles exist only where ticks were actually
// observed — gaps stay gaps.
const SPOT_REC_KEY = (code: string) => `it_spot_rec_${code}`;
const SPOT_REC_MAX = 4320; // 3 days of minutes per code (quota-safe)
const spotRec = new Map<string, { minute: SpotCandle | null; unflushed: SpotCandle[] }>();

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

/** Fold one observed spot price into the recorder (minute bucketing). */
function recordSpot(code: string, price: number) {
  if (!(price > 0)) return;
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
  /** epoch ms of the last real data delivery (any provider) */
  lastTickAt: number;
  /** epoch ms of the last chart-applied update */
  lastChartUpdateAt: number;
  /** data ticks delivered in the last 10 seconds */
  tps10s: number;
  /** measured provider delay in seconds when the provider reports it */
  delaySec: number | null;
}

const statsState: FeedStats = {
  invalidBars: 0, repairedBars: 0, duplicateBars: 0, outOfOrderTicks: 0,
  lastTickAt: 0, lastChartUpdateAt: 0, tps10s: 0, delaySec: null,
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

export function setMeasuredDelay(sec: number | null) {
  statsState.delaySec = sec;
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
    const delaySec = getSpotState().providerDelaySec;
    const message = m1 > 0
      ? `${symbol} Spot · self-recorded candles (gold-api 1s) · m1 history: ${m1} min`
      : `${symbol} Spot · recording started — m1 candles build in real time (no history yet)`;
    return { bars, status: "polling", message, delaySec };
  }
  const { bars, source, identity } = await quotesProvider.load(symbol, tf);
  assertPriceIdentity(inst, bars);
  // honest labelling — FX/indices keep their real (delayed) providers and the
  // badge names the ACTUAL underlier of every bar
  const delaySec = statsState.delaySec;
  const delayNote = delaySec != null && delaySec >= 60 ? ` · ~${Math.max(1, Math.round(delaySec / 60))} min` : delaySec != null && delaySec > 5 ? ` · ~${delaySec}s` : "";
  let message: string;
  if (source?.startsWith("spot+stooq") || source === "stooq") {
    message = `Gold spot · live gold-api tail + stooq spot history${delayNote}`;
  } else if (source?.startsWith("spot+yahoo")) {
    message = `Live spot (gold-api) tail · older bars delayed${delayNote}`;
  } else if (inst.assetClass === "forex") {
    message = `FX spot (Yahoo) — delayed${delayNote}`;
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
