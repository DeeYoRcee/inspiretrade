/**
 * TrueFX free real-time feed (shared lib) — no key, anonymous CSV, covers the
 * 10 majors live (EUR/USD, USD/JPY, GBP/USD, EUR/GBP, USD/CHF, EUR/JPY,
 * EUR/CHF, USD/CAD, AUD/USD, GBP/JPY). One request answers every pair, so the
 * live-quote poll stops hammering Yahoo for the majors.
 *
 * Quote convention (Phase 18 audit): TrueFX genuinely supplies BOTH sides —
 * bigFigure+pips for BID (cols 2-3) and for ASK (cols 4-5). We therefore
 * expose all three representations explicitly:
 *   bid  — the executable sell side (chart convention: broker charts plot BID,
 *          and the Dukascopy free history is BID_candles_min_1 → live tail
 *          paints bid so history and live stay on one price side)
 *   ask  — the executable buy side
 *   mid  — (bid+ask)/2 — the honest execution/quote price
 * The big-figure concatenation ("1.09"+"996" → 1.09996; "159."+"890" →
 * 159.890) is verified against the Dukascopy Nov 17 daily candle range.
 */
const TRUEFX_URL = "https://webrates.truefx.com/rates/connect.html?f=csv";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface TrueFxQuote {
  bid: number;
  ask: number;
  mid: number;
  /** provider tick timestamp (ms) — 0 when missing */
  ts: number;
  /** session open (col 8) when the provider includes it */
  open: number | null;
}

export const TRUEFX_UA = UA;

// tiny module-level TTL cache: one anonymous request answers EVERY pair, and
// several call sites (chart paint, execution mids, batch snapshots) can fire
// within the same seconds — never hammer the free endpoint per call.
const CACHE_TTL_MS = 2000;
let cache: { at: number; quotes: Record<string, TrueFxQuote> } | null = null;
let inflight: Promise<Record<string, TrueFxQuote>> | null = null;

export const truefxQuotes = async (): Promise<Record<string, TrueFxQuote>> => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.quotes;
  if (inflight) return inflight;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(TRUEFX_URL, { headers: { "User-Agent": UA, Accept: "text/csv" }, signal: controller.signal });
      if (!res.ok) return cache?.quotes ?? {};
      const text = await res.text();
      const out: Record<string, TrueFxQuote> = {};
      for (const line of text.split("\n")) {
        const f = line.split(",");
        if (f.length < 8) continue;
        const pair = f[0]?.trim();
        if (!pair || !pair.includes("/")) continue;
        const code = pair.replace("/", "");
        const bid = Number.parseFloat(String(f[2]) + String(f[3]));
        const ask = Number.parseFloat(String(f[4]) + String(f[5]));
        const ts = Number(f[1]);
        const open = Number.isFinite(Number(f[8])) ? Number(f[8]) : null;
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) continue;
        out[code] = { bid, ask, mid: (bid + ask) / 2, ts: Number.isFinite(ts) ? ts : 0, open };
      }
      if (Object.keys(out).length) cache = { at: Date.now(), quotes: out };
      return out;
    } catch {
      return cache?.quotes ?? {};
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
};
