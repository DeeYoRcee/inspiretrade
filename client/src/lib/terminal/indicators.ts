/**
 * Terminal indicator library — pure functions over Bar[].
 *
 * Every indicator returns { time, value }[] (or multiple series) aligned with
 * the input bars, computed from REAL OHLCV data. Values are rounded to a
 * sane precision to keep the chart series light.
 */
import type { Bar } from "@shared/terminal";

export type LinePoint = { time: number; value: number };
export type Line = LinePoint[];

const r8 = (v: number) => Math.round(v * 1e8) / 1e8;

export function sma(bars: Bar[], period: number): Line {
  const out: Line = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: r8(sum / period) });
  }
  return out;
}

export function ema(bars: Bar[], period: number): Line {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  const out: Line = [];
  let prev = bars.slice(0, period).reduce((s, b) => s + b.close, 0) / period;
  out.push({ time: bars[period - 1].time, value: r8(prev) });
  for (let i = period; i < bars.length; i++) {
    prev = bars[i].close * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: r8(prev) });
  }
  return out;
}

function emaFromPoints(pts: Line, period: number): Line {
  if (pts.length < period) return [];
  const k = 2 / (period + 1);
  const out: Line = [];
  let prev = pts.slice(0, period).reduce((s, p) => s + p.value, 0) / period;
  out.push({ time: pts[period - 1].time, value: r8(prev) });
  for (let i = period; i < pts.length; i++) {
    prev = pts[i].value * k + prev * (1 - k);
    out.push({ time: pts[i].time, value: r8(prev) });
  }
  return out;
}

export function wma(bars: Bar[], period: number): Line {
  const denom = (period * (period + 1)) / 2;
  const out: Line = [];
  for (let i = period - 1; i < bars.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += bars[i - j].close * (period - j);
    out.push({ time: bars[i].time, value: r8(acc / denom) });
  }
  return out;
}

export function vwma(bars: Bar[], period: number): Line {
  const out: Line = [];
  for (let i = period - 1; i < bars.length; i++) {
    let pv = 0, vv = 0;
    for (let j = 0; j < period; j++) {
      const b = bars[i - j];
      const v = b.volume ?? 1;
      pv += b.close * v;
      vv += v;
    }
    out.push({ time: bars[i].time, value: vv ? r8(pv / vv) : bars[i].close });
  }
  return out;
}

export function hma(bars: Bar[], period: number): Line {
  const half = wma(bars, Math.max(1, Math.floor(period / 2)));
  const full = wma(bars, period);
  // raw[i] = 2*WMA(n/2) - WMA(n), both series aligned by their last bar
  const offsetH = half.length - full.length;
  if (offsetH < 0) return [];
  const raw: Line = full.map((p, i) => ({ time: p.time, value: 2 * half[i + offsetH].value - p.value }));
  const n = Math.max(1, Math.floor(Math.sqrt(period)));
  const denom = (n * (n + 1)) / 2;
  const out: Line = [];
  for (let i = n - 1; i < raw.length; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += raw[i - j].value * (n - j);
    out.push({ time: raw[i].time, value: r8(acc / denom) });
  }
  return out;
}

// ---- Oscillators -----------------------------------------------------------

export function rsi(bars: Bar[], period = 14): Line {
  if (bars.length <= period) return [];
  const out: Line = [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const push = (i: number) => {
    const rs = loss === 0 ? 100 : gain / loss;
    out.push({ time: bars[i].time, value: r8(loss === 0 ? 100 : 100 - 100 / (1 + rs)) });
  };
  push(period);
  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    push(i);
  }
  return out;
}

export function macd(bars: Bar[], fast = 12, slow = 26, signalP = 9): { macd: Line; signal: Line; hist: Line } {
  const f = ema(bars, fast);
  const s = ema(bars, slow);
  const offset = f.length - s.length;
  const line: Line = s.map((p, i) => ({ time: p.time, value: r8(f[i + offset].value - p.value) }));
  const signal = emaFromPoints(line, signalP);
  const soffset = line.length - signal.length;
  const hist: Line = signal.map((p, i) => ({ time: p.time, value: r8(line[i + soffset].value - p.value) }));
  return { macd: line, signal, hist };
}

