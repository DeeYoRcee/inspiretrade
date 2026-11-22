/**
 * InspireTrade Terminal — canonical instrument catalog, timeframes and chart
 * types. Shared between the client terminal and (later) server functions.
 *
 * Contract specs follow standard retail CFD/market conventions and are used by
 * the risk calculator / position sizing. They are reference specifications for
 * the DEMO execution environment — a real broker adapter must override them
 * with the broker's own symbol metadata.
 */

export type AssetClass = "forex" | "metal" | "crypto" | "index";

export interface InstrumentSpec {
  /** Display symbol, e.g. XAUUSD */
  symbol: string;
  /** Human name */
  name: string;
  assetClass: AssetClass;
  /** Digits shown on prices (JPY pairs 3, crypto variable, indices 1) */
  digits: number;
  /** Price of one pip/point used for P/L, in quote currency units */
  pipSize: number;
  /** Units of base asset per 1.00 lot (100k FX, 100 oz gold, 1 coin…) */
  contractSize: number;
  /** Quote currency (used for margin/P/L notes) */
  quote: string;
  /** Data backend preference. crypto → Binance (live), rest → quotes proxy */
  feed: "binance" | "quotes" | "demo";
  /** Binance symbol when feed = "binance" */
  binance?: string;
  /** Yahoo Finance symbol when feed = "quotes" */
  yahoo?: string;
  /** human-readable provider label shown in the chart badge (defaults by feed) */
  feedLabel?: string;
  /** what the yahoo symbol actually IS — the badge never misrepresents it */
  underlier: "spot" | "futures" | "index";
  /** trading session (UTC) — shown in the chart header */
  session: string;
  /** sanity envelope for feed identity: a response whose prices fall outside
   *  this band is another instrument's data — the chart refuses to render it */
  priceBand: [number, number];
  /** minimum price increment (tick size) */
  tickSize: number;
  /** gold-api live-spot code when the provider has a keyless spot feed */
  spotCode?: string;
}

