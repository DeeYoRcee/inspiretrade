/**
 * Technical indicator math — pure functions over Bar[].
 *
 * Every function returns an array aligned 1:1 with the input candles
 * (null during the warm-up window), so chart code can feed the series
 * with `setData` and `update` the last point without index math.
 * Real candles in → real values out; nothing is generated here.
 */

export interface BarLike {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Point = number | null;

/** Simple Moving Average over `period`. */
export function sma(values: number[], period: number): Point[] {
  const out: Point[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential Moving Average (seeded with the first SMA of `period`). */
export function ema(values: number[], period: number): Point[] {
  const out: Point[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI (smoothed averages). */
export function rsi(values: number[], period = 14): Point[] {
  const out: Point[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdResult {
  macd: Point[];   // EMA(fast) − EMA(slow)
  signal: Point[]; // EMA(macdPeriod) of macd (macd warm-up gap preserved)
  hist: Point[];   // macd − signal
}

/** MACD (default 12/26/9). */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: Point[] = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i]! - emaSlow[i]! : null,
  );
  // signal = EMA over the non-null macd segment, mapped back with warm-up kept
  const signal: Point[] = new Array(values.length).fill(null);
  const hist: Point[] = new Array(values.length).fill(null);
  const seg: number[] = [];
  let segStart = -1;
  for (let i = 0; i < values.length; i++) {
    if (macdLine[i] != null) { if (segStart < 0) segStart = i; seg.push(macdLine[i]!); }
  }
  if (segStart >= 0) {
    const sigSeg = ema(seg, signalPeriod);
    for (let i = 0; i < sigSeg.length; i++) {
      const v = sigSeg[i];
      if (v != null) {
        signal[segStart + i] = v;
        hist[segStart + i] = macdLine[segStart + i]! - v;
      }
    }
  }
  return { macd: macdLine, signal, hist };
}

export interface BollingerResult {
  basis: Point[];
  upper: Point[];
  lower: Point[];
}

/** Bollinger Bands (SMA ± stddev·mult). */
export function bollinger(values: number[], period = 20, mult = 2): BollingerResult {
  const basis = sma(values, period);
  const upper: Point[] = new Array(values.length).fill(null);
  const lower: Point[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const b = basis[i]!;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - b) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = b + mult * sd;
    lower[i] = b - mult * sd;
  }
  return { basis, upper, lower };
}

/** Wilder's ATR. */
export function atr(bars: BarLike[], period = 14): Point[] {
  const out: Point[] = new Array(bars.length).fill(null);
  if (period <= 0 || bars.length <= period) return out;
  const tr: number[] = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i] ?? 0;
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** True range series (VWAP's cousin — used by tests too). */
export function trueRange(bars: BarLike[]): number[] {
  const out: number[] = bars.length ? [bars[0].high - bars[0].low] : [];
  for (let i = 1; i < bars.length; i++) {
    out.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }
  return out;
}

export interface VwapResult {
  vwap: Point[];
  /** session (UTC day) of each point — for chart coloring if needed */
  session: number[];
}

/**
 * Session VWAP: Σ(typical·volume)/Σ(volume) reset at each UTC midnight
 * (bars with 0/undefined volume carry the previous session value forward).
 */
export function vwap(bars: BarLike[]): VwapResult {
  const out: Point[] = new Array(bars.length).fill(null);
  const session: number[] = new Array(bars.length).fill(0);
  let day = -1;
  let cumPV = 0;
  let cumV = 0;
  let last = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = Math.floor(b.time / 86_400);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    const vol = b.volume && b.volume > 0 ? b.volume : 0;
    cumPV += typical * vol;
    cumV += vol;
    if (cumV > 0) last = cumPV / cumV;
    out[i] = cumV > 0 ? last : null;
    session[i] = day;
  }
  return { vwap: out, session };
}

export interface StochResult {
  k: Point[];
  d: Point[];
}

/** Stochastic Oscillator (%K raw, %D = SMA of %K). */
export function stochastic(bars: BarLike[], kPeriod = 14, dPeriod = 3): StochResult {
  const k: Point[] = new Array(bars.length).fill(null);
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    k[i] = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
  }
  const kv = k.map((x) => x ?? 0);
  const dRaw = sma(kv, dPeriod);
  const d: Point[] = k.map((v, i) => (v == null || i < kPeriod - 1 + dPeriod - 1 ? null : dRaw[i]));
  return { k, d };
}