export function stochastic(bars: Bar[], kP = 14, dP = 3, smooth = 3): { k: Line; d: Line } {
  const raw: Line = [];
  for (let i = kP - 1; i < bars.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < kP; j++) { hh = Math.max(hh, bars[i - j].high); ll = Math.min(ll, bars[i - j].low); }
    raw.push({ time: bars[i].time, value: hh === ll ? 50 : r8(((bars[i].close - ll) / (hh - ll)) * 100) });
  }
  const k = smoothLine(raw, smooth);
  const d = smoothLine(k, dP);
  return { k, d };
}

function smoothLine(line: Line, period: number): Line {
  if (period <= 1) return line;
  const out: Line = [];
  for (let i = period - 1; i < line.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += line[i - j].value;
    out.push({ time: line[i].time, value: r8(acc / period) });
  }
  return out;
}

export function cci(bars: Bar[], period = 20): Line {
  const out: Line = [];
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  for (let i = period - 1; i < bars.length; i++) {
    let mean = 0;
    for (let j = 0; j < period; j++) mean += tp[i - j];
    mean /= period;
    let dev = 0;
    for (let j = 0; j < period; j++) dev += Math.abs(tp[i - j] - mean);
    dev /= period;
    out.push({ time: bars[i].time, value: dev === 0 ? 0 : r8((tp[i] - mean) / (0.015 * dev)) });
  }
  return out;
}

export function williamsR(bars: Bar[], period = 14): Line {
  const out: Line = [];
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period; j++) { hh = Math.max(hh, bars[i - j].high); ll = Math.min(ll, bars[i - j].low); }
    out.push({ time: bars[i].time, value: hh === ll ? -50 : r8(((hh - bars[i].close) / (hh - ll)) * -100) });
  }
  return out;
}

export function momentum(bars: Bar[], period = 10): Line {
  const out: Line = [];
  for (let i = period; i < bars.length; i++) {
    out.push({ time: bars[i].time, value: r8(bars[i].close - bars[i - period].close) });
  }
  return out;
}

export function roc(bars: Bar[], period = 12): Line {
  const out: Line = [];
  for (let i = period; i < bars.length; i++) {
    out.push({ time: bars[i].time, value: r8(((bars[i].close - bars[i - period].close) / bars[i - period].close) * 100) });
  }
  return out;
}

// ---- Trend -----------------------------------------------------------------

export function adx(bars: Bar[], period = 14): { adx: Line; plusDI: Line; minusDI: Line } {
  if (bars.length < period * 2) return { adx: [], plusDI: [], minusDI: [] };
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
    const up = b.high - p.high, dn = p.low - b.low;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = smooth(tr, period), sp = smooth(pdm, period), sm = smooth(mdm, period);
  const dx: number[] = [];
  const plusDI: Line = [], minusDI: Line = [];
  for (let i = 0; i < atr.length; i++) {
    const pdi = atr[i] ? (sp[i] / atr[i]) * 100 : 0;
    const mdi = atr[i] ? (sm[i] / atr[i]) * 100 : 0;
    plusDI.push({ time: bars[i + period].time, value: r8(pdi) });
    minusDI.push({ time: bars[i + period].time, value: r8(mdi) });
    dx.push(pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100);
  }
  // ADX = smoothed DX
  const adxRaw = smooth2(dx, period);
  const adxLine: Line = adxRaw.map((v, i) => ({ time: bars[i + period * 2 - 1].time, value: r8(v) }));
  return { adx: adxLine, plusDI, minusDI };
}

function smooth(src: number[], period: number): number[] {
  const out: number[] = [];
  let prev = src.slice(0, period).reduce((s, v) => s + v, 0);
  out.push(prev);
  for (let i = period; i < src.length; i++) {
    prev = prev - prev / period + src[i];
    out.push(prev);
  }
  return out;
}
function smooth2(src: number[], period: number): number[] {
  const out: number[] = [];
  let prev = src.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out.push(prev);
  for (let i = period; i < src.length; i++) {
    prev = (prev * (period - 1) + src[i]) / period;
    out.push(prev);
  }
  return out;
}

