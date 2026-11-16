/**
 * Indicator catalog — what the chart can attach, with typed parameters and
 * defaults. Pure config (no chart code) so dialogs, persistence and the
 * chart itself share one source of truth.
 */
import type { BarLike } from "@/lib/indicators";

export type IndicatorType =
  | "sma" | "ema" | "bb" | "vwap" | "volume"   // overlays on the main pane
  | "rsi" | "macd" | "stoch" | "atr";          // sub-panes

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
  const periodKeys: Partial<Record<string, string>> = { sma: "period", ema: "period", bb: "period", rsi: "period", atr: "period" };
  const pk = periodKeys[cfg.type];
  if (pk) return `${meta.label} ${cfg.params[pk]}`;
  if (cfg.type === "macd") return `${meta.label} ${cfg.params.fast}/${cfg.params.slow}/${cfg.params.signal}`;
  if (cfg.type === "stoch") return `${meta.label} ${cfg.params.kPeriod}/${cfg.params.dPeriod}`;
  return meta.label;
}

// Re-export for convenience in chart code
export type { BarLike };