export const INSTRUMENTS: InstrumentSpec[] = [
  // ---- Metals — SPOT prices only. Yahoo has no spot gold/silver symbol
  // (XAUUSD=X 404s), so history comes from stooq's spot CSV (primary) with
  // Yahoo's COMEX contract as a LAST-RESORT fallback that the badge labels
  // explicitly as futures. The live tail is gold-api's keyless spot feed.
  // PAXGUSDT / XAUTUSDT are tokenized assets (~0.4% below spot) and are
  // deliberately NOT used — they are different financial instruments.
  { symbol: "XAUUSD", name: "Gold Spot / U.S. Dollar", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes", yahoo: "GC=F", spotCode: "XAU", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.01, priceBand: [1000, 20000], feedLabel: "gold-api spot (chart + execution) · history stooq (spot)" },
  { symbol: "XAGUSD", name: "Silver Spot / U.S. Dollar", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5000, quote: "USD", feed: "quotes", yahoo: "SI=F", spotCode: "XAG", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.001, priceBand: [5, 200], feedLabel: "gold-api spot (chart + execution) · history stooq (spot)" },
  // ---- Forex majors — TrueFX prices the 10 majors LIVE (genuine bid/ask:
  // the chart paints BID to match Dukascopy's BID-side history, execution
  // quotes take the mid). Yahoo's FX identifiers are the genuine interbank
  // spot market but delayed by Yahoo's distribution — they supply history
  // and the execution fallback for pairs TrueFX does not carry (NZDUSD).
  { symbol: "EURUSD", name: "Euro / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "EURUSD=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.00001, priceBand: [0.5, 2], feedLabel: "TrueFX live · Yahoo history (delayed)" },
  { symbol: "GBPUSD", name: "British Pound / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.00001, priceBand: [0.9, 2.2], feedLabel: "TrueFX live · Yahoo history (delayed)" },
  { symbol: "USDJPY", name: "U.S. Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 100000, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.001, priceBand: [80, 250], feedLabel: "TrueFX live · Yahoo history (delayed)" },
  { symbol: "AUDUSD", name: "Australian Dollar / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.00001, priceBand: [0.4, 1.3], feedLabel: "TrueFX live · Yahoo history (delayed)" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / U.S. Dollar", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.00001, priceBand: [0.4, 1.2], feedLabel: "Yahoo FX spot (delayed)" },
  { symbol: "USDCAD", name: "U.S. Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.00001, priceBand: [0.9, 2], feedLabel: "TrueFX live · Yahoo history (delayed)" },
  { symbol: "USDCHF", name: "U.S. Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X", underlier: "spot", session: "Sun 22:00 – Fri 21:00 UTC (24/5)", tickSize: 0.00001, priceBand: [0.6, 1.6], feedLabel: "TrueFX live · Yahoo history (delayed)" },
  // ---- Crypto — Binance is the industry-standard price venue. Binance
  // quotes USDT pairs (BTC/USDT), the badge discloses that basis (USDT ≈ USD).
  { symbol: "BTCUSD", name: "Bitcoin / U.S. Dollar", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT", underlier: "spot", session: "24/7", tickSize: 0.01, priceBand: [5000, 500000], feedLabel: "Binance · BTC/USDT (USDT ≈ USD)" },
  { symbol: "ETHUSD", name: "Ethereum / U.S. Dollar", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT", underlier: "spot", session: "24/7", tickSize: 0.01, priceBand: [100, 20000], feedLabel: "Binance · ETH/USDT (USDT ≈ USD)" },
  { symbol: "SOLUSD", name: "Solana / U.S. Dollar", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT", underlier: "spot", session: "24/7", tickSize: 0.01, priceBand: [5, 2000], feedLabel: "Binance · SOL/USDT (USDT ≈ USD)" },
  { symbol: "XRPUSD", name: "XRP / U.S. Dollar", assetClass: "crypto", digits: 4, pipSize: 0.0001, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT", underlier: "spot", session: "24/7", tickSize: 0.0001, priceBand: [0.05, 20], feedLabel: "Binance · XRP/USDT (USDT ≈ USD)" },
  // ---- Indices — CFD reference levels tracked from the underlying index.
  { symbol: "NAS100", name: "US Tech 100 (NDX)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX", underlier: "index", session: "Mon–Fri 13:30–20:00 UTC (US cash)", tickSize: 0.25, priceBand: [3000, 40000], feedLabel: "Yahoo index (delayed)" },
  { symbol: "US30", name: "Wall Street 30 (DJI)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI", underlier: "index", session: "Mon–Fri 13:30–20:00 UTC (US cash)", tickSize: 1, priceBand: [10000, 80000], feedLabel: "Yahoo index (delayed)" },
  { symbol: "SPX500", name: "US 500 (S&P 500)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC", underlier: "index", session: "Mon–Fri 13:30–20:00 UTC (US cash)", tickSize: 0.25, priceBand: [1500, 15000], feedLabel: "Yahoo index (delayed)" },
  { symbol: "GER40", name: "Germany 40 (DAX)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI", underlier: "index", session: "Mon–Fri 08:00–21:00 UTC (Xetra)", tickSize: 1, priceBand: [5000, 50000], feedLabel: "Yahoo index (delayed)" },
  { symbol: "UK100", name: "UK 100 (FTSE 100)", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE", underlier: "index", session: "Mon–Fri 08:00–16:30 UTC (LSE)", tickSize: 0.5, priceBand: [3000, 20000], feedLabel: "Yahoo index (delayed)" },
];

export function getInstrument(symbol: string): InstrumentSpec | undefined {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}

// ---- Timeframes ------------------------------------------------------------

// Sub-minute (seconds) timeframes were removed — no honest data source backs
// them across instruments and they never carried real history.

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1W" | "1M";

export const TIMEFRAMES: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];

/** Seconds per timeframe bar. */
export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1W": 604800, "1M": 2592000,
};

/**
 * Which timeframes a given instrument genuinely supports. The list is
 * instrument-independent now that seconds TFs are gone; the function stays
 * so callers keep one honest entry point for timeframe availability.
 */
export function availableTimeframes(_symbol: string): Timeframe[] {
  return TIMEFRAMES;
}

/** Provider interval strings. */
export const BINANCE_INTERVAL: Record<Timeframe, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d", "1W": "1w", "1M": "1M",
};

export const YAHOO_INTERVAL: Partial<Record<Timeframe, { range: string; interval: string }>> = {
  "1m": { range: "5d", interval: "1m" },
  "3m": { range: "5d", interval: "1m" },
  "5m": { range: "1mo", interval: "5m" },
  "15m": { range: "1mo", interval: "15m" },
  "30m": { range: "1mo", interval: "30m" },
  "1h": { range: "3mo", interval: "60m" },
  "2h": { range: "3mo", interval: "60m" },
  "4h": { range: "1y", interval: "60m" },
  // Phase 30 §5: 5y — the range buttons expose 5Y/All on the daily chart;
  // Yahoo daily handles it fine (~1250 bars) and stooq supplements deeper
  "1d": { range: "5y", interval: "1d" },
  "1W": { range: "5y", interval: "1wk" },
  "1M": { range: "10y", interval: "1mo" },
};

/** Timeframes that need client-side aggregation from a base feed interval. */
export const YAHOO_AGGREGATE: Partial<Record<Timeframe, Timeframe>> = {
  "3m": "1m", "2h": "1h", "4h": "1h",
};

// ---- Chart types ------------------------------------------------------------

export type ChartType = "candles" | "hollow" | "bars" | "line" | "area" | "baseline" | "heikin" | "renko";

export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow" },
  { id: "bars", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "baseline", label: "Baseline" },
  { id: "heikin", label: "Heikin Ashi" },
  { id: "renko", label: "Renko" },
];

/** Convert OHLC bars to Heikin-Ashi bars (time preserved). */
export function toHeikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (prevOpen + prevClose) / 2;
    const high = Math.max(b.high, open, close);
    const low = Math.min(b.low, open, close);
    out.push({ time: b.time, open, high, low, close });
    prevOpen = open;
    prevClose = close;
  }
  return out;
}

/** Convert OHLC bars to Renko bricks (adaptive brick size, time of brick end). */
export function toRenko(bars: Bar[], brickPct = 0.15): Bar[] {
  if (!bars.length) return [];
  // adaptive brick: half the average true range of the last 14 bars, clamped
  let range = 0, n = 0;
  for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
    range += bars[i].high - bars[i].low;
    n++;
  }
  const avgRange = n ? range / n : 0;
  const seedClose = bars[bars.length - 1].close;
  const brick = Math.max(avgRange * 0.5, seedClose * (brickPct / 100) * 0.05) || seedClose * 0.0015;
  const out: Bar[] = [];
  let ref = bars[0].close;
  for (const b of bars) {
    let diff = b.close - ref;
    while (Math.abs(diff) >= brick) {
      const dir = Math.sign(diff);
      const open = ref;
      const c = ref + dir * brick;
      out.push({ time: b.time, open, high: Math.max(open, c), low: Math.min(open, c), close: c });
      ref = c;
      diff = b.close - ref;
    }
  }
  return out;
}

export interface Bar {
  time: number; // UNIX seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** REAL taker-buy base volume (Binance kline field 9). Enables true
   *  volume delta for crypto; absent for forex/indices feeds. */
  takerBuy?: number;
}

/** Aggregate 1m bars into N-minute bars (for 3m / 2h / 4h from proxy data). */
/**
 * Phase 29 — daily-bar timestamp normalization. The Dukascopy/stooq hybrid
 * store produced two anchor conventions for the SAME market day: the quotes
 * route stamps stooq dailies at UTC midnight while the hist backfill stored
 * them at Europe/Berlin midnight (= 22:00/23:00 UTC of the previous day).
 * A chart folding both layers then rendered the same day twice, one bar
 * shifted half a day left — the "D1 candles have a different shape" defect.
 * Noon-snap re-anchors any daily bar that is NOT on a UTC midnight into the
 * UTC day it belongs to (idempotent for already-UTC rows). Only ever applied
 * to 1d bars — intraday granularity must stay untouched.
 */
export function normalizeDailyAnchors(bars: { time: number; open: number; high: number; low: number; close: number; volume?: number }[]): { time: number; open: number; high: number; low: number; close: number; volume?: number }[] {
  return bars.map((b) => {
    if (b.time % 86400 === 0) return b;
    return { ...b, time: Math.floor((b.time + 12 * 3600) / 86400) * 86400 };
  });
}

/**
 * Phase 29 — EURUSD D1 (and every FX daily): the store's own BID-minute fold
 * (UTC days, same engine as M1/M5/H1/H4) must win the recent window, while
 * stooq's date-stamped dailies carry the DEPTH. `deep` = stooq rows already
 * noon-snapped to UTC days; `recent` = the store fold. Store wins overlap —
 * one convention, one price side, no duplicate-day pairs.
 */
export function mergeFxStoreDaily(
  deep: { time: number; open: number; high: number; low: number; close: number; volume?: number }[],
  recent: { time: number; open: number; high: number; low: number; close: number; volume?: number }[],
): { time: number; open: number; high: number; low: number; close: number; volume?: number }[] {
  const byTime = new Map<number, { time: number; open: number; high: number; low: number; close: number; volume?: number }>();
  for (const b of deep) byTime.set(b.time, b);
  for (const b of recent) byTime.set(b.time, b); // store wins the overlap
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function aggregateBars(bars: Bar[], factorMinutes: number): Bar[] {
  const bucket = factorMinutes * 60;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const t = Math.floor(b.time / bucket) * bucket;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Phase 26 §S4 — ingest identity bands for the SPOT metals stores (the
 * recorded spotTicks write path AND the TwelveData provider backfill).
 * Derived from the same per-instrument priceBand the chart refuses to render
 * outside: a store write whose prices fall outside the band is another
 * instrument's data and must never poison the shared chart history. */
export const SPOT_PRICE_BANDS: Record<string, [number, number]> = {
  XAU: getInstrument("XAUUSD")?.priceBand ?? [1000, 20000],
  XAG: getInstrument("XAGUSD")?.priceBand ?? [5, 200],
};