export function supertrend(bars: Bar[], period = 10, mult = 3): { line: Line; dirUp: boolean[] } {
  const atrLine = atrValues(bars, period);
  const out: Line = [];
  const dirUp: boolean[] = [];
  let trendUp = true;
  let prevUpper = Infinity, prevLower = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const av = atrLine[i];
    if (av == null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    let upper = mid + mult * av;
    let lower = mid - mult * av;
    if (i > 0) {
      upper = bars[i - 1].close > prevUpper ? Math.max(upper, prevUpper) : upper;
      lower = bars[i - 1].close < prevLower ? Math.min(lower, prevLower) : lower;
      if (bars[i].close > prevUpper) trendUp = true;
      else if (bars[i].close < prevLower) trendUp = false;
    }
    const st = trendUp ? lower : upper;
    out.push({ time: bars[i].time, value: r8(st) });
    dirUp.push(trendUp);
    prevUpper = upper; prevLower = lower;
  }
  return { line: out, dirUp };
}

export function parabolicSar(bars: Bar[], step = 0.02, max = 0.2): Line {
  if (bars.length < 2) return [];
  const out: Line = [];
  let up = bars[1].close >= bars[0].close;
  let af = step;
  let ep = up ? bars[0].high : bars[0].low;
  let sar = up ? bars[0].low : bars[0].high;
  for (let i = 1; i < bars.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      if (bars[i].low < sar) { up = false; sar = ep; ep = bars[i].low; af = step; }
      else if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(af + step, max); }
    } else {
      if (bars[i].high > sar) { up = true; sar = ep; ep = bars[i].high; af = step; }
      else if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(af + step, max); }
    }
    out.push({ time: bars[i].time, value: r8(sar) });
  }
  return out;
}

export function ichimoku(bars: Bar[], conv = 9, base = 26, bSpan = 52): {
  tenkan: Line; kijun: Line; spanA: Line; spanB: Line;
} {
  const hl = (period: number, i: number) => {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period && i - j >= 0; j++) { hh = Math.max(hh, bars[i - j].high); ll = Math.min(ll, bars[i - j].low); }
    return (hh + ll) / 2;
  };
  const tenkan: Line = [], kijun: Line = [], spanA: Line = [], spanB: Line = [];
  for (let i = 0; i < bars.length; i++) {
    if (i >= conv - 1) tenkan.push({ time: bars[i].time, value: r8(hl(conv, i)) });
    if (i >= base - 1) kijun.push({ time: bars[i].time, value: r8(hl(base, i)) });
    if (i >= conv - 1 && i >= base - 1) {
      const t = bars[Math.min(bars.length - 1, i + base)].time;
      spanA.push({ time: t, value: r8((tenkan[tenkan.length - 1].value + kijun[kijun.length - 1].value) / 2) });
    }
    if (i >= bSpan - 1) {
      const t = bars[Math.min(bars.length - 1, i + base)].time;
      spanB.push({ time: t, value: r8(hl(bSpan, i)) });
    }
  }
  return { tenkan, kijun, spanA, spanB };
}

export function aroon(bars: Bar[], period = 14): { up: Line; down: Line } {
  const up: Line = [], down: Line = [];
  for (let i = period; i < bars.length; i++) {
    let hi = i, lo = i;
    for (let j = 0; j <= period; j++) {
      if (bars[i - j].high >= bars[hi].high) hi = i - j;
      if (bars[i - j].low <= bars[lo].low) lo = i - j;
    }
    up.push({ time: bars[i].time, value: r8(((period - (i - hi)) / period) * 100) });
    down.push({ time: bars[i].time, value: r8(((period - (i - lo)) / period) * 100) });
  }
  return { up, down };
}

// ---- Volatility ------------------------------------------------------------

function atrValues(bars: Bar[], period: number): (number | null)[] {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const sm = smooth(trs, period);
  const out: (number | null)[] = [null];
  for (let i = 0; i < bars.length - 1; i++) out.push(sm[i] ?? null);
  return out;
}

