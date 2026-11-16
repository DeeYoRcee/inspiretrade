/**
 * GET /api/quotes?symbol=EURUSD=X&range=5d&interval=1m
 *
 * Server-side proxy for real (sometimes delayed) market data. Primary source:
 * the public Yahoo Finance chart API — Yahoo blocks browser CORS, so the
 * client cannot call it directly, and provider credentials (TwelveData /
 * AlphaVantage) are not configured in this deployment.
 *
 * Fallback source: stooq.com CSV (free, no key, generous to datacenter IPs).
 * Yahoo regularly rate-limits Vercel serverless IPs (HTTP 429/999), which made
 * every non-crypto instrument fail. When Yahoo errors, we transparently fall
 * back to stooq — same bars shape, marked source:"stooq", delayed:true.
 * Responses are cached at the edge (s-maxage) to keep upstream request volume
 * low and stay inside Vercel Hobby function limits.
 */
import { handle, requireUser } from "./lib/firebase";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** yahoo symbol → stooq symbol (verified against stooq's CSV endpoints). */
const STOOQ_MAP = {
    "GC=F": "xauusd",
    "SI=F": "xagusd",
    "EURUSD=X": "eurusd",
    "GBPUSD=X": "gbpusd",
    "USDJPY=X": "usdjpy",
    "AUDUSD=X": "audusd",
    "NZDUSD=X": "nzdusd",
    "USDCAD=X": "usdcad",
    "USDCHF=X": "usdchf",
    "^NDX": "^ndq",
    "^DJI": "^dji",
    "^GSPC": "^spx",
    "^GDAXI": "^dax",
    "^FTSE": "^ukx",
};
const stooqOf = (sym) => STOOQ_MAP[sym] ?? (sym.endsWith("=X") ? sym.slice(0, -2).toLowerCase() : null);
function csvToQuotes(csv) {
    const out = {};
    const lines = csv.trim().split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < 7)
            continue;
        const close = Number(cols[6]);
        const open = Number(cols[3]);
        out[cols[0].toLowerCase()] = {
            price: Number.isFinite(close) && close > 0 ? close : null,
            previousClose: Number.isFinite(open) && open > 0 ? open : null,
        };
    }
    return out;
}
/** stooq intraday/daily CSV → bars. Intraday timestamps are German local
 * wall time (CET in winter, CEST in summer) — the offset is resolved per bar
 * date via the Intl timezone DB, never hardcoded (a fixed +1h shifted every
 * candle by one hour across the whole summer half of the year). */
function stooqCsvToBars(csv) {
    const bars = [];
    const lines = csv.trim().split(/\r?\n/);
    // Europe/Berlin UTC offset (ms) at 12:00 UTC of the given date (CET/CEST aware)
    const tzOffsetMs = (dateStr) => {
        try {
            const noonUTC = Date.parse(`${dateStr}T12:00:00Z`);
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: "Europe/Berlin", hour12: false,
                year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
            }).formatToParts(new Date(noonUTC));
            const get = (k) => Number(parts.find((p) => p.type === k)?.value ?? 0);
            const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
            return asUTC - noonUTC;
        }
        catch {
            return 3600000; // fall back to CET
        }
    };
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < 5)
            continue;
        const [d, t, o, h, l, c, v] = cols;
        const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
        if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0))
            continue;
        let time;
        if (t && /^\d{2}:\d{2}$/.test(t)) {
            time = Math.floor((Date.parse(`${d}T${t}:00Z`) - tzOffsetMs(d)) / 1000);
        }
        else {
            time = Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
        }
        bars.push({ time, open, high, low, close, volume: Number(v) || 0 });
    }
    return bars;
}
const STOOQ_INTERVAL = { "1m": "5", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "d" };
const barsCache = new Map();
const batchCache = new Map();
const inflight = new Map();
const BARS_FRESH_MS = 12000; // client polls every 10s → every 2nd poll served from cache
const BARS_STALE_MS = 60000; // beyond this revalidate in place; stale still beats an error
const BATCH_FRESH_MS = 30000;
const BATCH_STALE_MS = 120000;
function pruneCache(cache, staleMs) {
    if (cache.size < 64)
        return;
    const cutoff = Date.now() - staleMs * 2;
    for (const [k, v] of cache)
        if (v.at < cutoff)
            cache.delete(k);
}
/** Coalesced upstream fetch: one request per key regardless of caller count. */
async function doFetch(cache, key, fetcher) {
    let p = inflight.get(key);
    if (!p) {
        p = (async () => {
            const payload = await fetcher();
            cache.set(key, { at: Date.now(), payload });
            return payload;
        })().finally(() => { inflight.delete(key); });
        inflight.set(key, p);
    }
    return p;
}
/**
 * fresh → serve as-is; stale → serve immediately + background revalidate;
 * miss → fetch (falling back to the last known payload instead of an error
 * when both upstream sources die).
 */
