/**
 * Indicator catalog — what the chart can attach, with typed parameters and
 * defaults. Pure config (no chart code) so dialogs, persistence and the
 * chart itself share one source of truth.
 */
import type { BarLike } from "@/lib/indicators";

export type IndicatorType =
  | "sma" | "ema" | "wma" | "hma" | "bb" | "vwap" | "volume"                                   // overlays on the main pane
  | "supertrend" | "donchian" | "keltner" | "psar" | "ichimoku"                                // overlays (multi-line)
  | "rsi" | "macd" | "stoch" | "atr" | "adx" | "willr" | "cci" | "stochrsi"                    // sub-panes
  | "mfi" | "obv" | "trix" | "ao" | "roc";                                                     // sub-panes (cont.)

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  visible: boolean;
  params: Record<string, number | string>;
}

export interface IndicatorParamSpec {
  key: string;
  label: string;
  kind: "number" | "color";
  min?: number;
  max?: number;
  step?: number;
  default: number | string;
}

export interface IndicatorMeta {
  type: IndicatorType;
  label: string;
  /** overlay on the price pane or its own sub-pane */
  pane: "main" | "sub";
  params: IndicatorParamSpec[];
  defaults: Record<string, number | string>;
  /** default series colors keyed per line (basis/upper/lower, k/d, …) */
  colors: string[];
  /** per-KEY color overrides for multi-line overlays (falls back to colors[0]) */
  keyColors?: Record<string, string>;
  /** per-KEY line style for overlays (numeric LineStyle from lightweight-charts) */
  keyStyle?: Record<string, { lineStyle?: number; lineWidth?: 1 | 2 }>;
}