export function atr(bars: Bar[], period = 14): Line {
  const vals = atrValues(bars, period);
  const out: Line = [];
  for (let i = 0; i < bars.length; i++) if (vals[i] != null) out.push({ time: bars[i].time, value: r8(vals[i]!) });
  return out;
}

export function bollinger(bars: Bar[], period = 20, mult = 2): { upper: Line; mid: Line; lower: Line } {
  const mid = sma(bars, period);
  const out: { upper: Line; mid: Line; lower: Line } = { upper: [], mid, lower: [] };
  for (let i = 0; i < mid.length; i++) {
    const bi = i + period - 1;
    let variance = 0;
    for (let j = 0; j < period; j++) variance += (bars[bi - j].close - mid[i].value) ** 2;
    const sd = Math.sqrt(variance / period);
    out.upper.push({ time: mid[i].time, value: r8(mid[i].value + mult * sd) });
    out.lower.push({ time: mid[i].time, value: r8(mid[i].value - mult * sd) });
  }
  return out;
}

export function keltner(bars: Bar[], period = 20, mult = 2): { upper: Line; mid: Line; lower: Line } {
  const mid = ema(bars, period);
  const a = atr(bars, period);
  const offset = mid.length - a.length;
  const upper: Line = [], lower: Line = [];
  for (let i = 0; i < a.length; i++) {
    upper.push({ time: a[i].time, value: r8(mid[i + offset].value + mult * a[i].value) });
    lower.push({ time: a[i].time, value: r8(mid[i + offset].value - mult * a[i].value) });
  }
  return { upper, mid, lower };
}

export function donchian(bars: Bar[], period = 20): { upper: Line; mid: Line; lower: Line } {
  const upper: Line = [], lower: Line = [], mid: Line = [];
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period; j++) { hh = Math.max(hh, bars[i - j].high); ll = Math.min(ll, bars[i - j].low); }
    upper.push({ time: bars[i].time, value: hh });
    lower.push({ time: bars[i].time, value: ll });
    mid.push({ time: bars[i].time, value: r8((hh + ll) / 2) });
  }
  return { upper, mid, lower };
}

// ---- Volume ----------------------------------------------------------------

export function volumeBars(bars: Bar[]): { up: LinePointColor[]; down: LinePointColor[] } {
  const up: LinePointColor[] = [], down: LinePointColor[] = [];
  for (const b of bars) {
    const p = { time: b.time, value: b.volume ?? 0 };
    if (b.close >= b.open) up.push(p); else down.push(p);
  }
  return { up, down };
}
export interface LinePointColor { time: number; value: number; color?: string }

export function obv(bars: Bar[]): Line {
  const out: Line = [];
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) acc += bars[i].close >= bars[i - 1].close ? bars[i].volume ?? 0 : -(bars[i].volume ?? 0);
    out.push({ time: bars[i].time, value: acc });
  }
  return out;
}

export function mfi(bars: Bar[], period = 14): Line {
  const out: Line = [];
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  for (let i = period; i < bars.length; i++) {
    let pos = 0, neg = 0;
    for (let j = 0; j < period; j++) {
      const k = i - j;
      const flow = tp[k] * (bars[k].volume ?? 0);
      if (tp[k] >= tp[k - 1]) pos += flow; else neg += flow;
    }
    out.push({ time: bars[i].time, value: pos + neg === 0 ? 50 : r8(100 - 100 / (1 + pos / neg)) });
  }
  return out;
}

export function vwap(bars: Bar[]): Line {
  const out: Line = [];
  let pv = 0, vv = 0, day = -1;
  for (const b of bars) {
    const d = new Date(b.time * 1000).getUTCDate();
    if (d !== day) { day = d; pv = 0; vv = 0; }
    const v = b.volume ?? 0;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vv += v;
    out.push({ time: b.time, value: vv ? r8(pv / vv) : b.close });
  }
  return out;
}

// ---- Volume profile (server data permitting) --------------------------------

