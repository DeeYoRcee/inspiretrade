/**
 * alerts-core — PHASE 47 PURE alert-condition math (no Firebase, no browser
 * APIs): price / indicator / drawing evaluators, the trigger gate and the
 * record sanitizer. Unit-tested directly by tests/p47-alerts.test.ts and
 * consumed by lib/trading-alerts (store) + TradingAlertsEngine (runtime).
 */
import { atr, bollinger, ema, macd, rsi, sma } from "./indicators.ts";
import { fibLevelPrice, levelsFor } from "./drawings.ts";
import type { Bar, Timeframe } from "@shared/terminal";
import type { Drawing } from "./drawings.ts";

// ---- model -------------------------------------------------------------------

export type TradingAlertKind = "price" | "dailyHL" | "indicator" | "drawing";
export type TriggerFrequency = "once" | "oncePerBar" | "oncePerBarClose" | "repeat";
export type PriceDirection = "above" | "below";

export interface IndicatorCond {
  /** RSI over/under · MACD cross · EMA/SMA cross · price vs MA · BB band · ATR level */
  ind: "rsi" | "macd" | "emaCross" | "smaCross" | "priceVsMa" | "bb" | "atr";
  /** RSI threshold; ATR level; MA period(s); BB multiplier */
  value?: number;
  period?: number;
  period2?: number;
  /** rsi: "above" | "below" · macd: "bullish" | "bearish" · cross: "golden" | "death" · priceVsMa: "above" | "below" · bb: "upper" | "lower" · atr: "above" | "below" */
  dir?: string;
}

export interface DrawingCond {
  drawingId: string;
  /** which level of the drawing triggers */
  target: "level" | "fib" | "entry" | "sl" | "tp";
  /** fib level index (0..n) when target === "fib" */
  fibIndex?: number;
  dir: "crossAbove" | "crossBelow";
}

export interface TradingAlert {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  kind: TradingAlertKind;
  paused: boolean;
  createdAt: number;
  /** price | dailyHL — the server-evaluated kinds use EXACTLY these fields */
  direction?: PriceDirection;
  price?: number;
  /** indicator | drawing conditions (client-evaluated) */
  indicator?: IndicatorCond;
  drawing?: DrawingCond;
  frequency: TriggerFrequency;
  /** repeat-mode cooldown in minutes (server default 60) */
  cooldownMin?: number;
  /** epoch ms — the alert stops evaluating after this moment */
  expiresAt?: number | null;
  /** optional custom message shown in the notification */
  message?: string;
  createdAtLabel?: string;
  lastTriggeredAt?: number;
  /** last bar open time seen (once-per-bar dedup) */
  lastBarTime?: number;
  /** last evaluated price (cross detection across engine restarts) */
  lastPrice?: number;
  /** triggered ring, max 20 — same shape the server writes */
  history?: { at: number; price: number; detail?: string }[];
  /** client-only marker: fired and auto-paused by the once policy */
  done?: boolean;
}

export interface EvalResult { hit: boolean; price: number; detail: string }