async function cachedPayload(cache, key, freshMs, staleMs, fetcher) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < freshMs)
        return hit.payload;
    if (hit && Date.now() - hit.at < staleMs) {
        if (!inflight.has(key))
            void doFetch(cache, key, fetcher).catch(() => { });
        pruneCache(cache, staleMs);
        return hit.payload;
    }
    try {
        const payload = await doFetch(cache, key, fetcher);
        pruneCache(cache, staleMs);
        return payload;
    }
    catch (e) {
        if (hit)
            return hit.payload; // old data beats an error state
        throw e;
    }
}
// ---------------------------------------------------------------------------
// Live spot overlay for precious metals (gold / silver).
//
// Yahoo's own chart candles trail 5-15 min behind the market — that is the
// whole "gold chart always lags" complaint. gold-api.com serves a free,
// keyless spot price that (verified live) matches Yahoo's GC=F
// regularMarketPrice to the cent, refreshing within seconds. We paint that
// spot onto the current bar so the tail of the chart is live while older
// bars stay Yahoo's. Fail-open everywhere: if the spot service is down,
// stale, or the interval is unknown, we simply return plain Yahoo data.
// ---------------------------------------------------------------------------
const SPOT_API_MAP = { "GC=F": "XAU", "SI=F": "XAG" };
const SPOT_TTL_MS = 30000; // spot refresh window (gold-api updates every few seconds)
const SPOT_MAX_AGE_MS = 600000; // spot older than 10 min = closed market — never paint it
const spotCache = new Map();
async function fetchSpot(code) {
    const cached = spotCache.get(code);
    if (cached && Date.now() - cached.at < SPOT_TTL_MS)
        return cached.price;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(`https://api.gold-api.com/price/${code}`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok)
            throw new Error(String(res.status));
        const data = await res.json();
        const price = Number(data?.price);
        const updatedAt = Date.parse(data?.updatedAt || "") || 0;
        if (!Number.isFinite(price) || price <= 0)
            throw new Error("BAD_SPOT");
        if (updatedAt && Date.now() - updatedAt > SPOT_MAX_AGE_MS)
            throw new Error("STALE_SPOT"); // weekend / closed
        spotCache.set(code, { at: Date.now(), price });
        return price;
    }
    catch {
        return cached?.price ?? null; // transient error → last known spot
    }
}
const INTERVAL_SECONDS = {
    "1m": 60, "2m": 120, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "60m": 3600, "1h": 3600, "90m": 5400, "1d": 86400,
};
/** Paint the live spot onto the current bar: update the open bucket in place,
 * or open the next bucket (open = previous close — the candle body stays
 * continuous, no seam jump even if the basis moves). */
