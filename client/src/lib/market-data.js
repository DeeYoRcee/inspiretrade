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
import { getInstrument, BINANCE_INTERVAL, YAHOO_INTERVAL, YAHOO_AGGREGATE, TF_SECONDS, aggregateBars, } from "@shared/terminal";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dedupSort(bars) {
    const map = new Map();
    for (const b of bars)
        map.set(b.time, b);
    return [...map.values()].sort((a, b) => a.time - b.time);
}
/**
 * Upsert one bar into the live series. Hot path: called on EVERY tick.
 * Same-time ticks update the last element IN PLACE (no copy, no sort) — the
 * old copy+sort per tick was O(n log n) of main-thread work per chart.
 */
function upsert(bars, bar) {
    const last = bars.length ? bars[bars.length - 1] : null;
    if (last && bar.time === last.time) {
        bars[bars.length - 1] = bar;
        return bars;
    }
    if (!last || bar.time > last.time) {
        bars.push(bar);
        if (bars.length > 3000)
            bars.splice(0, bars.length - 3000);
        return bars;
    }
    // rare out-of-order insert (resync path) — keep the safe copy+sort
    const out = bars.slice();
    const i = out.findIndex((b) => b.time === bar.time);
    if (i >= 0)
        out[i] = bar;
    else {
        out.push(bar);
        out.sort((a, b) => a.time - b.time);
        if (out.length > 3000)
            out.splice(0, out.length - 3000);
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
// Endpoints are tried in order and rotate on failure. The last WS entry and
// second REST host are Binance's official PUBLIC MARKET-DATA mirrors on a
// different domain (binance.vision) — ISP-level blocks of binance.com (common
// in several regions) do not take the live feed down with them.
const WS_ENDPOINTS = ["wss://stream.binance.com:9443", "wss://stream.binance.com:443", "wss://data-stream.binance.vision"];
const REST_HOSTS = ["api.binance.com", "data-api.binance.vision"];
const CONNECT_TIMEOUT_MS = 4000; // a blocked socket often hangs CONNECTING forever — force failover
class BinanceProvider {
    constructor() {
        this.ws = null;
        this.streams = new Map(); // "SYM:tf" → "sym@kline_int"
        this.streamToKey = new Map(); // incoming frame route
        this.meta = new Map();
        this.restHostIdx = 0;
        this.wsEpIdx = 0;
        this.wsWorks = false; // current endpoint delivered at least one frame
        this.backoff = 1000;
        this.lastMsgAt = 0;
        this.connectTimer = null;
        this.watchdog = null;
        this.polls = new Map();
        this.listeners = new Map();
        this.history = new Map();
        this.loadedAt = new Map();
    }
    async load(symbol, tf) {
        const key = `${symbol}:${tf}`;
        // short-lived fresh cache — instant timeframe switching / remounts
        const fresh = this.history.get(key);
        if (fresh && Date.now() - (this.loadedAt.get(key) ?? 0) < 15000)
            return fresh;
        const bars = await this.fetchRecent(symbol, tf, 1000);
        this.history.set(key, bars);
        this.loadedAt.set(key, Date.now());
        return bars;
    }
    /** REST klines fetch — used for history AND for gap-fill / safety polling. */
    async fetchRecent(symbol, tf, limit) {
        const inst = getInstrument(symbol);
        const raw = await this.restGet(`/api/v3/klines?symbol=${inst.binance}&interval=${BINANCE_INTERVAL[tf]}&limit=${limit}`);
        return raw.map((k) => ({
            time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
            takerBuy: k[9] != null ? +k[9] : undefined,
        }));
    }
    /** REST with mirror failover: api.binance.com blocked → data-api.binance.vision. */
    async restGet(path) {
        let lastErr;
        for (let attempt = 0; attempt < REST_HOSTS.length; attempt++) {
            const idx = (this.restHostIdx + attempt) % REST_HOSTS.length;
            try {
                const res = await fetch(`https://${REST_HOSTS[idx]}${path}`);
                if (!res.ok)
                    throw new Error(`binance ${res.status}`);
                const json = await res.json();
                this.restHostIdx = idx; // remember the working host
                return json;
            }
            catch (e) {
                lastErr = e;
            }
        }
        throw lastErr ?? new Error("binance REST unreachable");
    }
    /** Fetch the last 2 klines and upsert them into the series (gap-fill). */
    async resync(key, isRealtime = true) {
        const m = this.meta.get(key);
        if (!m || !this.listeners.get(key)?.size)
            return;
        const recent = await this.fetchRecent(m.symbol, m.tf, 2);
        if (!recent.length)
            return;
        let bars = this.history.get(key) || [];
        let changed = false;
        for (const b of recent) {
            const prev = bars.find((x) => x.time === b.time);
            if (!prev || prev.close !== b.close || prev.high !== b.high || prev.low !== b.low || prev.volume !== b.volume)
                changed = true;
            bars = upsert(bars, b);
        }
        if (!changed)
            return;
        this.history.set(key, bars);
        this.loadedAt.set(key, Date.now());
        const lastBar = bars[bars.length - 1];
        this.listeners.get(key)?.forEach((c) => c({ bars, lastBar, isRealtime }));
    }
    subscribe(symbol, tf, cb) {
        const inst = getInstrument(symbol);
        const key = `${symbol}:${tf}`;
        const stream = `${inst.binance.toLowerCase()}@kline_${BINANCE_INTERVAL[tf]}`;
        if (!this.listeners.has(key))
            this.listeners.set(key, new Set());
        this.listeners.get(key).add(cb);
        const isNew = !this.streams.has(key);
        this.streams.set(key, stream);
        this.streamToKey.set(stream, key);
        this.meta.set(key, { symbol, tf });
        // ONE socket serves every open chart via a combined stream — a second
        // chart must never steal the first one's live feed (multi-chart layouts)
        if (!this.ws)
            this.openSocket();
        else if (isNew && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [stream], id: Date.now() % 1e9 }));
            }
            catch { /* resync covers it */ }
        }
        this.startWatchdog();
        // REST safety poll (2s): the chart must NEVER freeze. While the WS is
        // healthy (a message within the last 5s) the guard makes it free; the
        // moment the WS goes stale (blocked network, dead NAT, region issue) this
        // poll upserts the last 2 klines and keeps the candle moving.
        if (!this.polls.has(key)) {
            this.polls.set(key, setInterval(() => {
                if (this.history.get(key)?.length && Date.now() - this.lastMsgAt < 5000)
                    return;
                void this.resync(key, false).catch(() => { });
            }, 2000));
        }
        return () => {
            const set = this.listeners.get(key);
            set?.delete(cb);
            if (set && set.size === 0) {
                const p = this.polls.get(key);
                if (p) {
                    clearInterval(p);
                    this.polls.delete(key);
                }
                const stream = this.streams.get(key);
                this.streams.delete(key);
                if (stream)
                    this.streamToKey.delete(stream);
                this.meta.delete(key);
                if (this.ws && this.ws.readyState === WebSocket.OPEN && stream) {
                    try {
                        this.ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: [stream], id: Date.now() % 1e9 }));
                    }
                    catch { /* socket dying anyway */ }
                }
                if (this.streams.size === 0 && this.ws) {
                    const ws = this.ws;
                    this.ws = null;
                    if (this.connectTimer) {
                        clearTimeout(this.connectTimer);
                        this.connectTimer = null;
                    }
                    if (this.watchdog) {
                        clearInterval(this.watchdog);
                        this.watchdog = null;
                    }
                    try {
                        ws.close();
                    }
                    catch { /* already dead */ }
                }
            }
        };
    }
    /** Kills a silently-dead socket: kline streams push every ~1-2s when live. */
    startWatchdog() {
        if (this.watchdog)
            return;
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
    openSocket() {
        const list = [...this.streams.values()];
        if (!list.length || this.ws)
            return;
        const host = WS_ENDPOINTS[this.wsEpIdx];
        const ws = new WebSocket(`${host}/stream?streams=${list.join("/")}`);
        this.ws = ws;
        this.lastMsgAt = Date.now();
        // a blocked socket often hangs CONNECTING forever — force failover
        this.connectTimer = setTimeout(() => { try {
            ws.close();
        }
        catch { /* already dead */ } }, CONNECT_TIMEOUT_MS);
        ws.onopen = () => {
            if (this.connectTimer) {
                clearTimeout(this.connectTimer);
                this.connectTimer = null;
            }
            this.backoff = 1000;
            // explicit SUBSCRIBE covers streams added while the socket was opening
            try {
                ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [...this.streams.values()], id: Date.now() % 1e9 }));
            }
            catch { /* the combined URL already carries them */ }
            for (const key of this.streams.keys())
                void this.resync(key).catch(() => { });
        };
        ws.onmessage = (ev) => {
            this.lastMsgAt = Date.now();
            this.wsWorks = true;
            try {
                const payload = JSON.parse(ev.data);
                const k = payload?.data?.k ?? payload?.k;
                if (!k)
                    return;
                const key = payload?.stream
                    ? this.streamToKey.get(payload.stream)
                    : (this.streamToKey.size === 1 ? [...this.streamToKey.values()][0] : undefined);
                if (!key)
                    return;
                const bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, takerBuy: k.V != null ? +k.V : undefined };
                const bars = upsert(this.history.get(key) || [], bar);
                this.history.set(key, bars);
                this.loadedAt.set(key, Date.now());
                this.listeners.get(key)?.forEach((cb) => cb({ bars, lastBar: bar, isRealtime: true }));
            }
            catch { /* malformed frame — skip */ }
        };
        ws.onclose = () => {
            if (this.connectTimer) {
                clearTimeout(this.connectTimer);
                this.connectTimer = null;
            }
            this.ws = null;
            if (this.streams.size === 0)
                return; // last chart unmounted — normal shutdown
            // an endpoint that never delivered a frame is effectively blocked → rotate
            if (!this.wsWorks)
                this.wsEpIdx = (this.wsEpIdx + 1) % WS_ENDPOINTS.length;
            this.wsWorks = false;
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, 15000);
            setTimeout(() => { if (this.streams.size && !this.ws)
                this.openSocket(); }, delay);
        };
        ws.onerror = () => { try {
            ws.close();
        }
        catch { /* nothing */ } };
    }
}
// ---------------------------------------------------------------------------
// Quotes proxy (forex / metals / indices — real but delayed)
// ---------------------------------------------------------------------------
class QuotesProvider {
    constructor() {
        this.timers = new Map();
        this.listeners = new Map();
        this.history = new Map();
        this.loadedAt = new Map();
        this.inflight = new Set();
        this.source = new Map(); // "yahoo" | "stooq" — surfaced in the feed message
    }
    // network fetch + aggregation, always bypasses the fresh cache (poll path)
    async loadNetwork(symbol, tf) {
        const inst = getInstrument(symbol);
        const key = `${symbol}:${tf}`;
        const cfg = YAHOO_INTERVAL[tf];
        const agg = YAHOO_AGGREGATE[tf];
        // prefer the target tf's own config when its interval equals the base
        // interval (4h: "1y/60m" gives ~4x deeper history than the 1h base's 3mo)
        const useCfg = agg
            ? (cfg.interval === YAHOO_INTERVAL[agg].interval ? cfg : YAHOO_INTERVAL[agg])
            : cfg;
        const res = await authedFetch(`/api/quotes?symbol=${encodeURIComponent(inst.yahoo)}&range=${useCfg.range}&interval=${useCfg.interval}`);
        if (!res?.ok)
            throw new Error(res?.detail || "FEED_UNAVAILABLE");
        if (res.source)
            this.source.set(key, res.source);
        let bars = res.bars;
        // bucket length = the TARGET timeframe in minutes (3m→3, 2h→120, 4h→240).
        // The old TF_SECONDS[tf]/TF_SECONDS[agg] ratio only happens to be minutes
        // for the 1m base: from the 1h base it passed 2/4 "minutes" → 2- and
        // 4-MINUTE buckets → the 2h and 4h charts actually rendered 1h candles.
        if (agg)
            bars = aggregateBars(bars, TF_SECONDS[tf] / 60);
        bars = dedupSort(bars);
        this.history.set(key, bars);
        this.loadedAt.set(key, Date.now());
        return bars;
    }
    async load(symbol, tf) {
        const key = `${symbol}:${tf}`;
        // short-lived fresh cache: instant timeframe switching + remounts
        const fresh = this.history.get(key);
        if (fresh && Date.now() - (this.loadedAt.get(key) ?? 0) < 15000) {
            return { bars: fresh, source: this.source.get(key) };
        }
        const bars = await this.loadNetwork(symbol, tf);
        return { bars, source: this.source.get(key) };
    }
    subscribe(symbol, tf, cb) {
        const key = `${symbol}:${tf}`;
        if (!this.listeners.has(key))
            this.listeners.set(key, new Set());
        this.listeners.get(key).add(cb);
        const tick = async () => {
            // in-flight guard: a slow response must never stack requests or let an
            // older answer overwrite a newer one (chart jumping backwards)
            if (this.inflight.has(key))
                return;
            this.inflight.add(key);
            try {
                await this.loadNetwork(symbol, tf);
                const bars = this.history.get(key);
                if (bars.length)
                    this.listeners.get(key)?.forEach((c) => cb({ bars, lastBar: bars[bars.length - 1], isRealtime: false }));
            }
            catch { /* transient — next poll retries */ }
            finally {
                this.inflight.delete(key);
            }
        };
        // first tick right away — but skip it when the history was just fetched
        // (fresh cache), so mounting the chart never duplicates the load request
        if (Date.now() - (this.loadedAt.get(key) ?? 0) > 10000)
            void tick();
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
/**
 * Load history for an instrument+tf from REAL providers only.
 * Throws a descriptive error on failure — the chart shows an error state with
 * a retry button. No generated/random prices, ever.
 */
export async function loadFeed(symbol, tf) {
    const inst = getInstrument(symbol);
    if (!inst)
        throw new Error(`Unknown instrument: ${symbol}`);
    if (inst.feed === "binance") {
        const bars = await binanceProvider.load(symbol, tf);
        return { bars, status: "live" };
    }
    const { bars, source } = await quotesProvider.load(symbol, tf);
    // "spot+yahoo" = live gold-api spot painted onto the current bar, older
    // bars are Yahoo's (5-15 min delayed) — honest labelling for both cases
    const message = source?.startsWith("spot")
        ? "Live spot (gold-api) · older bars delayed"
        : `Delayed data (${source || "Yahoo"})`;
    return { bars, status: "polling", message };
}
/** Subscribe to live updates. Returns an unsubscribe function. */
export function subscribeFeed(symbol, tf, cb) {
    const inst = getInstrument(symbol);
    if (!inst)
        return () => { };
    if (inst.feed === "binance") {
        try {
            return binanceProvider.subscribe(symbol, tf, cb);
        }
        catch {
            return () => { };
        }
    }
    try {
        return quotesProvider.subscribe(symbol, tf, cb);
    }
    catch {
        return () => { };
    }
}