export function blankAlert(symbol: string, timeframe: Timeframe): TradingAlert {
  return {
    id: `ta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    timeframe,
    kind: "price",
    paused: false,
    createdAt: Date.now(),
    direction: "above",
    price: 0,
    frequency: "repeat",
    cooldownMin: 60,
    expiresAt: null,
    createdAtLabel: new Date().toISOString(),
    history: [],
  };
}

/** Validate + clamp an alert before it may reach RTDB (client or copy). */
export function sanitizeAlert(raw: TradingAlert): TradingAlert | null {
  const a: TradingAlert = { ...raw };
  if (!a.id || !a.symbol || typeof a.symbol !== "string") return null;
  if (!["price", "dailyHL", "indicator", "drawing"].includes(a.kind)) return null;
  if (!["once", "oncePerBar", "oncePerBarClose", "repeat"].includes(a.frequency)) a.frequency = "repeat";
  a.paused = !!a.paused;
  if (a.kind === "price") {
    if (!Number.isFinite(a.price) || (a.price as number) <= 0) return null;
    if (a.direction !== "above" && a.direction !== "below") a.direction = "above";
  }
  if (a.kind === "dailyHL" && a.direction !== "above" && a.direction !== "below") a.direction = "above";
  if (a.kind === "indicator" && !a.indicator?.ind) return null;
  if (a.kind === "drawing" && !a.drawing?.drawingId) return null;
  a.cooldownMin = Math.max(1, Math.min(1440, Math.round(Number(a.cooldownMin ?? 60) || 60)));
  if (a.expiresAt != null && !Number.isFinite(a.expiresAt)) a.expiresAt = null;
  a.history = Array.isArray(a.history) ? a.history.slice(-20) : [];
  delete (a as unknown as Record<string, unknown>).createdAtLabel;
  return a;
}

/** price / dailyHL — the server contract; cross uses the previously seen price. */
export function evaluatePriceAlert(a: TradingAlert, price: number, prevPrice?: number | null): EvalResult {
  const target = Number(a.price);
  const detail = `${a.symbol} ${a.direction === "above" ? "crossed above" : "dropped below"} ${target} — now ${price}`;
  if (a.kind === "dailyHL") return { hit: a.direction === "above" ? price >= target : price <= target, price, detail };
  if (a.direction === "above") return { hit: price >= target, price, detail };
  if (a.direction === "below") return { hit: price <= target, price, detail };
  return { hit: false, price, detail };
}

const asNum = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** last non-null value of an indicator series (Point = number | null) */
const lastV = (pts: (number | null)[]): number | null => {
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i] != null) return pts[i] as number;
  return null;
};

/** Indicator conditions on REAL OHLC closes — real math from lib/indicators. */
export function evaluateIndicatorAlert(a: TradingAlert, bars: Bar[]): EvalResult | null {
  const cond = a.indicator;
  if (!cond || bars.length < 5) return null;
  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];
  const period = Math.max(2, Math.round(cond.period ?? 14));
  switch (cond.ind) {
    case "rsi": {
      const v = lastV(rsi(closes, period));
      if (v == null) return null;
      const thr = Number(cond.value ?? 70);
      const hit = cond.dir === "below" ? v <= thr : v >= thr;
      return { hit, price, detail: `RSI(${period}) ${v.toFixed(1)} ${cond.dir === "below" ? "≤" : "≥"} ${thr}` };
    }
    case "macd": {
      const m = macd(closes, 12, 26, 9);
      if (m.macd.length < 2 || m.signal.length < 2) return null;
      const md = asNum(m.macd[m.macd.length - 1]) - asNum(m.signal[m.signal.length - 1]);
      const mdPrev = asNum(m.macd[m.macd.length - 2]) - asNum(m.signal[m.signal.length - 2]);
      const bull = mdPrev <= 0 && md > 0;
      const bear = mdPrev >= 0 && md < 0;
      const hit = cond.dir === "bearish" ? bear : bull;
      return { hit, price, detail: `MACD ${cond.dir === "bearish" ? "bearish" : "bullish"} crossover (${md.toFixed(4)})` };
    }
    case "emaCross": {
      const fast = ema(closes, Math.max(2, cond.period ?? 9));
      const slow = ema(closes, Math.max(3, cond.period2 ?? 21));
      if (fast.length < 2 || slow.length < 2) return null;
      const d1 = asNum(fast[fast.length - 1]) - asNum(slow[slow.length - 1]);
      const d0 = asNum(fast[fast.length - 2]) - asNum(slow[slow.length - 2]);
      const golden = d0 <= 0 && d1 > 0;
      const death = d0 >= 0 && d1 < 0;
      const hit = cond.dir === "death" ? death : golden;
      return { hit, price, detail: `EMA ${cond.dir === "death" ? "death" : "golden"} cross` };
    }
    case "smaCross": {
      const fast = sma(closes, Math.max(2, cond.period ?? 9));
      const slow = sma(closes, Math.max(3, cond.period2 ?? 21));
      if (fast.length < 2 || slow.length < 2) return null;
      const d1 = asNum(fast[fast.length - 1]) - asNum(slow[slow.length - 1]);
      const d0 = asNum(fast[fast.length - 2]) - asNum(slow[slow.length - 2]);
      const golden = d0 <= 0 && d1 > 0;
      const death = d0 >= 0 && d1 < 0;
      const hit = cond.dir === "death" ? death : golden;
      return { hit, price, detail: `SMA ${cond.dir === "death" ? "death" : "golden"} cross` };
    }
    case "priceVsMa": {
      const ma = ema(closes, period);
      const v = lastV(ma);
      if (v == null) return null;
      const hit = cond.dir === "below" ? price <= v : price >= v;
      return { hit, price, detail: `price ${cond.dir === "below" ? "≤" : "≥"} EMA(${period}) ${v.toFixed(4)}` };
    }
    case "bb": {
      const bb = bollinger(closes, period, Number(cond.value ?? 2) || 2);
      const band = cond.dir === "lower" ? lastV(bb.lower) : lastV(bb.upper);
      if (band == null) return null;
      const hit = cond.dir === "lower" ? price <= band : price >= band;
      return { hit, price, detail: `price ${cond.dir === "lower" ? "≤ lower" : "≥ upper"} Bollinger band ${band.toFixed(4)}` };
    }
    case "atr": {
      const v = lastV(atr(bars, period));
      if (v == null) return null;
      const thr = Number(cond.value ?? 0);
      const hit = cond.dir === "below" ? v <= thr : v >= thr;
      return { hit, price, detail: `ATR(${period}) ${v.toFixed(4)} ${cond.dir === "below" ? "≤" : "≥"} ${thr}` };
    }
    default:
      return null;
  }
}

/**
 * Drawing-based alert level at a given time — recomputed from the drawing's
 * STORED points each evaluation, so a moved/edited drawing automatically
 * re-targets the alert and a deleted drawing pauses it (Part 3).
 */
export function drawingLevel(d: Drawing | undefined, cond: DrawingCond, time: number): number | null {
  if (!d || d.points.length === 0) return null;
  const pts = [...d.points].sort((p, q) => p.time - q.time);
  if (d.type === "hline" || cond.target !== "level") {
    // special targets first
    if (cond.target === "fib" && (d.type === "fib-retracement" || d.type === "fib-extension" || d.type === "fib-trend-ext" || d.type === "fib-channel")) {
      const lvls = levelsFor(d);
      const lvl = lvls[Math.max(0, Math.min(lvls.length - 1, Math.round(cond.fibIndex ?? 0)))];
      if (!lvl) return null;
      const p0 = pts[0]?.price ?? 0;
      const p1 = pts[1]?.price ?? p0;
      const p2 = pts[2]?.price ?? p1;
      const kind = d.type === "fib-retracement" ? "retracement" : "extension";
      const price = fibLevelPrice(kind, p0, p1, p2, lvl.ratio, !!(d as { reverse?: boolean }).reverse);
      return Number.isFinite(price) ? price : null;
    }
    if ((cond.target === "entry" || cond.target === "sl" || cond.target === "tp") && (d.type === "long-position" || d.type === "short-position") && d.points.length >= 3) {
      const idx = cond.target === "entry" ? 0 : cond.target === "sl" ? 1 : 2;
      const p = d.points[idx];
      return Number.isFinite(p?.price) ? p.price : null;
    }
  }
  switch (d.type) {
    case "hline":
      return d.points[0]?.price ?? null;
    case "trend":
    case "ray":
    case "extended": {
      if (pts.length < 2) return pts[0]?.price ?? null;
      const a = pts[0], b = pts[pts.length - 1];
      if (b.time === a.time) return b.price;
      const k = (b.price - a.price) / (b.time - a.time);
      return a.price + k * (time - a.time);
    }
    case "channel": {
      // channel boundary = the base line shifted by the parallel leg's offset
      if (pts.length < 3) return pts[0]?.price ?? null;
      const a = pts[0], b = pts[1], c = pts[2];
      if (b.time === a.time) return c.price;
      const k = (b.price - a.price) / (b.time - a.time);
      const offset = c.price - (a.price + k * (c.time - a.time));
      return a.price + k * (time - a.time) + offset;
    }
    default: {
      // any single-point anchored drawing (vline, text, position fallbacks)
      if (pts.length === 1) return pts[0].price ?? null;
      if (pts.length >= 2) {
        const a = pts[0], b = pts[pts.length - 1];
        if (b.time === a.time) return b.price;
        const k = (b.price - a.price) / (b.time - a.time);
        return a.price + k * (time - a.time);
      }
      return null;
    }
  }
}

export function evaluateDrawingAlert(a: TradingAlert, drawing: Drawing | undefined, price: number, prevPrice: number | null | undefined, time: number): EvalResult | null {
  const cond = a.drawing;
  if (!cond) return null;
  const level = drawingLevel(drawing, cond, time);
  if (level == null || !Number.isFinite(level)) return null;
  const detail = `${a.symbol} price ${price} ${cond.dir === "crossAbove" ? "crossed above" : "crossed below"} drawing level ${level}`;
  // a CROSS needs the previous price: on the very first evaluation we only
  // arm the side the price is already on (no false fire at creation)
  if (prevPrice == null) return { hit: false, price, detail: "armed" };
  const crossed = cond.dir === "crossAbove" ? prevPrice < level && price >= level : prevPrice > level && price <= level;
  return { hit: crossed, price, detail };
}

// ---- trigger policy (Part 7 reliability) --------------------------------------

export interface TriggerGateInput {
  a: TradingAlert;
  now?: number;
  /** open time of the bar the condition fired on (client clocks the bar) */
  barTime?: number | null;
  /** true when the evaluation runs on a bar CLOSE event */
  barClose?: boolean;
}

export interface TriggerGateResult { allowed: boolean; reason: string }

/**
 * Decide whether a detected condition may actually fire, honoring expiration,
 * pause, trigger frequency and cooldown. Pure — unit-tested.
 */
export function triggerGate({ a, now = Date.now(), barTime = null, barClose = false }: TriggerGateInput): TriggerGateResult {
  if (a.paused || a.done) return { allowed: false, reason: "paused" };
  if (a.expiresAt != null && now > a.expiresAt) return { allowed: false, reason: "expired" };
  if (a.frequency === "oncePerBarClose" && !barClose) return { allowed: false, reason: "wait-bar-close" };
  const last = a.lastTriggeredAt ?? 0;
  if (a.frequency === "oncePerBar" || a.frequency === "oncePerBarClose") {
    if (a.lastBarTime != null && barTime != null && a.lastBarTime === barTime) return { allowed: false, reason: "already-fired-this-bar" };
    return { allowed: true, reason: "ok" };
  }
  if (a.frequency === "once") {
    if (last > 0) return { allowed: false, reason: "already-fired" };
    return { allowed: true, reason: "ok" };
  }
  const cd = Math.max(1, Math.round(a.cooldownMin ?? 60)) * 60000;
  // lastTriggeredAt === 0 means "never fired" — the cooldown only applies
  // after an actual trigger (the server cron keeps the same semantics)
  if (last > 0 && now - last < cd) return { allowed: false, reason: "cooldown" };
  return { allowed: true, reason: "ok" };
}

/** A drawing the alert depends on disappeared → pause it (Part 3). */
export function alertDrawingMissing(a: TradingAlert, drawings: Drawing[]): boolean {
  return a.kind === "drawing" && !!a.drawing && !drawings.some((d) => d.id === a.drawing!.drawingId);
}

/** Hard cap per user — abuse protection mirror of the server-side cap. */
export const MAX_ALERTS_PER_USER = 60;