export function mergeSpotBars(bars, spot, interval) {
    const sec = INTERVAL_SECONDS[interval];
    if (!sec || bars.length === 0)
        return false;
    const now = Math.floor(Date.now() / 1000);
    const bucket = sec >= 86400 ? Math.floor(now / 86400) * 86400 : Math.floor(now / sec) * sec;
    const last = bars[bars.length - 1];
    if (last.time === bucket) {
        last.close = spot;
        if (spot > last.high)
            last.high = spot;
        if (spot < last.low)
            last.low = spot;
        return true;
    }
    if (bucket > last.time) {
        bars.push({ time: bucket, open: last.close, high: Math.max(last.close, spot), low: Math.min(last.close, spot), close: spot, volume: 0 });
        return true;
    }
    return false; // spot bucket precedes the last bar (clock skew) — leave bars untouched
}
export default handle(async (req, res) => {
    await requireUser(req);
    const url = new URL(req.url || "/", "http://localhost");
    const batch = (url.searchParams.get("symbols") || "").trim();
    const symbols = (url.searchParams.get("symbol") || "").trim();
    const range = (url.searchParams.get("range") || "5d").trim();
    const interval = (url.searchParams.get("interval") || "1m").trim();
    // ---- Batch quote mode: GET /api/quotes?symbols=EURUSD=X,GC=F ----------
    // Light last-price snapshot for the Market Watch panel.
    if (batch) {
        const list = batch.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9^.=\-]{1,20}$/i.test(s)).slice(0, 20);
        if (!list.length)
            return res.status(200).json({ ok: true, quotes: [] });
        const payload = await cachedPayload(batchCache, list.slice().sort().join(","), BATCH_FRESH_MS, BATCH_STALE_MS, async () => {
            const quotes = await Promise.all(list.map(async (sym) => {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 6000);
                    const yres = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal });
                    clearTimeout(timer);
                    if (!yres.ok)
                        throw new Error(String(yres.status));
                    const data = await yres.json();
                    const meta = data?.chart?.result?.[0]?.meta || {};
                    return { symbol: meta.symbol || sym, price: meta.regularMarketPrice ?? null, previousClose: meta.chartPreviousClose ?? null };
                }
                catch {
                    return { symbol: sym, price: null, previousClose: null };
                }
            }));
            // stooq fallback for the symbols Yahoo failed on (one CSV call for all).
            const failed = quotes.filter((q) => q.price == null);
            if (failed.length > 0) {
                const stooqSyms = failed.map((q) => stooqOf(q.symbol)).filter(Boolean);
                if (stooqSyms.length > 0) {
                    try {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), 6000);
                        const sres = await fetch(`https://stooq.com/q/l/?s=${stooqSyms.join("+")}&f=sd2t2ohlcv&h&e=csv`, {
                            headers: { "User-Agent": UA }, signal: controller.signal,
                        });
                        clearTimeout(timer);
                        if (sres.ok) {
                            const bySym = csvToQuotes(await sres.text());
                            for (const q of failed) {
                                const sq = bySym[stooqOf(q.symbol)?.toLowerCase() || ""];
                                if (sq?.price != null) {
                                    q.price = sq.price;
                                    q.previousClose = sq.previousClose;
                                }
                            }
                        }
                    }
                    catch { /* keep nulls — client shows offline state */ }
                }
            }
            // live spot overwrite for mapped metals — Yahoo's batch meta is delayed,
            // the gold-api spot is fresh (Market Watch should move in real time too)
            await Promise.all(list.map(async (sym, i) => {
                const code = SPOT_API_MAP[sym];
                if (!code)
                    return;
                const spot = await fetchSpot(code);
                if (spot != null && quotes[i])
                    quotes[i].price = spot;
            }));
            // total upstream failure must not poison the cache — throw so the caller
            // falls back to the last known payload or surfaces the offline state
            if (quotes.every((q) => q.price == null))
                throw new Error("ALL_SOURCES_FAILED");
            return { ok: true, quotes };
        });
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        return res.status(200).json(payload);
    }
    if (!/^[A-Z0-9^.=\-]{1,20}$/i.test(symbols)) {
        return res.status(400).json({ ok: false, error: "BAD_SYMBOL" });
    }
    const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    const fromYahoo = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const yres = await fetch(yurl, {
            headers: { "User-Agent": UA, Accept: "application/json" },
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!yres.ok)
            throw new Error(`yahoo ${yres.status}`);
        const data = await yres.json();
        const result = data?.chart?.result?.[0];
        if (!result)
            throw new Error("EMPTY_RESULT");
        const ts = result.timestamp || [];
        const q = result.indicators?.quote?.[0] || {};
        const bars = [];
        for (let i = 0; i < ts.length; i++) {
            const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
            if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x)))
                continue;
            bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
        }
        const meta = result.meta || {};
        // live spot overlay: Yahoo's candles trail 5-15 min behind — paint the
        // fresh gold-api spot onto the current bar (fail-open, see fetchSpot)
        const spotCode = SPOT_API_MAP[symbols];
        let live = false;
        if (spotCode) {
            const spot = await fetchSpot(spotCode);
            if (spot != null && mergeSpotBars(bars, spot, interval))
                live = true;
        }
        return {
            source: live ? "spot+yahoo" : "yahoo",
            delayed: !live,
            symbol: meta.symbol || symbols,
            currency: meta.currency || null,
            regularMarketPrice: live ? bars[bars.length - 1].close : (meta.regularMarketPrice ?? null),
            previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
            bars,
        };
    };
    const fromStooq = async () => {
        const sq = stooqOf(symbols);
        if (!sq)
            throw new Error("NO_STOOQ_MAP");
        // stooq has no true 1-minute CSV: its finest intraday feed is 5-minute.
        // Serving that as "1m" mislabeled every candle — refuse instead and let
        // the client show the honest error/retry state.
        if (interval === "1m")
            throw new Error("STOOQ_NO_1M");
        const si = STOOQ_INTERVAL[interval];
        if (!si)
            throw new Error("NO_STOOQ_INTERVAL");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const sres = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sq)}&i=${si}`, {
            headers: { "User-Agent": UA }, signal: controller.signal,
        });
        clearTimeout(timer);
        if (!sres.ok)
            throw new Error(`stooq ${sres.status}`);
        const bars = stooqCsvToBars(await sres.text());
        if (bars.length === 0)
            throw new Error("STOOQ_EMPTY");
        // Respect the requested range: keep roughly the last `range` worth of bars.
        const perDay = si === "d" ? 1 : Math.round(1440 / Number(si));
        const days = range.endsWith("d") ? Number(range.slice(0, -1)) || 5 : range.endsWith("mo") ? Number(range.slice(0, -2)) * 30 || 150 : 5;
        const capped = bars.slice(Math.max(0, bars.length - days * perDay));
        const last = capped[capped.length - 1];
        return {
            source: "stooq",
            delayed: true,
            symbol: symbols,
            currency: null,
            regularMarketPrice: last?.close ?? null,
            previousClose: capped.length > 1 ? capped[capped.length - 2].close : null,
            bars: capped,
        };
    };
    try {
        const payload = await cachedPayload(barsCache, `${symbols}|${range}|${interval}`, BARS_FRESH_MS, BARS_STALE_MS, async () => {
            try {
                return { ok: true, ...(await fromYahoo()) };
            }
            catch (e) {
                try {
                    return { ok: true, ...(await fromStooq()) };
                }
                catch (e2) {
                    throw new Error(`yahoo: ${String(e?.message || e)}; stooq: ${String(e2?.message || e2)}`);
                }
            }
        });
        res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
        return res.status(200).json(payload);
    }
    catch (err) {
        return res.status(200).json({ ok: false, error: "FEED_UNAVAILABLE", detail: String(err?.message || err) });
    }
});