export function volumeProfile(bars: Bar[], bins = 24): { price: number; volume: number; max: number }[] {
  if (!bars.length) return [];
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
  const step = (hi - lo) / bins || 1;
  const rows = Array.from({ length: bins }, (_, i) => ({ price: lo + step * (i + 0.5), volume: 0 }));
  for (const b of bars) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((b.high + b.low + b.close) / 3 - lo) / step)));
    rows[idx].volume += b.volume ?? 0;
  }
  const max = Math.max(...rows.map((r) => r.volume), 1);
  return rows.map((r) => ({ ...r, max }));
}

// ---- Registry ---------------------------------------------------------------

export interface IndicatorDef {
  id: string;
  label: string;
  group: "MA" | "Momentum" | "Trend" | "Volatility" | "Volume";
  /** "pane" = separate sub-panel, "overlay" = drawn on the price chart */
  placement: "overlay" | "pane";
  /** number of series the indicator produces */
  series: number;
  defaults: Record<string, number>;
  compute: (bars: Bar[], params: Record<string, number>) => NamedLine[];
}

export interface NamedLine { key: string; label: string; data: Line; kind?: "histogram" | "line"; color?: string }

const D = (id: string, label: string, group: IndicatorDef["group"], placement: IndicatorDef["placement"], series: number, defaults: Record<string, number>, compute: IndicatorDef["compute"]): IndicatorDef =>
  ({ id, label, group, placement, series, defaults, compute });

