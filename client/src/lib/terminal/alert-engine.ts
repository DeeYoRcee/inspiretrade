/**
 * Advanced alert engine — v2 terminal alerts stored in RTDB
 * (`terminalAlerts/{uid}`). Backward compatible with v1 records (plain
 * above/below price alerts). Kinds:
 *   price     — price above/below a level (recurring, cooldown-based)
 *   rsi       — RSI crosses up/down a level
 *   macd      — MACD line crosses signal (up/down)
 *   emaCross  — EMA fast crosses slow (up/down)
 *   bbBreakout— close outside Bollinger band
 *   trendline — price crosses a user-drawn trendline/ray (per symbol)
 *   sr        — price crosses a user-drawn horizontal S/R line
 *   dailyHL   — previous day high/low breakout
 *
 * Evaluation happens client-side on a 30s loop (with cached bars) AND
 * server-side for price/dailyHL kinds via /api/alerts-cron (Vercel cron).
 * Duplicate notifications are prevented with a per-alert cooldown window.
 */
import { rsi as rsiFn, ema as emaFn, macd as macdFn, bollinger as bbFn, type Line } from "./indicators";
import { prevDayHighLow } from "./sessions";
import type { Bar, Timeframe } from "@shared/terminal";
import type { Drawing } from "./drawings";

export type AlertKind = "price" | "rsi" | "macd" | "emaCross" | "bbBreakout" | "trendline" | "sr" | "dailyHL";

export interface TerminalAlertV2 {
  id: string;
  kind?: AlertKind; // undefined = legacy v1 price alert
  symbol: string;
  timeframe?: Timeframe;
  direction: "above" | "below" | "crossUp" | "crossDown";
  price?: number;
  p1?: number; // indicator period / fast
  p2?: number; // level / slow
  drawingId?: string;
  note?: string;
  createdAt: number;
  paused?: boolean;
  triggeredAt?: number;      // legacy one-shot marker (kept for v1 rows)
  lastTriggeredAt?: number;
  cooldownMin?: number;
  history?: { at: number; price?: number; value?: number }[];
}

export interface AlertContext {
  prices: Record<string, number>;
  bars: (symbol: string, tf: Timeframe) => Bar[] | undefined;
  drawings: (symbol: string) => Drawing[];
}

export interface AlertFire { alert: TerminalAlertV2; title: string; value: number }

const lastTwo = (line: Line): [number, number] | null =>
  line.length >= 2 ? [line[line.length - 2].value, line[line.length - 1].value] : null;

/** Value of a trendline (2-point) extended to time t. */
function lineValueAt(d: Drawing, t: number): number | null {
  const [p0, p1] = d.points;
  if (!p0 || !p1) return null;
  if (p1.time === p0.time) return p1.price;
  const k = (p1.price - p0.price) / (p1.time - p0.time);
  return p0.price + k * (t - p0.time);
}

/** Evaluate one alert against the context. Returns a description when it fires. */
export function evaluateAlert(a: TerminalAlertV2, ctx: AlertContext): AlertFire | null {
  if (a.paused) return null;
  const cooldown = (a.cooldownMin ?? 60) * 60_000;
  const last = a.lastTriggeredAt ?? a.triggeredAt ?? 0;
  if (Date.now() - last < cooldown) return null;

  const kind: AlertKind = a.kind ?? "price";
  const price = ctx.prices[a.symbol];
  const bars: Bar[] = (a.timeframe ? ctx.bars(a.symbol, a.timeframe) : undefined) ?? [];

  const fire = (title: string, value: number): AlertFire => ({ alert: a, title, value });

  switch (kind) {
    case "price": {
      if (price == null || a.price == null) return null;
      const hit = a.direction === "above" ? price >= a.price : price <= a.price;
      return hit ? fire(`${a.symbol} ${a.direction === "above" ? "≥" : "≤"} ${a.price}`, price) : null;
    }
    case "dailyHL": {
      if (price == null || !bars.length) return null;
      const hl = prevDayHighLow(bars);
      if (!hl) return null;
      const level = a.direction === "above" ? hl.high : hl.low;
      const hit = a.direction === "above" ? price >= level : price <= level;
      return hit ? fire(`${a.symbol} ${a.direction === "above" ? "broke prev day high" : "broke prev day low"} ${level.toFixed(4)}`, price) : null;
    }
    case "rsi": {
      if (!bars.length) return null;
      const two = lastTwo(rsiFn(bars, a.p1 ?? 14));
      if (!two) return null;
      const lvl = a.p2 ?? 30;
      const hit = a.direction === "crossUp" ? two[0] <= lvl && two[1] > lvl : two[0] >= lvl && two[1] < lvl;
      return hit ? fire(`${a.symbol} RSI${a.p1 ?? 14} ${a.direction === "crossUp" ? "↑" : "↓"} ${lvl} (now ${two[1].toFixed(1)})`, two[1]) : null;
    }
    case "macd": {
      if (!bars.length) return null;
      const r = macdFn(bars);
      const m = lastTwo(r.macd), s = lastTwo(r.signal);
      if (!m || !s) return null;
      const hit = a.direction === "crossUp" ? m[0] <= s[0] && m[1] > s[1] : m[0] >= s[0] && m[1] < s[1];
      return hit ? fire(`${a.symbol} MACD ${a.direction === "crossUp" ? "crossed above" : "crossed below"} signal`, m[1]) : null;
    }
    case "emaCross": {
      if (!bars.length) return null;
      const f = lastTwo(emaFn(bars, a.p1 ?? 9));
      const s = lastTwo(emaFn(bars, a.p2 ?? 21));
      if (!f || !s) return null;
      const hit = a.direction === "crossUp" ? f[0] <= s[0] && f[1] > s[1] : f[0] >= s[0] && f[1] < s[1];
      return hit ? fire(`${a.symbol} EMA${a.p1 ?? 9} ${a.direction === "crossUp" ? "↑" : "↓"} EMA${a.p2 ?? 21}`, f[1]) : null;
    }
    case "bbBreakout": {
      if (!bars.length) return null;
      const b = bbFn(bars, a.p1 ?? 20, a.p2 ?? 2);
      const close = bars[bars.length - 1].close;
      const hit = a.direction === "above" ? close > b.upper[b.upper.length - 1].value : close < b.lower[b.lower.length - 1].value;
      return hit ? fire(`${a.symbol} Bollinger ${a.direction === "above" ? "upper" : "lower"} band breakout (${close.toFixed(4)})`, close) : null;
    }
    case "sr": {
      if (price == null) return null;
      const d = ctx.drawings(a.symbol).find((x) => x.id === a.drawingId && x.tool === "hline" && !x.hidden);
      if (!d) return null;
      const level = d.points[0]?.price;
      if (level == null) return null;
      const hit = a.direction === "above" ? price >= level : price <= level;
      return hit ? fire(`${a.symbol} crossed ${a.direction === "above" ? "above" : "below"} S/R ${level.toFixed(4)}`, price) : null;
    }
    case "trendline": {
      if (price == null || !bars.length) return null;
      const d = ctx.drawings(a.symbol).find((x) => x.id === a.drawingId && ["trendline", "ray", "extline"].includes(x.tool) && !x.hidden);
      if (!d) return null;
      const v = lineValueAt(d, bars[bars.length - 1].time);
      if (v == null) return null;
      const hit = a.direction === "above" ? price >= v : price <= v;
      return hit ? fire(`${a.symbol} ${a.direction === "above" ? "broke above" : "broke below"} trendline @ ${v.toFixed(4)}`, price) : null;
    }
  }
}
