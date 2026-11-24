/**
 * AnalyticsPage — professional trading statistics over the user's journal
 * (trades/{uid}, Firebase-scoped). Aggregations reuse the shared performance
 * core (performanceStats/equityCurve) so journal, replay and backtest numbers
 * are always computed by the same math.
 */
import { useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, Area, AreaChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, Legend,
} from "recharts";
import { performanceStats, equityCurve, type ClosedTradeLike } from "@shared/replay-engine";
import { useTrades } from "@/hooks/use-trades";

const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekOf = (ms: number) => {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

const SESSIONS: { id: string; label: string; hours: number[] }[] = [
  { id: "asia", label: "Asia (00–07 UTC)", hours: [0, 1, 2, 3, 4, 5, 6] },
  { id: "london", label: "London (07–13 UTC)", hours: [7, 8, 9, 10, 11, 12] },
  { id: "overlap", label: "LDN/NY overlap (13–16 UTC)", hours: [13, 14, 15] },
  { id: "ny", label: "New York (16–21 UTC)", hours: [16, 17, 18, 19, 20] },
  { id: "late", label: "Late (21–24 UTC)", hours: [21, 22, 23] },
];

export default function AnalyticsWorkspace() {
  const { data: trades = [], isLoading } = useTrades();
  const [period, setPeriod] = useState<"all" | "90d" | "30d">("all");

  const closed: ClosedTradeLike[] = useMemo(() => {
    const cutoff = period === "all" ? 0 : Date.now() - (period === "90d" ? 90 : 30) * 86400000;
    return trades
      .map((t) => ({
        symbol: t.instrumentSymbol || t.assetName,
        side: t.type === "SELL" ? ("sell" as const) : ("buy" as const),
        profit: t.profit,
        openedAt: t.timestamp,
        closedAt: t.exitTime ?? t.timestamp,
      }))
      .filter((t) => (t.closedAt ?? 0) >= cutoff)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  }, [trades, period]);

  const stats = useMemo(() => performanceStats(closed), [closed]);
  const curve = useMemo(() => equityCurve(closed, 0), [closed]);

  const curveData = useMemo(() => {
    // cumulative journal P/L starting at 0
    let cum = 0;
    const pts = closed.map((t) => { cum += t.profit ?? 0; return { t: dayOf(t.closedAt ?? 0), pnl: Math.round(cum * 100) / 100 }; });
    const stepN = Math.max(1, Math.floor(pts.length / 900));
    return pts.filter((_, i) => i % stepN === 0 || i === pts.length - 1);
  }, [closed]);

  const drawdownData = useMemo(() => {
    let peak = 0;
    return curveData.map((p) => {
      peak = Math.max(peak, p.pnl);
      return { ...p, dd: Math.round((peak - p.pnl) * 100) / 100 };
    });
  }, [curveData]);

  const daily = useMemo(() => {
    const arr = Object.entries(stats.byDay).map(([day, pnl]) => ({ day: day.slice(5), pnl: Math.round(pnl * 100) / 100 }));
    return arr.slice(-30);
  }, [stats]);

  const weekly = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of closed) {
      const w = weekOf((t.closedAt ?? 0));
      map[w] = Math.round(((map[w] ?? 0) + (t.profit ?? 0)) * 100) / 100;
    }
    return Object.entries(map).slice(-16).map(([w, pnl]) => ({ week: w.slice(5), pnl }));
  }, [closed]);

  const monthly = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of closed) {
      const m = monthOf((t.closedAt ?? 0));
      map[m] = Math.round(((map[m] ?? 0) + (t.profit ?? 0)) * 100) / 100;
    }
    return Object.entries(map).slice(-12).map(([m, pnl]) => ({ month: m, pnl }));
  }, [closed]);

  const bySession = useMemo(() => SESSIONS.map((s) => {
    let pnl = 0, count = 0;
    for (const h of s.hours) {
      if (stats.byHour[h]) { pnl += stats.byHour[h].pnl; count += stats.byHour[h].count; }
    }
    return { session: s.label.split(" (")[0], pnl: Math.round(pnl * 100) / 100, count, full: s.label };
  }), [stats]);

  const bySymbol = useMemo(() => Object.entries(stats.bySymbol)
    .map(([symbol, v]) => ({ symbol, pnl: Math.round(v.pnl * 100) / 100, count: v.count, wins: v.wins }))
    .sort((a, b) => b.pnl - a.pnl), [stats]);

  const hasData = closed.length > 0;

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-sky-400" />
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Analytics</h1>
          <p className="text-xs text-slate-400">Computed from your journal — live terminal and replay trades alike.</p>
        </div>
        <div className="ml-auto flex gap-1">
          {(["all", "90d", "30d"] as const).map((p) => (
            <button
              key={p} onClick={() => setPeriod(p)}
              className={period === p ? "rounded-full bg-sky-600 px-3 py-1 text-xs font-medium text-white" : "rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300"}
            >{p === "all" ? "All time" : `Last ${p.replace("d", "")} days`}</button>
          ))}
        </div>
      </div>

      {isLoading && <div className="py-16 text-center text-sm text-slate-500">Loading your stats…</div>}
      {!isLoading && !hasData && (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-800 text-sm text-slate-500">
          No closed trades yet — trade in the terminal or replay and the journal fills automatically.
        </div>
      )}

      {hasData && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <Metric label="Net P/L" value={`${stats.netProfit >= 0 ? "+" : "−"}$${money(Math.abs(stats.netProfit))}`} good={stats.netProfit >= 0} />
            <Metric label="Win rate" value={`${stats.winRate}%`} />
            <Metric label="Profit factor" value={stats.profitFactor === Infinity ? "∞" : String(stats.profitFactor)} />
            <Metric label="Avg win" value={`$${money(stats.avgWin)}`} good />
            <Metric label="Avg loss" value={`$${money(stats.avgLoss)}`} bad />
            <Metric label="Avg R:R" value={stats.avgRiskReward != null ? String(stats.avgRiskReward) : "—"} />
            <Metric label="Max win streak" value={`${stats.maxConsecutiveWins}`} />
            <Metric label="Max loss streak" value={`${stats.maxConsecutiveLosses}`} />
            <Metric label="Best day" value={stats.bestDay ? `${stats.bestDay.day}: +$${money(stats.bestDay.pnl)}` : "—"} good />
            <Metric label="Worst day" value={stats.worstDay ? `${stats.worstDay.day}: −$${money(Math.abs(stats.worstDay.pnl))}` : "—"} bad />
            <Metric label="Longs" value={`${stats.longs.count} · ${money(stats.longs.pnl)}$`} />
            <Metric label="Shorts" value={`${stats.shorts.count} · ${money(stats.shorts.pnl)}$`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Equity curve (cumulative P/L)">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={curveData}>
                  <CartesianGrid stroke="#1e293b" />
                  <XAxis dataKey="t" tick={{ fill: "#64748b", fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={56} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={tooltipCls} />
                  <Line type="monotone" dataKey="pnl" name="Cumulative P/L" stroke="#38bdf8" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title={`Drawdown ($) · max ${money(curve.maxDrawdownUsd)}$`}>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={drawdownData}>
                  <CartesianGrid stroke="#1e293b" />
                  <XAxis dataKey="t" tick={{ fill: "#64748b", fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={56} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={tooltipCls} />
                  <Area type="monotone" dataKey="dd" name="Drawdown" stroke="#f43f5e" fill="#f43f5e33" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Daily P/L (last 30 active days)">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={daily}>
                  <CartesianGrid stroke="#1e293b" />
                  <XAxis dataKey="day" tick={{ fill: "#64748b", fontSize: 9 }} minTickGap={24} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={56} />
                  <Tooltip contentStyle={tooltipCls} />
                  <Bar dataKey="pnl" name="P/L" fill="#38bdf8" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Weekly P/L">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={weekly}>
                  <CartesianGrid stroke="#1e293b" />
                  <XAxis dataKey="week" tick={{ fill: "#64748b", fontSize: 9 }} minTickGap={16} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={56} />
                  <Tooltip contentStyle={tooltipCls} />
                  <Bar dataKey="pnl" name="P/L" fill="#a78bfa" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Monthly P/L">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={monthly}>
                  <CartesianGrid stroke="#1e293b" />
                  <XAxis dataKey="month" tick={{ fill: "#64748b", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={56} />
                  <Tooltip contentStyle={tooltipCls} />
                  <Bar dataKey="pnl" name="P/L" fill="#34d399" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Performance by session (entry hour, UTC)">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={bySession}>
                  <CartesianGrid stroke="#1e293b" />
                  <XAxis dataKey="session" tick={{ fill: "#64748b", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={56} />
                  <Tooltip contentStyle={tooltipCls} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="pnl" name="P/L" fill="#f59e0b" />
                  <Bar dataKey="count" name="Trades" fill="#64748b" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <div className="mb-2 text-sm font-semibold text-slate-100">Performance by instrument</div>
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left">Instrument</th>
                  <th className="px-2 py-1 text-right">Trades</th>
                  <th className="px-2 py-1 text-right">Wins</th>
                  <th className="px-2 py-1 text-right">Win rate</th>
                  <th className="px-2 py-1 text-right">P/L</th>
                  <th className="px-2 py-1 text-left">Share of net</th>
                </tr>
              </thead>
              <tbody>
                {bySymbol.map((s) => {
                  const share = stats.netProfit !== 0 ? Math.round((s.pnl / Math.abs(stats.netProfit)) * 100) : 0;
                  return (
                    <tr key={s.symbol} className="border-t border-slate-800/60">
                      <td className="px-2 py-1 font-medium text-slate-200">{s.symbol}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-300">{s.count}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-300">{s.wins}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-300">{s.count ? Math.round((s.wins / s.count) * 100) : 0}%</td>
                      <td className={`px-2 py-1 text-right font-semibold tabular-nums ${s.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {s.pnl >= 0 ? "+" : "−"}{money(Math.abs(s.pnl))}
                      </td>
                      <td className="px-2 py-1">
                        <div className="h-1.5 w-full rounded-full bg-slate-800">
                          <div
                            className={s.pnl >= 0 ? "h-full rounded-full bg-emerald-500" : "h-full rounded-full bg-red-500"}
                            style={{ width: `${Math.min(100, Math.abs(share))}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const tooltipCls = { background: "#0f172a", border: "1px solid #334155", fontSize: 12 };

function Metric({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${good ? "text-emerald-400" : bad ? "text-red-400" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="mb-2 text-sm font-semibold text-slate-100">{title}</div>
      {children}
    </div>
  );
}
