/**
 * ReplayStatsPanel — §9 performance dashboard: full stat block, equity /
 * balance / drawdown curves, monthly + daily performance, trading calendar
 * and CSV export. Also hosts the replay challenge report.
 */
import { useMemo } from "react";
import { Download } from "lucide-react";
import { computeReplayStats, replayCurves, replayPeriods, replayCalendar, replayCsv, downloadCsv } from "@/lib/terminal/replay-analytics";
import { Stat, Sparkline } from "./ToolDrawer";
import type { ReplaySession } from "@/hooks/use-replay";
import { cn } from "@/lib/utils";

export function ReplayStatsPanel({ rs, className }: { rs: ReplaySession; className?: string }) {
  const stats = useMemo(() => computeReplayStats(rs.engine.closed, rs.cfg, rs.engine.balance), [rs.engine.closed, rs.cfg, rs.engine.balance]);
  const curves = useMemo(() => replayCurves(rs.engine.closed, rs.cfg), [rs.engine.closed, rs.cfg]);
  const periods = useMemo(() => replayPeriods(rs.engine.closed), [rs.engine.closed]);
  const calendar = useMemo(() => replayCalendar(rs.engine.closed), [rs.engine.closed]);

  // calendar grid for the month of the last trade
  const lastDay = periods.daily.at(-1)?.day;
  const grid = useMemo(() => {
    if (!lastDay) return null;
    const base = new Date(lastDay + "T00:00:00Z");
    const y = base.getUTCFullYear(), m = base.getUTCMonth();
    const first = new Date(Date.UTC(y, m, 1));
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7; // Monday-first
    return { y, m, lead, daysInMonth };
  }, [lastDay]);

  const exportCsv = () => {
    const csv = replayCsv(rs.engine.closed, stats, `${rs.symbol} ${rs.timeframe}`);
    downloadCsv(`inspiretrade-replay-${rs.symbol}-${rs.timeframe}.csv`, csv);
  };

  return (
    <div className={cn("space-y-3 overflow-y-auto p-3 text-[11px]", className)}>
      <div className="flex items-center justify-between">
        <b>Replay performance — {rs.symbol} {rs.timeframe}</b>
        <button onClick={exportCsv} disabled={!rs.engine.closed.length}
          className="flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2 py-1 text-[10px] font-bold text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40">
          <Download className="h-3 w-3" />CSV
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Start balance" value={`$${stats.startingBalance.toLocaleString()}`} />
        <Stat label="End balance" value={`$${stats.endingBalance.toLocaleString()}`} />
        <Stat label="Net profit" value={`${stats.netProfit >= 0 ? "+" : ""}$${stats.netProfit.toLocaleString()} (${stats.netProfitPct}%)`} tone={stats.netProfit >= 0 ? "up" : "down"} />
        <Stat label="Total trades" value={stats.totalTrades} />
        <Stat label="Win rate" value={`${stats.winRate}%`} tone={stats.winRate >= 50 ? "up" : "neutral"} />
        <Stat label="Profit factor" value={stats.profitFactor} tone={stats.profitFactor >= 1 ? "up" : "down"} />
        <Stat label="Wins / Losses" value={`${stats.wins} / ${stats.losses}`} />
        <Stat label="Avg win / loss" value={`$${stats.avgWin} / $${stats.avgLoss}`} />
        <Stat label="Max drawdown" value={`$${stats.maxDrawdown} (${stats.maxDrawdownPct}%)`} tone="down" />
        <Stat label="Avg planned R:R" value={stats.avgRR ? `1:${stats.avgRR}` : "—"} />
        <Stat label="Largest win" value={`+$${stats.largestWin}`} tone="up" />
        <Stat label="Largest loss" value={`-$${Math.abs(stats.largestLoss)}`} tone="down" />
        <Stat label="Avg duration" value={stats.avgDurationMin >= 60 ? `${(stats.avgDurationMin / 60).toFixed(1)}h` : `${stats.avgDurationMin}m`} />
        <Stat label="Long" value={`${stats.longs} trades · ${stats.longs ? Math.round((stats.longWins / stats.longs) * 1000) / 10 : 0}% · $${stats.longNet}`} />
        <Stat label="Short" value={`${stats.shorts} trades · ${stats.shorts ? Math.round((stats.shortWins / stats.shorts) * 1000) / 10 : 0}% · $${stats.shortNet}`} />
      </div>

      {rs.challenge && <ChallengeReport rs={rs} />}

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Equity curve</div>
        <Sparkline points={[stats.startingBalance, ...curves.equity.map((p) => p.v)]} height={90} color={stats.netProfit >= 0 ? "#22c55e" : "#ef4444"} />
        <div className="mt-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Drawdown</div>
        <Sparkline points={curves.drawdown.map((p) => -p.dd)} height={60} color="#ef4444" />
      </section>

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Monthly performance</div>
        {!periods.monthly.length && <div className="text-muted-foreground">No trades yet.</div>}
        <table className="w-full text-[10px]">
          <tbody className="font-number">
            {periods.monthly.map((m) => (
              <tr key={m.month} className="border-t border-border/30">
                <td>{m.month}</td><td className="text-right text-muted-foreground">{m.trades} trades</td>
                <td className="text-right text-muted-foreground">{m.winRate}%</td>
                <td className={cn("text-right", m.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{m.pnl >= 0 ? "+" : ""}{m.pnl}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Daily performance</div>
        <div className="flex h-14 items-end gap-0.5">
          {periods.daily.slice(-24).map((d) => (
            <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.pnl >= 0 ? "+" : ""}${d.pnl} (${d.trades})`}>
              <div className={cn("w-full rounded-sm", d.pnl >= 0 ? "bg-emerald-500/60" : "bg-red-500/60")}
                style={{ height: `${Math.max(2, Math.min(56, Math.abs(d.pnl) / Math.max(1, ...periods.daily.map((x) => Math.abs(x.pnl))) * 56))}px` }} />
            </div>
          ))}
          {!periods.daily.length && <div className="w-full text-center text-muted-foreground">No trades yet.</div>}
        </div>
      </section>

      {grid && (
        <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Trading calendar ({new Date(Date.UTC(grid.y, grid.m, 1)).toLocaleDateString([], { month: "long", year: "numeric" })})</div>
          <div className="grid grid-cols-7 gap-1 text-center text-[9px]">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i} className="text-muted-foreground">{d}</div>)}
            {Array.from({ length: grid.lead }, (_, i) => <div key={`l${i}`} />)}
            {Array.from({ length: grid.daysInMonth }, (_, i) => {
              const day = `${grid.y}-${String(grid.m + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
              const pnl = calendar[day];
              return (
                <div key={day} className={cn("rounded py-1 font-number",
                  pnl == null ? "bg-muted/20 text-muted-foreground" : pnl >= 0 ? "bg-emerald-500/25 text-emerald-300" : "bg-red-500/25 text-red-300")}
                  title={pnl != null ? `${day}: ${pnl >= 0 ? "+" : ""}${pnl}` : day}>
                  {i + 1}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function ChallengeReport({ rs }: { rs: ReplaySession }) {
  const ch = rs.challenge!;
  const retPct = ((rs.equity - ch.startBalance) / ch.startBalance) * 100;
  const ddPct = Math.max(0, ...[0]);
  void ddPct;
  return (
    <section className={cn("rounded-xl border p-2.5", ch.status === "passed" ? "border-emerald-500/40 bg-emerald-500/10" : ch.status === "failed" ? "border-red-500/40 bg-red-500/10" : "border-border/50 bg-card/40")}>
      <div className="flex items-center justify-between">
        <b>Replay Challenge</b>
        <span className={cn("rounded px-2 py-0.5 text-[10px] font-black uppercase", ch.status === "passed" ? "bg-emerald-500/25 text-emerald-300" : ch.status === "failed" ? "bg-red-500/25 text-red-300" : "bg-muted text-muted-foreground")}>{ch.status}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        <Stat label="Target" value={`+${ch.targetPct}%`} />
        <Stat label="Now" value={`${retPct >= 0 ? "+" : ""}${retPct.toFixed(1)}%`} tone={retPct >= 0 ? "up" : "down"} />
        <Stat label="Max DD rule" value={`${ch.maxDdPct}%`} />
        <Stat label="Min days" value={ch.minDays} />
      </div>
      {ch.failReason && <p className="mt-1 text-[10px] text-red-300">{ch.failReason}</p>}
      <p className="mt-1 text-[9px] text-muted-foreground">Training simulator only — fully separate from real Prop Firm challenges.</p>
    </section>
  );
}