export const INDICATOR_CATALOG: Record<IndicatorType, IndicatorMeta> = {
  sma: {
    type: "sma", label: "Moving Average (SMA)", pane: "main",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 500, step: 1, default: 20 }, { key: "color", label: "Color", kind: "color", default: "#f59e0b" }],
    defaults: { period: 20, color: "#f59e0b" }, colors: ["#f59e0b"],
  },
  ema: {
    type: "ema", label: "Moving Average (EMA)", pane: "main",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 500, step: 1, default: 50 }, { key: "color", label: "Color", kind: "color", default: "#a78bfa" }],
    defaults: { period: 50, color: "#a78bfa" }, colors: ["#a78bfa"],
  },
  bb: {
    type: "bb", label: "Bollinger Bands", pane: "main",
    params: [
      { key: "period", label: "Period", kind: "number", min: 2, max: 200, step: 1, default: 20 },
      { key: "mult", label: "StdDev ×", kind: "number", min: 0.5, max: 6, step: 0.1, default: 2 },
      { key: "color", label: "Color", kind: "color", default: "#38bdf8" },
    ],
    defaults: { period: 20, mult: 2, color: "#38bdf8" }, colors: ["#38bdf8"],
  },
  vwap: {
    type: "vwap", label: "VWAP (session)", pane: "main",
    params: [{ key: "color", label: "Color", kind: "color", default: "#e879f9" }],
    defaults: { color: "#e879f9" }, colors: ["#e879f9"],
  },
  volume: {
    type: "volume", label: "Volume", pane: "main",
    params: [], defaults: {}, colors: [],
  },
  rsi: {
    type: "rsi", label: "RSI", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 100, step: 1, default: 14 }],
    defaults: { period: 14 }, colors: ["#38bdf8"],
  },
  macd: {
    type: "macd", label: "MACD", pane: "sub",
    params: [
      { key: "fast", label: "Fast EMA", kind: "number", min: 2, max: 100, step: 1, default: 12 },
      { key: "slow", label: "Slow EMA", kind: "number", min: 3, max: 200, step: 1, default: 26 },
      { key: "signal", label: "Signal", kind: "number", min: 2, max: 50, step: 1, default: 9 },
    ],
    defaults: { fast: 12, slow: 26, signal: 9 }, colors: ["#38bdf8", "#f59e0b"],
  },
  stoch: {
    type: "stoch", label: "Stochastic", pane: "sub",
    params: [
      { key: "kPeriod", label: "%K length", kind: "number", min: 2, max: 100, step: 1, default: 14 },
      { key: "dPeriod", label: "%D smoothing", kind: "number", min: 1, max: 50, step: 1, default: 3 },
    ],
    defaults: { kPeriod: 14, dPeriod: 3 }, colors: ["#38bdf8", "#f59e0b"],
  },
  atr: {
    type: "atr", label: "ATR", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 100, step: 1, default: 14 }],
    defaults: { period: 14 }, colors: ["#e879f9"],
  },
  // ---- Phase 27: the TradingView-standard set (16 additions) ---------------
  wma: {
    type: "wma", label: "Moving Average (WMA)", pane: "main",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 500, step: 1, default: 20 }, { key: "color", label: "Color", kind: "color", default: "#fbbf24" }],
    defaults: { period: 20, color: "#fbbf24" }, colors: ["#fbbf24"],
  },
  hma: {
    type: "hma", label: "Hull Moving Average", pane: "main",
    params: [{ key: "period", label: "Period", kind: "number", min: 4, max: 500, step: 1, default: 21 }, { key: "color", label: "Color", kind: "color", default: "#34d399" }],
    defaults: { period: 21, color: "#34d399" }, colors: ["#34d399"],
  },
  supertrend: {
    type: "supertrend", label: "SuperTrend", pane: "main",
    params: [
      { key: "period", label: "ATR period", kind: "number", min: 2, max: 100, step: 1, default: 10 },
      { key: "mult", label: "ATR ×", kind: "number", min: 0.5, max: 10, step: 0.1, default: 3 },
    ],
    defaults: { period: 10, mult: 3 }, colors: ["#22c55e"],
    keyColors: { up: "#22c55e", down: "#ef4444" },
  },
  donchian: {
    type: "donchian", label: "Donchian Channel", pane: "main",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 300, step: 1, default: 20 }],
    defaults: { period: 20 }, colors: ["#f97316"],
    keyColors: { upper: "#f97316", basis: "#94a3b8", lower: "#f97316" },
    keyStyle: { basis: { lineWidth: 1, lineStyle: 2 } },
  },
  keltner: {
    type: "keltner", label: "Keltner Channel", pane: "main",
    params: [
      { key: "period", label: "EMA period", kind: "number", min: 2, max: 300, step: 1, default: 20 },
      { key: "mult", label: "ATR ×", kind: "number", min: 0.5, max: 10, step: 0.1, default: 2 },
    ],
    defaults: { period: 20, mult: 2 }, colors: ["#38bdf8"],
    keyColors: { basis: "#38bdf8", upper: "#f59e0b", lower: "#f59e0b" },
  },
  psar: {
    type: "psar", label: "Parabolic SAR", pane: "main",
    params: [
      { key: "step", label: "AF step", kind: "number", min: 0.01, max: 0.1, step: 0.01, default: 0.02 },
      { key: "max", label: "AF max", kind: "number", min: 0.05, max: 0.5, step: 0.01, default: 0.2 },
    ],
    defaults: { step: 0.02, max: 0.2 }, colors: ["#fbbf24"],
    keyStyle: { sar: { lineStyle: 1 } },
  },
  ichimoku: {
    type: "ichimoku", label: "Ichimoku Cloud (unshifted)", pane: "main",
    params: [
      { key: "conv", label: "Tenkan", kind: "number", min: 2, max: 100, step: 1, default: 9 },
      { key: "base", label: "Kijun", kind: "number", min: 2, max: 200, step: 1, default: 26 },
      { key: "span", label: "Senkou B", kind: "number", min: 2, max: 400, step: 1, default: 52 },
    ],
    defaults: { conv: 9, base: 26, span: 52 }, colors: ["#38bdf8"],
    keyColors: { tenkan: "#38bdf8", kijun: "#ef4444", spanA: "#22c55e", spanB: "#a855f7" },
    keyStyle: { spanA: { lineWidth: 1 }, spanB: { lineWidth: 1 } },
  },
  adx: {
    type: "adx", label: "ADX / DMI", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 100, step: 1, default: 14 }],
    defaults: { period: 14 }, colors: ["#e879f9", "#22c55e", "#ef4444"],
  },
  willr: {
    type: "willr", label: "Williams %R", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 100, step: 1, default: 14 }],
    defaults: { period: 14 }, colors: ["#38bdf8"],
  },
  cci: {
    type: "cci", label: "CCI", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 200, step: 1, default: 20 }],
    defaults: { period: 20 }, colors: ["#f59e0b"],
  },
  stochrsi: {
    type: "stochrsi", label: "Stochastic RSI", pane: "sub",
    params: [
      { key: "rsiPeriod", label: "RSI length", kind: "number", min: 2, max: 100, step: 1, default: 14 },
      { key: "stochPeriod", label: "Stoch length", kind: "number", min: 2, max: 100, step: 1, default: 14 },
      { key: "kSmooth", label: "K smooth", kind: "number", min: 1, max: 20, step: 1, default: 3 },
      { key: "dSmooth", label: "D smooth", kind: "number", min: 1, max: 20, step: 1, default: 3 },
    ],
    defaults: { rsiPeriod: 14, stochPeriod: 14, kSmooth: 3, dSmooth: 3 }, colors: ["#38bdf8", "#f59e0b"],
  },
  mfi: {
    type: "mfi", label: "Money Flow Index", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 100, step: 1, default: 14 }],
    defaults: { period: 14 }, colors: ["#22c55e"],
  },
  obv: {
    type: "obv", label: "On-Balance Volume", pane: "sub",
    params: [],
    defaults: {}, colors: ["#38bdf8"],
  },
  trix: {
    type: "trix", label: "TRIX", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 100, step: 1, default: 15 }],
    defaults: { period: 15 }, colors: ["#e879f9"],
  },
  ao: {
    type: "ao", label: "Awesome Oscillator", pane: "sub",
    params: [
      { key: "fast", label: "Fast", kind: "number", min: 2, max: 50, step: 1, default: 5 },
      { key: "slow", label: "Slow", kind: "number", min: 5, max: 200, step: 1, default: 34 },
    ],
    defaults: { fast: 5, slow: 34 }, colors: ["#f59e0b"],
  },
  roc: {
    type: "roc", label: "Rate of Change", pane: "sub",
    params: [{ key: "period", label: "Period", kind: "number", min: 2, max: 200, step: 1, default: 9 }],
    defaults: { period: 9 }, colors: ["#94a3b8"],
  },
};

