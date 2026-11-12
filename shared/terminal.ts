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
}

export const INSTRUMENTS: InstrumentSpec[] = [
  // ---- Metals -------------------------------------------------------------
  { symbol: "XAUUSD", name: "Gold / USD", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes", yahoo: "GC=F" },
  { symbol: "XAGUSD", name: "Silver / USD", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5000, quote: "USD", feed: "quotes", yahoo: "SI=F" },
  // ---- Forex majors -------------------------------------------------------
  { symbol: "EURUSD", name: "Euro / USD", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "EURUSD=X" },
  { symbol: "GBPUSD", name: "British Pound / USD", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X" },
  { symbol: "USDJPY", name: "US Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 100000, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X" },
  { symbol: "AUDUSD", name: "Australian Dollar / USD", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / USD", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X" },
  { symbol: "USDCAD", name: "US Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X" },
  { symbol: "USDCHF", name: "US Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 0.0001, contractSize: 100000, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X" },
  // ---- Crypto (live via Binance public API, no key) -----------------------
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT" },
  { symbol: "ETHUSD", name: "Ethereum / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT" },
  { symbol: "XRPUSD", name: "XRP / USD", assetClass: "crypto", digits: 4, pipSize: 0.0001, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT" },
  // ---- Indices (CFD reference levels, quotes proxy) -----------------------
  { symbol: "NAS100", name: "US Tech 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX" },
  { symbol: "US30", name: "Wall Street 30", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI" },
  { symbol: "SPX500", name: "US 500", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC" },
  { symbol: "GER40", name: "Germany 40", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI" },
  { symbol: "UK100", name: "UK 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE" },
];

export function getInstrument(symbol: string): InstrumentSpec | undefined {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}

// ---- Timeframes ------------------------------------------------------------

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1W" | "1M";

export const TIMEFRAMES: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];

/** Seconds per timeframe bar. */
export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1W": 604800, "1M": 2592000,
};

/** Provider interval strings. */
export const BINANCE_INTERVAL: Record<Timeframe, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d", "1W": "1w", "1M": "1M",
};

export const YAHOO_INTERVAL: Record<Timeframe, { range: string; interval: string }> = {
  "1m": { range: "5d", interval: "1m" },
  "3m": { range: "5d", interval: "1m" },
  "5m": { range: "1mo", interval: "5m" },
  "15m": { range: "1mo", interval: "15m" },
  "30m": { range: "1mo", interval: "30m" },
  "1h": { range: "3mo", interval: "60m" },
  "2h": { range: "3mo", interval: "60m" },
  "4h": { range: "1y", interval: "60m" },
  "1d": { range: "2y", interval: "1d" },
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
