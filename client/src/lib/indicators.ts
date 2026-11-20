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

// ---------------------------------------------------------------------------
// Phase 27 — the TradingView-standard set. Every function keeps the same
// contract as above: aligned Point[], null during the warm-up window, no
// fabricated data. Segment helpers (smaSegment / emaSegment) smooth over the
// NON-NULL part of a series and map back with warm-up gaps preserved — the
// same pattern MACD's signal line already uses.
// ---------------------------------------------------------------------------

/** SMA over the contiguous non-null segments of `vals`, mapped back. */
function smaSegment(vals: Point[], period: number): Point[] {
  const out: Point[] = new Array(vals.length).fill(null);
  const flush = (seg: number[], start: number) => {
    const sm = sma(seg, period);
    for (let k = 0; k < sm.length; k++) if (sm[k] != null) out[start + k] = sm[k];
  };
  let seg: number[] = [];
  let start = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] != null) {
      if (start < 0) start = i;
      seg.push(vals[i]!);
    } else if (seg.length) {
      flush(seg, start);
      seg = [];
      start = -1;
    }
  }
  if (seg.length) flush(seg, start);
  return out;
}

/** EMA over the contiguous non-null segments of `vals`, mapped back. */
function emaSegment(vals: Point[], period: number): Point[] {
  const out: Point[] = new Array(vals.length).fill(null);
  const flush = (seg: number[], start: number) => {
    const sm = ema(seg, period);
    for (let k = 0; k < sm.length; k++) if (sm[k] != null) out[start + k] = sm[k];
  };
  let seg: number[] = [];
  let start = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] != null) {
      if (start < 0) start = i;
      seg.push(vals[i]!);
    } else if (seg.length) {
      flush(seg, start);
      seg = [];
      start = -1;
    }
  }
  if (seg.length) flush(seg, start);
  return out;
}

/** Weighted Moving Average — linear weights n..1 over the window. */
export function wma(values: number[], period: number): Point[] {
  const out: Point[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - j] * (period - j);
    out[i] = acc / denom;
  }
  return out;
}

/** Hull Moving Average — WMA(2·WMA(n/2) − WMA(n), √n). */
export function hma(values: number[], period: number): Point[] {
  const n = Math.max(2, Math.floor(period));
  const half = Math.max(1, Math.floor(n / 2));
  const sqrtN = Math.max(1, Math.round(Math.sqrt(n)));
  const wHalf = wma(values, half);
  const wFull = wma(values, n);
  const raw: number[] = [];
  const rawIdx: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (wHalf[i] != null && wFull[i] != null) {
      raw.push(2 * wHalf[i]! - wFull[i]!);
      rawIdx.push(i);
    }
  }
  const smoothed = wma(raw, sqrtN);
  const out: Point[] = new Array(values.length).fill(null);
  for (let k = 0; k < rawIdx.length; k++) out[rawIdx[k]] = smoothed[k];
  return out;
}

export interface SuperTrendResult {
  /** line value during an uptrend (trailing support) */
  up: Point[];
  /** line value during a downtrend (trailing resistance) */
  down: Point[];
}

/** SuperTrend — ATR trailing band with trend flips. */
export function supertrend(bars: BarLike[], period = 10, mult = 3): SuperTrendResult {
  const n = bars.length;
  const up: Point[] = new Array(n).fill(null);
  const down: Point[] = new Array(n).fill(null);
  const a = atr(bars, period);
  let trend = 1;
  let finalUpper = 0;
  let finalLower = 0;
  let seeded = false;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const basicUpper = mid + mult * a[i]!;
    const basicLower = mid - mult * a[i]!;
    if (!seeded) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = bars[i].close >= mid ? 1 : -1;
      seeded = true;
      if (trend === 1) up[i] = finalLower;
      else down[i] = finalUpper;
      continue;
    }
    finalUpper = basicUpper < finalUpper || bars[i - 1].close > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || bars[i - 1].close < finalLower ? basicLower : finalLower;
    if (trend === 1 && bars[i].close < finalLower) trend = -1;
    else if (trend === -1 && bars[i].close > finalUpper) trend = 1;
    if (trend === 1) up[i] = finalLower;
    else down[i] = finalUpper;
  }
  return { up, down };
}

export interface DonchianResult {
  upper: Point[];
  basis: Point[];
  lower: Point[];
}

/** Donchian Channel — highest high / lowest low of the window + midpoint. */
export function donchian(bars: BarLike[], period = 20): DonchianResult {
  const n = bars.length;
  const upper: Point[] = new Array(n).fill(null);
  const basis: Point[] = new Array(n).fill(null);
  const lower: Point[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    upper[i] = hh;
    lower[i] = ll;
    basis[i] = (hh + ll) / 2;
  }
  return { upper, basis, lower };
}

