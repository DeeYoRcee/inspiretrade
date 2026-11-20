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

// ---------------------------------------------------------------------------
// Phase 28 — ingest guards (pure, testable). A malformed TrueFX row must
// never reach the fxLive store, the chart paint or the execution mids.
// ---------------------------------------------------------------------------

/** TrueFX big figures have a fixed per-class shape: "1.09" (4-figure majors,
 * 2 decimals) or "159." (JPY-style, 1 decimal + trailing dot). Anything else
 * is a truncated/malformed row. */
export const TRUEFX_BIG_FIGURE_RE = /^\d+\.(?:\d{2})?$/;

export interface TrueFxParseCtx {
  /** last accepted bid per pair — the jump-guard baseline */
  lastGood?: Record<string, number>;
  /** ms timestamp of each pair's last accepted quote (stale-base escape) */
  lastGoodAt?: Record<string, number>;
  nowMs?: number;
}

export interface TrueFxParsedRow {
  code: string;
  quote: TrueFxQuote;
}

/**
 * Parse one CSV row with the Phase 28 guards:
 *  - big-figure structure: "1.1"+"6023" string-concats to 1.16023 — a
 *    mid-2025 EUR/USD price that (before this guard) poisoned the daily
 *    candle's high on 2026-11-21 (max() is monotonic — the fake wick never
 *    healed). Refuse the malformed row outright.
 *  - per-pair jump guard: consecutive anonymous snapshots are ~1s apart and
 *    FX majors never move 1.5% between them; a candidate beyond that is
 *    refused unless the pair has gone 5 minutes without ANY accepted quote
 *    (a genuine regime move must win eventually — honest staleness beats a
 *    frozen feed).
 */
export function parseTrueFxRow(f: string[], ctx?: TrueFxParseCtx): TrueFxParsedRow | null {
  if (f.length < 8) return null;
  const pair = f[0]?.trim();
  if (!pair || !pair.includes("/")) return null;
  const code = pair.replace("/", "");
  if (!TRUEFX_BIG_FIGURE_RE.test(String(f[2])) || !TRUEFX_BIG_FIGURE_RE.test(String(f[4]))) return null;
  const bid = Number.parseFloat(String(f[2]) + String(f[3]));
  const ask = Number.parseFloat(String(f[4]) + String(f[5]));
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
  const last = ctx?.lastGood?.[code];
  if (last && last > 0 && Math.abs(bid / last - 1) > 0.015) {
    const nowMs = ctx?.nowMs ?? Date.now();
    const acceptedAt = ctx?.lastGoodAt?.[code] ?? 0;
    if (nowMs - acceptedAt < 300000) return null;
  }
  const ts = Number(f[1]);
  const open = Number.isFinite(Number(f[8])) ? Number(f[8]) : null;
  return { code, quote: { bid, ask, mid: (bid + ask) / 2, ts: Number.isFinite(ts) ? ts : 0, open } };
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
      // jump-guard baseline = the previously accepted quotes (the 2s TTL cache)
      const lg: Record<string, number> = {};
      const lga: Record<string, number> = {};
      for (const [code, q] of Object.entries(cache?.quotes ?? {})) {
        lg[code] = q.bid;
        lga[code] = cache?.at ?? 0;
      }
      for (const line of text.split("\n")) {
        const parsed = parseTrueFxRow(line.split(","), { lastGood: lg, lastGoodAt: lga, nowMs: Date.now() });
        if (!parsed) continue;
        out[parsed.code] = parsed.quote;
        lg[parsed.code] = parsed.quote.bid;
        lga[parsed.code] = Date.now();
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
