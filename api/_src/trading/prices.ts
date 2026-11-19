/**
 * Server-side price service — the single execution price authority.
 *
 * Sources (all free, no key, REAL data — the engine never invents prices):
 *  - crypto      : Binance public REST ticker (live), mirror host failover
 *  - gold/silver : gold-api.com spot (live, seconds-fresh) — the SAME source
 *                  the chart's live tail paints, so XAUUSD/XAGUSD execution
 *                  prices and chart prices cannot drift (Phase 18: Yahoo's
 *                  GC=F COMEX futures are no longer an execution source for
 *                  spot metals — if the spot provider is down there is NO
 *                  quote and orders fail loudly with 503, never silently
 *                  against delayed futures prices)
 *  - fx majors   : TrueFX genuine bid/ask (live) → mid = (bid+ask)/2, the
 *                  real interbank spread is preserved (× platform multiplier)
 *  - fx crosses,
 *    indices     : Yahoo Finance chart meta (delayed by source, cached 45s,
 *                  live:false — the honest badge reports it)
 *
 * Short in-memory TTLs per lambda instance keep repeated evaluator calls cheap
 * without ever executing against stale crypto/gold prices.
 */
import { getInstrument, INSTRUMENTS } from "../../../shared/terminal";
import { quoteFromMid, quoteFromTwoSided, type Quote } from "../../../shared/trading-engine";
import { getPlatformSettings } from "../lib/platform";
import { truefxQuotes } from "../lib/truefx";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BINANCE_HOSTS = ["api.binance.com", "data-api.binance.vision"];
const CRYPTO_TTL = 3000;
const SPOT_TTL = 5000;
const YAHOO_TTL = 45000;

type MidInfo = { mid: number; source: string; live: boolean; time: number; bid?: number; ask?: number };
const cache = new Map<string, MidInfo>();