export interface KeltnerResult {
  basis: Point[];
  upper: Point[];
  lower: Point[];
}

/** Keltner Channel — EMA(close) ± mult·ATR. */
export function keltner(bars: BarLike[], period = 20, mult = 2): KeltnerResult {
  const closes = bars.map((b) => b.close);
  const basis = ema(closes, period);
  const a = atr(bars, period);
  const upper: Point[] = new Array(bars.length).fill(null);
  const lower: Point[] = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (basis[i] != null && a[i] != null) {
      upper[i] = basis[i]! + mult * a[i]!;
      lower[i] = basis[i]! - mult * a[i]!;
    }
  }
  return { basis, upper, lower };
}

/** Parabolic SAR (Wilder) — dotted point trail, flips on penetration. */
export function psar(bars: BarLike[], step = 0.02, max = 0.2): Point[] {
  const n = bars.length;
  const out: Point[] = new Array(n).fill(null);
  if (n < 2) return out;
  let up = bars[1].close >= bars[0].close;
  let sar = up ? bars[0].low : bars[0].high;
  let ep = up ? bars[0].high : bars[0].low;
  let af = step;
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    // SAR must never penetrate the two previous bars' range on the trend side
    if (up) sar = Math.min(sar, bars[i - 1].low, i >= 2 ? bars[i - 2].low : bars[i - 1].low);
    else sar = Math.max(sar, bars[i - 1].high, i >= 2 ? bars[i - 2].high : bars[i - 1].high);
    if (up) {
      if (bars[i].low < sar) {
        up = false;
        sar = ep;
        ep = bars[i].low;
        af = step;
      } else if (bars[i].high > ep) {
        ep = bars[i].high;
        af = Math.min(af + step, max);
      }
    } else {
      if (bars[i].high > sar) {
        up = true;
        sar = ep;
        ep = bars[i].high;
        af = step;
      } else if (bars[i].low < ep) {
        ep = bars[i].low;
        af = Math.min(af + step, max);
      }
    }
    out[i] = sar;
  }
  return out;
}

export interface IchimokuResult {
  tenkan: Point[];
  kijun: Point[];
  spanA: Point[];
  spanB: Point[];
}

/**
 * Ichimoku Cloud. NOTE: Senkou A/B are plotted at their CALCULATION bar
 * (no +26 forward shift) so every series stays aligned 1:1 with the input
 * candles — the chart contract of this module.
 */
export function ichimoku(bars: BarLike[], conv = 9, base = 26, span = 52): IchimokuResult {
  const n = bars.length;
  const tenkan: Point[] = new Array(n).fill(null);
  const kijun: Point[] = new Array(n).fill(null);
  const spanA: Point[] = new Array(n).fill(null);
  const spanB: Point[] = new Array(n).fill(null);
  const midpoint = (p: number, i: number): number => {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    return (hh + ll) / 2;
  };
  for (let i = 0; i < n; i++) {
    if (i >= conv - 1) tenkan[i] = midpoint(conv, i);
    if (i >= base - 1) kijun[i] = midpoint(base, i);
    if (tenkan[i] != null && kijun[i] != null) spanA[i] = (tenkan[i]! + kijun[i]!) / 2;
    if (i >= span - 1) spanB[i] = midpoint(span, i);
  }
  return { tenkan, kijun, spanA, spanB };
}

export interface AdxResult {
  adx: Point[];
  plusDI: Point[];
  minusDI: Point[];
}

/** ADX / DMI (Wilder smoothing) — trend strength + directional movement. */
export function adx(bars: BarLike[], period = 14): AdxResult {
  const n = bars.length;
  const outAdx: Point[] = new Array(n).fill(null);
  const plusDI: Point[] = new Array(n).fill(null);
  const minusDI: Point[] = new Array(n).fill(null);
  if (n < period + 2) return { adx: outAdx, plusDI, minusDI };
  const trArr = trueRange(bars);
  const dm = (cur: BarLike, prev: BarLike) => {
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    return {
      p: upMove > downMove && upMove > 0 ? upMove : 0,
      m: downMove > upMove && downMove > 0 ? downMove : 0,
    };
  };
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  for (let i = 1; i <= period; i++) {
    const { p, m } = dm(bars[i], bars[i - 1]);
    tr += trArr[i] ?? 0;
    pdm += p;
    mdm += m;
  }
  let adxVal: number | null = null;
  let dxSum = 0;
  let dxCount = 0;
  const pushDi = (i: number) => {
    if (tr <= 0) return;
    const pdi = (100 * pdm) / tr;
    const mdi = (100 * mdm) / tr;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (adxVal == null) {
      dxSum += dx;
      dxCount++;
      if (dxCount === period) adxVal = dxSum / period;
    } else {
      adxVal = (adxVal * (period - 1) + dx) / period;
      outAdx[i] = adxVal;
    }
  };
  pushDi(period);
  for (let i = period + 1; i < n; i++) {
    const { p, m } = dm(bars[i], bars[i - 1]);
    tr = tr - tr / period + (trArr[i] ?? 0);
    pdm = pdm - pdm / period + p;
    mdm = mdm - mdm / period + m;
    pushDi(i);
  }
  return { adx: outAdx, plusDI, minusDI };
}

