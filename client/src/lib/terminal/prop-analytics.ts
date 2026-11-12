/**
 * Prop Firm trading analytics — computed from the ACTUAL demo-account trade
 * history stored in RTDB (`terminalDemo/{uid}/positions`). Demo-execution
 * trades and any future verified challenge trades live in DIFFERENT RTDB
 * nodes and are NEVER mixed: every function here takes an explicit trades
 * array and the UI labels the source ("DEMO account history").
 */
import type { DemoPosition } from "@/hooks/use-terminal-trading";
import { getInstrument } from "@shared/terminal";
import { SESSIONS, wallTime } from "./sessions";

export interface PropAnalytics {
  trades: DemoPosition[];
  totalTrades: number;
  netProfit: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  avgHoldingMin: number;
  equity: { t: number; v: number }[];
  dailyPnl: { day: string; pnl: number }[];
  drawdown: { t: number; dd: number }[];
  maxDrawdown: number;
  riskPerTrade: { avg: number; max: number; count: number }; // USD, where SL recorded
  consistencyScore: number; // 0..100
  bySession: { session: string; pnl: number; trades: number }[];
  bestSession: string | null;
  bySymbol: { symbol: string; pnl: number; trades: number; winRate: number }[];
  bestSymbol: string | null;
  byWeekday: { wd: string; pnl: number; trades: number }[];
  frequency: { perWeek: number; perDay: number };
  riskOfRupeeTrades: number; // trades without SL (unmeasured risk)
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function computePropAnalytics(positions: DemoPosition[], startingBalance: number): PropAnalytics | null {
  const trades = positions
    .filter((p) => p.status === "closed" && typeof p.profit === "number")
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  if (!trades.length) return null;

  const netProfit = trades.reduce((s, t) => s + (t.profit ?? 0), 0);
  const wins = trades.filter((t) => (t.profit ?? 0) > 0);
  const losses = trades.filter((t) => (t.profit ?? 0) <= 0);
  const grossWin = wins.reduce((s, t) => s + (t.profit ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.profit ?? 0), 0));

  // equity curve with running drawdown
  let eq = startingBalance || 100000;
  let peak = eq;
  const equity: { t: number; v: number }[] = [{ t: trades[0].openedAt, v: eq }];
  const drawdown: { t: number; dd: number }[] = [{ t: trades[0].openedAt, dd: 0 }];
  let maxDrawdown = 0;
  for (const t of trades) {
    eq += t.profit ?? 0;
    peak = Math.max(peak, eq);
    const dd = peak - eq;
    maxDrawdown = Math.max(maxDrawdown, dd);
    equity.push({ t: t.closedAt ?? t.openedAt, v: Math.round(eq * 100) / 100 });
    drawdown.push({ t: t.closedAt ?? t.openedAt, dd: Math.round(dd * 100) / 100 });
  }

  // daily P/L by UTC day of close
  const dayMap = new Map<string, number>();
  for (const t of trades) {
    const day = new Date(t.closedAt ?? t.openedAt).toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + (t.profit ?? 0));
  }
  const dailyPnl = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, pnl]) => ({ day, pnl: Math.round(pnl * 100) / 100 }));

  // holding time
  const holding = trades.map((t) => Math.max(0, (t.closedAt ?? t.openedAt) - t.openedAt) / 60000);

  // risk per trade where a stop-loss was set (planned risk at entry)
  const withSl = trades.filter((t) => t.sl != null);
  const risks = withSl.map((t) => {
    const inst = getInstrument(t.symbol);
    return Math.abs(t.entry - (t.sl ?? t.entry)) * t.lots * (inst?.contractSize ?? 1);
  });

  // consistency: 1 − normalized σ of daily P/L (high dispersion → low score)
  const vals = dailyPnl.map((d) => d.pnl);
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length);
  const consistencyScore = Math.round(Math.max(0, Math.min(100, 100 * (1 - sd / (Math.abs(mean) + Math.abs(sd) + 1e-9)))));

  // sessions (by trade open time, local wall clock of each session tz)
  const sessMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const s = SESSIONS.find((x) => {
      const wt = wallTime(t.openedAt / 1000, x.tz);
      return x.open <= x.close ? wt >= x.open && wt < x.close : wt >= x.open || wt < x.close;
    });
    const key = s?.label ?? "Off-session";
    const row = sessMap.get(key) ?? { pnl: 0, trades: 0 };
    row.pnl += t.profit ?? 0; row.trades++;
    sessMap.set(key, row);
  }
  const bySession = [...sessMap.entries()].map(([session, v]) => ({ session, pnl: Math.round(v.pnl * 100) / 100, trades: v.trades })).sort((a, b) => b.pnl - a.pnl);

  // instruments
  const symMap = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const row = symMap.get(t.symbol) ?? { pnl: 0, trades: 0, wins: 0 };
    row.pnl += t.profit ?? 0; row.trades++; if ((t.profit ?? 0) > 0) row.wins++;
    symMap.set(t.symbol, row);
  }
  const bySymbol = [...symMap.entries()].map(([symbol, v]) => ({ symbol, pnl: Math.round(v.pnl * 100) / 100, trades: v.trades, winRate: Math.round((v.wins / v.trades) * 1000) / 10 })).sort((a, b) => b.pnl - a.pnl);

  // weekday
  const wdMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const wd = WEEKDAYS[new Date(t.openedAt).getUTCDay()];
    const row = wdMap.get(wd) ?? { pnl: 0, trades: 0 };
    row.pnl += t.profit ?? 0; row.trades++;
    wdMap.set(wd, row);
  }
  const byWeekday = WEEKDAYS.filter((w) => wdMap.has(w)).map((wd) => ({ wd, pnl: Math.round(wdMap.get(wd)!.pnl * 100) / 100, trades: wdMap.get(wd)!.trades }));

  // frequency
  const days = Math.max(1, (trades[trades.length - 1].closedAt ?? Date.now()) - trades[0].openedAt) / 86400000;
  const spanWeeks = Math.max(1, days / 7);

  return {
    trades, totalTrades: trades.length,
    netProfit: Math.round(netProfit * 100) / 100,
    winRate: Math.round((wins.length / trades.length) * 1000) / 10,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
    avgWin: wins.length ? Math.round((grossWin / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
    avgHoldingMin: Math.round(holding.reduce((s, x) => s + x, 0) / holding.length),
    equity, dailyPnl, drawdown, maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    riskPerTrade: {
      avg: risks.length ? Math.round((risks.reduce((s, x) => s + x, 0) / risks.length) * 100) / 100 : 0,
      max: risks.length ? Math.round(Math.max(...risks) * 100) / 100 : 0,
      count: risks.length,
    },
    consistencyScore,
    bySession,
    bestSession: bySession.length ? bySession[0].session : null,
    bySymbol,
    bestSymbol: bySymbol.length ? bySymbol[0].symbol : null,
    byWeekday,
    frequency: { perWeek: Math.round((trades.length / spanWeeks) * 10) / 10, perDay: Math.round((trades.length / days) * 100) / 100 },
    riskOfRupeeTrades: trades.length - withSl.length,
  };
}
