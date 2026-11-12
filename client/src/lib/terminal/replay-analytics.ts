/**
 * Replay performance analytics — §9 dashboard math over the engine's closed
 * trade list. Pure functions: stats, equity/balance/drawdown curves, monthly
 * + daily breakdowns, a trading calendar and CSV export.
 */
import type { ReplayClosedTrade, ReplayAccountConfig } from "./replay-engine";

export interface ReplayStats {
  startingBalance: number;
  endingBalance: number;
  netProfit: number;
  netProfitPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgRR: number;
  largestWin: number;
  largestLoss: number;
  avgDurationMin: number;
  longs: number;
  shorts: number;
  longWins: number;
  shortWins: number;
  longNet: number;
  shortNet: number;
  totalFees: number;
}

export function computeReplayStats(closed: ReplayClosedTrade[], cfg: ReplayAccountConfig, currentBalance?: number): ReplayStats {
  const endingBalance = currentBalance ?? cfg.startingBalance + closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netProfit = endingBalance - cfg.startingBalance;

  // equity curve → max drawdown
  let eq = cfg.startingBalance, peak = eq, maxDD = 0;
  for (const t of closed) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const rrs = closed.map((t) => t.rrAtEntry).filter((x): x is number => x != null);
  const durations = closed.map((t) => Math.max(0, t.exitTime - t.entryTime) / 60000);
  const longs = closed.filter((t) => t.side === "buy");
  const shorts = closed.filter((t) => t.side === "sell");

  return {
    startingBalance: cfg.startingBalance,
    endingBalance: Math.round(endingBalance * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    netProfitPct: Math.round((netProfit / cfg.startingBalance) * 10000) / 100,
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 99 : 0,
    avgWin: wins.length ? Math.round((grossWin / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownPct: Math.round((maxDD / Math.max(peak, 1)) * 10000) / 100,
    avgRR: rrs.length ? Math.round((rrs.reduce((s, x) => s + x, 0) / rrs.length) * 100) / 100 : 0,
    largestWin: wins.length ? Math.round(Math.max(...wins.map((t) => t.pnl)) * 100) / 100 : 0,
    largestLoss: losses.length ? Math.round(Math.min(...losses.map((t) => t.pnl)) * 100) / 100 : 0,
    avgDurationMin: durations.length ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length) : 0,
    longs: longs.length,
    shorts: shorts.length,
    longWins: longs.filter((t) => t.pnl > 0).length,
    shortWins: shorts.filter((t) => t.pnl > 0).length,
    longNet: Math.round(longs.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
    shortNet: Math.round(shorts.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
    totalFees: Math.round(closed.reduce((s, t) => s + t.fees, 0) * 100) / 100,
  };
}

/** Balance curve after each closed trade + running drawdown. */
export function replayCurves(closed: ReplayClosedTrade[], cfg: ReplayAccountConfig): {
  equity: { t: number; v: number }[];
  drawdown: { t: number; dd: number }[];
} {
  let eq = cfg.startingBalance, peak = eq;
  const equity: { t: number; v: number }[] = [];
  const drawdown: { t: number; dd: number }[] = [];
  for (const t of closed) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    equity.push({ t: t.exitTime, v: Math.round(eq * 100) / 100 });
    drawdown.push({ t: t.exitTime, dd: Math.round((peak - eq) * 100) / 100 });
  }
  return { equity, drawdown };
}

/** Monthly and daily P/L aggregations by EXIT time (UTC). */
export function replayPeriods(closed: ReplayClosedTrade[]): {
  monthly: { month: string; pnl: number; trades: number; winRate: number }[];
  daily: { day: string; pnl: number; trades: number }[];
} {
  const mMap = new Map<string, { pnl: number; trades: number; wins: number }>();
  const dMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of closed) {
    const d = new Date(t.exitTime * 1000).toISOString();
    const day = d.slice(0, 10);
    const month = d.slice(0, 7);
    const m = mMap.get(month) ?? { pnl: 0, trades: 0, wins: 0 };
    m.pnl += t.pnl; m.trades++; if (t.pnl > 0) m.wins++;
    mMap.set(month, m);
    const dd = dMap.get(day) ?? { pnl: 0, trades: 0 };
    dd.pnl += t.pnl; dd.trades++;
    dMap.set(day, dd);
  }
  return {
    monthly: [...mMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, pnl: Math.round(m.pnl * 100) / 100, trades: m.trades, winRate: m.trades ? Math.round((m.wins / m.trades) * 1000) / 10 : 0 })),
    daily: [...dMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, m]) => ({ day, pnl: Math.round(m.pnl * 100) / 100, trades: m.trades })),
  };
}

/** Trading calendar: map "YYYY-MM-DD" → daily P/L for a month grid. */
export function replayCalendar(closed: ReplayClosedTrade[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of closed) {
    const day = new Date(t.exitTime * 1000).toISOString().slice(0, 10);
    out[day] = Math.round(((out[day] ?? 0) + t.pnl) * 100) / 100;
  }
  return out;
}

/** CSV export (§9) — one row per closed trade + a stats header. */
export function replayCsv(closed: ReplayClosedTrade[], stats: ReplayStats, sessionName: string): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push(`# InspireTrade REPLAY (SIMULATED) — ${esc(sessionName)}`);
  lines.push(`# net profit,${stats.netProfit},win rate %,${stats.winRate},profit factor,${stats.profitFactor},max drawdown,${stats.maxDrawdown}`);
  lines.push("id,symbol,side,lots,entry,exit,entry_time,exit_time,pips,pnl,fees,reason,rr_at_entry,journaled");
  for (const t of closed) {
    lines.push([
      t.id, t.symbol, t.side, t.lots, t.entry, t.exit,
      new Date(t.entryTime * 1000).toISOString(), new Date(t.exitTime * 1000).toISOString(),
      t.pips, t.pnl, t.fees, t.reason + (t.slConservative ? "(conservative)" : ""),
      t.rrAtEntry ?? "", t.journalId ? "yes" : "no",
    ].join(","));
  }
  return lines.join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