/** Williams %R — −100·(HH − close)/(HH − LL). */
export function williamsR(bars: BarLike[], period = 14): Point[] {
  const out: Point[] = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    out[i] = hh === ll ? -50 : (-100 * (hh - bars[i].close)) / (hh - ll);
  }
  return out;
}

/** Commodity Channel Index — (TP − SMA(TP)) / (0.015·mean deviation). */
export function cci(bars: BarLike[], period = 20): Point[] {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const avg = sma(tp, period);
  const out: Point[] = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - avg[i]!);
    const md = dev / period;
    out[i] = md === 0 ? 0 : (tp[i] - avg[i]!) / (0.015 * md);
  }
  return out;
}

export interface StochRsiResult {
  k: Point[];
  d: Point[];
}

/** Stochastic RSI — stochastic of the RSI, K smoothed, D = SMA(K). */
export function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): StochRsiResult {
  const r = rsi(closes, rsiPeriod);
  const kRaw: Point[] = new Array(closes.length).fill(null);
  for (let i = rsiPeriod + stochPeriod - 1; i < closes.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let any = false;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (r[j] == null) continue;
      hi = Math.max(hi, r[j]!);
      lo = Math.min(lo, r[j]!);
      any = true;
    }
    if (!any) continue;
    kRaw[i] = hi === lo ? 50 : ((r[i]! - lo) / (hi - lo)) * 100;
  }
  const k = smaSegment(kRaw, kSmooth);
  const d = smaSegment(k, dSmooth);
  return { k, d };
}

/** Money Flow Index — volume-weighted RSI over typical price. */
export function mfi(bars: BarLike[], period = 14): Point[] {
  const out: Point[] = new Array(bars.length).fill(null);
  const tp = (b: BarLike) => (b.high + b.low + b.close) / 3;
  for (let i = period; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp(bars[j]) * (bars[j].volume ?? 0);
      const prevTp = tp(bars[j - 1]);
      const curTp = tp(bars[j]);
      if (curTp > prevTp) pos += flow;
      else if (curTp < prevTp) neg += flow;
    }
    if (pos + neg <= 0) continue; // no volume data — honest null, not a fake 100
    out[i] = 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** On-Balance Volume — cumulative signed volume (flat on zero volume). */
export function obv(bars: BarLike[]): Point[] {
  const out: Point[] = new Array(bars.length).fill(null);
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i].volume ?? 0;
    if (v > 0 && i > 0) {
      if (bars[i].close > bars[i - 1].close) acc += v;
      else if (bars[i].close < bars[i - 1].close) acc -= v;
    }
    out[i] = acc;
  }
  return out;
}

/** TRIX — 1-bar % rate of change of the triple-EMA of close (×100 = percent). */
export function trix(closes: number[], period = 15): Point[] {
  const out: Point[] = new Array(closes.length).fill(null);
  const e1 = ema(closes, period);
  const e2 = emaSegment(e1, period);
  const e3 = emaSegment(e2, period);
  for (let i = 1; i < closes.length; i++) {
    if (e3[i] != null && e3[i - 1] != null && e3[i - 1] !== 0) {
      out[i] = (e3[i]! / e3[i - 1]! - 1) * 100;
    }
  }
  return out;
}

/** Awesome Oscillator — SMA(median,5) − SMA(median,34). */
export function awesomeOscillator(bars: BarLike[], fast = 5, slow = 34): Point[] {
  const mp = bars.map((b) => (b.high + b.low) / 2);
  const f = sma(mp, fast);
  const s = sma(mp, slow);
  const out: Point[] = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (f[i] != null && s[i] != null) out[i] = f[i]! - s[i]!;
  }
  return out;
}

/** Rate of Change — % change of close vs `period` bars ago. */
export function roc(closes: number[], period = 9): Point[] {
  const out: Point[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    if (closes[i - period] !== 0) out[i] = (closes[i] / closes[i - period] - 1) * 100;
  }
  return out;
}