export function newIndicatorConfig(type: IndicatorType): IndicatorConfig {
  const meta = INDICATOR_CATALOG[type];
  return {
    id: `i${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    type,
    visible: true,
    params: { ...meta.defaults },
  };
}

/** Clamp user-edited params into the catalog's declared ranges. */
export function sanitizeParams(type: IndicatorType, raw: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = { ...INDICATOR_CATALOG[type].defaults };
  for (const spec of INDICATOR_CATALOG[type].params) {
    const v = raw[spec.key];
    if (v == null || v === "") continue;
    if (spec.kind === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[spec.key] = Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
    } else if (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v)) {
      out[spec.key] = v;
    }
  }
  return out;
}

export function indicatorLabel(cfg: IndicatorConfig): string {
  const meta = INDICATOR_CATALOG[cfg.type];
  const periodKeys: Partial<Record<string, string>> = { sma: "period", ema: "period", wma: "period", hma: "period", bb: "period", rsi: "period", atr: "period", adx: "period", willr: "period", cci: "period", mfi: "period", trix: "period", roc: "period", donchian: "period" };
  const pk = periodKeys[cfg.type];
  if (pk) return `${meta.label} ${cfg.params[pk]}`;
  if (cfg.type === "macd") return `${meta.label} ${cfg.params.fast}/${cfg.params.slow}/${cfg.params.signal}`;
  if (cfg.type === "stoch") return `${meta.label} ${cfg.params.kPeriod}/${cfg.params.dPeriod}`;
  if (cfg.type === "supertrend") return `${meta.label} ${cfg.params.period}/${cfg.params.mult}`;
  if (cfg.type === "keltner") return `${meta.label} ${cfg.params.period}/${cfg.params.mult}`;
  if (cfg.type === "ichimoku") return `${meta.label} ${cfg.params.conv}/${cfg.params.base}/${cfg.params.span}`;
  if (cfg.type === "stochrsi") return `${meta.label} ${cfg.params.rsiPeriod}/${cfg.params.stochPeriod}/${cfg.params.kSmooth}/${cfg.params.dSmooth}`;
  if (cfg.type === "ao") return `${meta.label} ${cfg.params.fast}/${cfg.params.slow}`;
  if (cfg.type === "psar") return `${meta.label} ${cfg.params.step}/${cfg.params.max}`;
  return meta.label;
}

// Re-export for convenience in chart code
export type { BarLike };