export const INDICATORS: IndicatorDef[] = [
  D("sma", "SMA", "MA", "overlay", 1, { period: 20 }, (b, p) => [{ key: "sma", label: `SMA ${p.period}`, data: sma(b, p.period) }]),
  D("ema", "EMA", "MA", "overlay", 1, { period: 20 }, (b, p) => [{ key: "ema", label: `EMA ${p.period}`, data: ema(b, p.period) }]),
  D("wma", "WMA", "MA", "overlay", 1, { period: 20 }, (b, p) => [{ key: "wma", label: `WMA ${p.period}`, data: wma(b, p.period) }]),
  D("vwma", "VWMA", "MA", "overlay", 1, { period: 20 }, (b, p) => [{ key: "vwma", label: `VWMA ${p.period}`, data: vwma(b, p.period) }]),
  D("hma", "HMA", "MA", "overlay", 1, { period: 21 }, (b, p) => [{ key: "hma", label: `HMA ${p.period}`, data: hma(b, p.period) }]),
  D("bb", "Bollinger Bands", "Volatility", "overlay", 3, { period: 20, mult: 2 }, (b, p) => {
    const r = bollinger(b, p.period, p.mult);
    return [
      { key: "upper", label: "BB Upper", data: r.upper },
      { key: "mid", label: "BB Mid", data: r.mid },
      { key: "lower", label: "BB Lower", data: r.lower },
    ];
  }),
  D("keltner", "Keltner Channels", "Volatility", "overlay", 3, { period: 20, mult: 2 }, (b, p) => {
    const r = keltner(b, p.period, p.mult);
    return [
      { key: "upper", label: "KC Upper", data: r.upper },
      { key: "mid", label: "KC Mid", data: r.mid },
      { key: "lower", label: "KC Lower", data: r.lower },
    ];
  }),
  D("donchian", "Donchian Channels", "Volatility", "overlay", 3, { period: 20 }, (b, p) => {
    const r = donchian(b, p.period);
    return [
      { key: "upper", label: "DC Upper", data: r.upper },
      { key: "mid", label: "DC Mid", data: r.mid },
      { key: "lower", label: "DC Lower", data: r.lower },
    ];
  }),
  D("supertrend", "Supertrend", "Trend", "overlay", 1, { period: 10, mult: 3 }, (b, p) => [{ key: "st", label: `Supertrend ${p.period}/${p.mult}`, data: supertrend(b, p.period, p.mult).line }]),
  D("psar", "Parabolic SAR", "Trend", "overlay", 1, { step: 0.02, max: 0.2 }, (b, p) => [{ key: "psar", label: "PSAR", data: parabolicSar(b, p.step, p.max) }]),
  D("ichimoku", "Ichimoku Cloud", "Trend", "overlay", 4, { conv: 9, base: 26, spanB: 52 }, (b, p) => {
    const r = ichimoku(b, p.conv, p.base, p.spanB);
    return [
      { key: "tenkan", label: "Tenkan", data: r.tenkan },
      { key: "kijun", label: "Kijun", data: r.kijun },
      { key: "spanA", label: "Span A", data: r.spanA },
      { key: "spanB", label: "Span B", data: r.spanB },
    ];
  }),
  D("vwap", "VWAP", "Volume", "overlay", 1, {}, (b) => [{ key: "vwap", label: "VWAP", data: vwap(b) }]),

  D("rsi", "RSI", "Momentum", "pane", 1, { period: 14 }, (b, p) => [{ key: "rsi", label: `RSI ${p.period}`, data: rsi(b, p.period) }]),
  D("macd", "MACD", "Momentum", "pane", 3, { fast: 12, slow: 26, signal: 9 }, (b, p) => {
    const r = macd(b, p.fast, p.slow, p.signal);
    return [
      { key: "hist", label: "Hist", data: r.hist, kind: "histogram" },
      { key: "macd", label: "MACD", data: r.macd },
      { key: "signal", label: "Signal", data: r.signal },
    ];
  }),
  D("stoch", "Stochastic", "Momentum", "pane", 2, { k: 14, d: 3 }, (b, p) => {
    const r = stochastic(b, p.k, p.d);
    return [
      { key: "k", label: `%K ${p.k}`, data: r.k },
      { key: "d", label: `%D ${p.d}`, data: r.d },
    ];
  }),
  D("cci", "CCI", "Momentum", "pane", 1, { period: 20 }, (b, p) => [{ key: "cci", label: `CCI ${p.period}`, data: cci(b, p.period) }]),
  D("willr", "Williams %R", "Momentum", "pane", 1, { period: 14 }, (b, p) => [{ key: "willr", label: `%R ${p.period}`, data: williamsR(b, p.period) }]),
  D("mom", "Momentum", "Momentum", "pane", 1, { period: 10 }, (b, p) => [{ key: "mom", label: `Mom ${p.period}`, data: momentum(b, p.period) }]),
  D("roc", "ROC", "Momentum", "pane", 1, { period: 12 }, (b, p) => [{ key: "roc", label: `ROC ${p.period}`, data: roc(b, p.period) }]),

  D("adx", "ADX", "Trend", "pane", 3, { period: 14 }, (b, p) => {
    const r = adx(b, p.period);
    return [
      { key: "adx", label: `ADX ${p.period}`, data: r.adx },
      { key: "pdi", label: "+DI", data: r.plusDI },
      { key: "mdi", label: "-DI", data: r.minusDI },
    ];
  }),
  D("aroon", "Aroon", "Trend", "pane", 2, { period: 14 }, (b, p) => {
    const r = aroon(b, p.period);
    return [
      { key: "up", label: "Aroon Up", data: r.up },
      { key: "down", label: "Aroon Down", data: r.down },
    ];
  }),

  D("atr", "ATR", "Volatility", "pane", 1, { period: 14 }, (b, p) => [{ key: "atr", label: `ATR ${p.period}`, data: atr(b, p.period) }]),

  D("vol", "Volume", "Volume", "pane", 1, {}, (b) => {
    const r = volumeBars(b);
    return [{ key: "vol", label: "Volume", data: r.up.concat(r.down).sort((x, y) => x.time - y.time), kind: "histogram" }];
  }),
  D("obv", "OBV", "Volume", "pane", 1, {}, (b) => [{ key: "obv", label: "OBV", data: obv(b) }]),
  D("mfi", "MFI", "Volume", "pane", 1, { period: 14 }, (b, p) => [{ key: "mfi", label: `MFI ${p.period}`, data: mfi(b, p.period) }]),
];

export function getIndicator(id: string): IndicatorDef | undefined {
  return INDICATORS.find((i) => i.id === id);
}