async function fetchJson(url: string, timeoutMs = 6000, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCryptoMids(binanceSyms: string[]): Promise<Record<string, number>> {
  let lastErr: unknown;
  for (let i = 0; i < BINANCE_HOSTS.length; i++) {
    try {
      const host = BINANCE_HOSTS[i];
      const q = encodeURIComponent(JSON.stringify(binanceSyms));
      const arr: any[] = await fetchJson(`https://${host}/api/v3/ticker/price?symbols=${q}`);
      const out: Record<string, number> = {};
      for (const row of arr) if (Number.isFinite(+row.price)) out[row.symbol] = +row.price;
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("binance unreachable");
}

// XAUUSD AND XAGUSD price from gold-api spot (the catalog feed stays
// "quotes" — this map routes the execution mid to the same spot source the
// chart paints). Tokenized gold (PAXG/XAUT) and COMEX futures (GC=F) are
// deliberately NOT used: different instruments, different prices/delays —
// they must never silently stand in for physical spot gold.
const GOLD_CODES: Record<string, string> = { XAUUSD: "XAU", XAGUSD: "XAG" };

async function fetchSpot(code: string): Promise<number> {
  const res: any = await fetchJson(`https://api.gold-api.com/price/${code}`);
  const price = Number(res?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
  return price;
}

async function fetchYahooMid(yahooSym: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`;
  const json: any = await fetchJson(url, 8000, { "User-Agent": UA });
  const meta = json?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_YAHOO");
  return price;
}

/** Fresh mids for every requested instrument (throws only if ALL sources fail for one class). */
export async function getMids(symbols: string[]): Promise<Record<string, MidInfo>> {
  const out: Record<string, MidInfo> = {};
  const now = Date.now();
  const want: string[] = [];
  for (const s of symbols) {
    const cached = cache.get(s);
    if (cached && now - cached.time < (cached.live ? Math.min(CRYPTO_TTL, SPOT_TTL) : YAHOO_TTL)) out[s] = cached;
    else want.push(s);
  }
  if (want.length) {
    const crypto = want.filter((s) => getInstrument(s)?.feed === "binance");
    const spot = want.filter((s) => GOLD_CODES[s]);
    const yahoo = want.filter((s) => {
      const inst = getInstrument(s);
      return inst && inst.feed !== "binance" && !GOLD_CODES[s];
    });
    await Promise.all([
      (async () => {
        if (!crypto.length) return;
        const binanceSyms = crypto.map((s) => getInstrument(s)!.binance!);
        const byBinance = await fetchCryptoMids(binanceSyms);
        for (const s of crypto) {
          const p = byBinance[getInstrument(s)!.binance!];
          if (Number.isFinite(p)) { out[s] = { mid: p, source: "binance", live: true, time: Date.now() }; cache.set(s, out[s]); }
        }
      })(),
      (async () => {
        for (const s of spot) {
          try {
            const p = await fetchSpot(GOLD_CODES[s]);
            out[s] = { mid: p, source: "gold-api", live: true, time: Date.now() };
            cache.set(s, out[s]);
          } catch { /* spot down → NO quote: orders fail loudly (503) rather than executing against a different instrument */ }
        }
      })(),
      (async () => {
        // Phase 18: forex majors first from TrueFX's GENUINE bid/ask (one
        // anonymous request prices all covered pairs in real time). Only a
        // fresh tick (≤90s) counts as live — a weekend-stale stamp must fall
        // through to Yahoo's delayed meta, never pose as real-time. Symbols
        // TrueFX does not carry (NZDUSD, crosses outside its 10 majors) and
        // indices go straight to the Yahoo meta path as before.
        const fxSyms = yahoo.filter((s) => getInstrument(s)?.assetClass === "forex");
        const rest = yahoo.filter((s) => !fxSyms.includes(s));
        let tfx: Awaited<ReturnType<typeof truefxQuotes>> = {};
        if (fxSyms.length) {
          try { tfx = await truefxQuotes(); } catch { /* empty → all fall back to Yahoo */ }
        }
        for (const s of fxSyms) {
          const bare = s.replace(/=X$/i, "");
          const t = tfx[bare];
          // only a fresh tick (≤90s) with a sane two-sided quote counts as live
          if (t && t.ts > 0 && Date.now() - t.ts < 90000 && t.ask > t.bid && t.bid > 0) {
            out[s] = { mid: t.mid, bid: t.bid, ask: t.ask, source: "truefx", live: true, time: Date.now() };
            cache.set(s, out[s]);
            continue;
          }
          await fetchYahooFor(s, out);
        }
        for (const s of rest) await fetchYahooFor(s, out);
      })(),
    ]);
  }
  return out;
}

/** Yahoo chart-meta mid (delayed by source, honest live:false) — the fallback
 *  execution path for instruments TrueFX does not carry. */
async function fetchYahooFor(sym: string, out: Record<string, MidInfo>): Promise<void> {
  const inst = getInstrument(sym);
  if (!inst?.yahoo) return;
  try {
    const p = await fetchYahooMid(inst.yahoo);
    const info = { mid: p, source: "yahoo", live: false, time: Date.now() };
    out[sym] = info;
    cache.set(sym, info);
  } catch { /* leave missing — caller treats as unavailable */ }
}

/**
 * Symbols whose quote currency is not USD need a conversion instrument live
 * (e.g. USDJPY position P/L converts at the USDJPY rate itself — already in
 * the list; a GER40 position needs EURUSD).
 */
export function withConversionSymbols(symbols: string[]): string[] {
  const set = new Set(symbols);
  for (const s of symbols) {
    const inst = getInstrument(s);
    if (!inst || inst.quote === "USD") continue;
    if (inst.quote === "EUR") set.add("EURUSD");
    else if (inst.quote === "GBP") set.add("GBPUSD");
    else if (inst.quote === "JPY") set.add("USDJPY"); // conversion + the position pair itself
    else if (inst.quote === "CHF") set.add("USDCHF");
    else if (inst.quote === "CAD") set.add("USDCAD");
  }
  return [...set];
}

/** Two-sided executable quotes. Phase 18: when the feed supplies GENUINE two
 *  sides (TrueFX bid/ask) the real interbank spread is kept and only widened
 *  by the platform spreadMultiplier around the true mid; synthetic spreads
 *  (SPREAD_PIPS around the mid) remain the fallback for mid-only feeds. */
export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const mids = await getMids(withConversionSymbols(symbols));
  const settings = await getPlatformSettings();
  const mult = settings.spreadMultiplier || 1;
  const out: Record<string, Quote> = {};
  for (const [sym, info] of Object.entries(mids)) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    let q: Quote;
    if (info.bid != null && info.ask != null && info.ask > info.bid) {
      q = quoteFromTwoSided(info.bid, info.ask, mult, info.source, info.live, info.time);
    } else {
      q = quoteFromMid(info.mid, inst, info.source, info.live, info.time);
      if (mult !== 1) {
        const spread = (q.ask - q.bid) * mult;
        q.bid = q.mid - spread / 2;
        q.ask = q.mid + spread / 2;
      }
    }
    out[sym] = q;
  }
  return out;
}

/** All symbols the catalog can price — used by the health probe. */
export const ALL_SYMBOLS = INSTRUMENTS.map((i) => i.symbol);
