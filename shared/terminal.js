const INSTRUMENTS = [
  // ---- Metals -------------------------------------------------------------
  { symbol: "XAUUSD", name: "Gold / USD", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes", yahoo: "GC=F" },
  { symbol: "XAGUSD", name: "Silver / USD", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5e3, quote: "USD", feed: "quotes", yahoo: "SI=F" },
  // ---- Forex majors -------------------------------------------------------
  { symbol: "EURUSD", name: "Euro / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "EURUSD=X" },
  { symbol: "GBPUSD", name: "British Pound / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X" },
  { symbol: "USDJPY", name: "US Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 1e5, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X" },
  { symbol: "AUDUSD", name: "Australian Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X" },
  { symbol: "USDCAD", name: "US Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X" },
  { symbol: "USDCHF", name: "US Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X" },
  // ---- Crypto (live via Binance public API, no key) -----------------------
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT" },
  { symbol: "ETHUSD", name: "Ethereum / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT" },
  { symbol: "XRPUSD", name: "XRP / USD", assetClass: "crypto", digits: 4, pipSize: 1e-4, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT" },
  // ---- Indices (CFD reference levels, quotes proxy) -----------------------
  { symbol: "NAS100", name: "US Tech 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX" },
  { symbol: "US30", name: "Wall Street 30", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI" },
  { symbol: "SPX500", name: "US 500", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC" },
  { symbol: "GER40", name: "Germany 40", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI" },
  { symbol: "UK100", name: "UK 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE" }
];
function getInstrument(symbol) {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}
const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];
const TF_SECONDS = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "1d": 86400,
  "1W": 604800,
  "1M": 2592e3
};
const BINANCE_INTERVAL = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "1d": "1d",
  "1W": "1w",
  "1M": "1M"
};
const YAHOO_INTERVAL = {
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
  "1M": { range: "10y", interval: "1mo" }
};
const YAHOO_AGGREGATE = {
  "3m": "1m",
  "2h": "1h",
  "4h": "1h"
};
const CHART_TYPES = [
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow" },
  { id: "bars", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "baseline", label: "Baseline" },
  { id: "heikin", label: "Heikin Ashi" },
  { id: "renko", label: "Renko" }
];
function toHeikinAshi(bars) {
  const out = [];
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
function toRenko(bars, brickPct = 0.15) {
  if (!bars.length) return [];
  let range = 0, n = 0;
  for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
    range += bars[i].high - bars[i].low;
    n++;
  }
  const avgRange = n ? range / n : 0;
  const seedClose = bars[bars.length - 1].close;
  const brick = Math.max(avgRange * 0.5, seedClose * (brickPct / 100) * 0.05) || seedClose * 15e-4;
  const out = [];
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
function aggregateBars(bars, factorMinutes) {
  const bucket = factorMinutes * 60;
  const out = [];
  let cur = null;
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
export {
  BINANCE_INTERVAL,
  CHART_TYPES,
  INSTRUMENTS,
  TF_SECONDS,
  TIMEFRAMES,
  YAHOO_AGGREGATE,
  YAHOO_INTERVAL,
  aggregateBars,
  getInstrument,
  toHeikinAshi,
  toRenko
};
