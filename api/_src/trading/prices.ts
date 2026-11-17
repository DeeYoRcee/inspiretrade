/**
 * Server-side price service — the single execution price authority.
 *
 * Sources (all free, no key, REAL data — the engine never invents prices):
 *  - crypto      : Binance public REST ticker (live), mirror host failover
 *  - gold/silver : gold-api.com spot (live, seconds-fresh)
 *  - fx/indices  : Yahoo Finance chart meta (delayed by source, cached 45s)
 *
 * Short in-memory TTLs per lambda instance keep repeated evaluator calls cheap
 * without ever executing against stale crypto/gold prices.
 */
import { getInstrument, INSTRUMENTS } from "../../../shared/terminal";
import { quoteFromMid, type Quote } from "../../../shared/trading-engine";
import { getPlatformSettings } from "../lib/platform";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BINANCE_HOSTS = ["api.binance.com", "data-api.binance.vision"];
const CRYPTO_TTL = 3000;
const SPOT_TTL = 5000;
const YAHOO_TTL = 45000;

type MidInfo = { mid: number; source: string; live: boolean; time: number };
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

// XAGUSD only — XAUUSD now prices from Binance PAXG/USDT (feed = "binance"),
// so the chart and the engine share one real-time source
const GOLD_CODES: Record<string, string> = { XAGUSD: "XAG" };

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
          } catch { /* spot down — Yahoo fallback below will fill it if listed */ }
        }
      })(),
      (async () => {
        for (const s of yahoo) {
          const inst = getInstrument(s);
          if (!inst?.yahoo) continue;
          try {
            const p = await fetchYahooMid(inst.yahoo);
            out[s] = { mid: p, source: "yahoo", live: false, time: Date.now() };
            cache.set(s, out[s]);
          } catch { /* leave missing — caller treats as unavailable */ }
        }
      })(),
    ]);
  }
  return out;
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

/** Two-sided executable quotes (bid/ask around the mid, spread by instrument,
 *  scaled by the platform spreadMultiplier setting). */
export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const mids = await getMids(withConversionSymbols(symbols));
  const settings = await getPlatformSettings();
  const mult = settings.spreadMultiplier || 1;
  const out: Record<string, Quote> = {};
  for (const [sym, info] of Object.entries(mids)) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    const q = quoteFromMid(info.mid, inst, info.source, info.live, info.time);
    if (mult !== 1) {
      const spread = (q.ask - q.bid) * mult;
      q.bid = q.mid - spread / 2;
      q.ask = q.mid + spread / 2;
    }
    out[sym] = q;
  }
  return out;
}

/** All symbols the catalog can price — used by the health probe. */
export const ALL_SYMBOLS = INSTRUMENTS.map((i) => i.symbol);
