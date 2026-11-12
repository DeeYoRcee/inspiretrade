/**
 * PropAnalyticsPanel — Prop-firm style analytics over the user's ACTUAL
 * terminal trade history (RTDB terminalDemo/{uid}/positions). This source is
 * strictly the demo-execution account; verified challenge trades (if a real
 * broker adapter is ever enabled) live in a separate node and are never
 * mixed. Metrics: equity & drawdown curves, daily P/L, risk per trade,
 * consistency score, best session/instrument, holding time, weekday stats
 * and trading frequency.
 */
import { useMemo } from "react";
import { useTerminalTrading } from "@/hooks/use-terminal-trading";
import { computePropAnalytics } from "@/lib/terminal/prop-analytics";
import { Stat, Sparkline } from "./ToolDrawer";
import { cn } from "@/lib/utils";

export function PropAnalyticsPanel({ className }: { className?: string }) {
  const { account, positions, loading } = useTerminalTrading();

  const analytics = useMemo(
    () => (account && positions.length ? computePropAnalytics(positions, account.startingBalance) : null),
    [account, positions],
  );

  if (loading) return <div className={cn("flex items-center justify-center py-8 text-xs text-muted-foreground", className)}>Loading trade history…</div>;
  if (!analytics) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-1 py-8 text-center text-xs text-muted-foreground", className)}>
        <span>No closed trades yet.</span>
        <span className="text-[10px]">Execute demo trades from the Trade tab — analytics build from your real account history.</span>
      </div>
    );
  }

  const maxDaily = Math.max(...analytics.dailyPnl.map((d) => Math.abs(d.pnl)), 1);
  const maxDD = Math.max(...analytics.drawdown.map((d) => d.dd), 1);

  return (
    <div className={cn("space-y-3 overflow-y-auto p-2.5 text-[11px]", className)}>
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[9px] leading-relaxed text-amber-300">
        Source: <b>DEMO account trade history</b> ({analytics.totalTrades} closed trades). Demo-execution trades are kept fully separate from any verified challenge account.
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Net P/L" value={`${analytics.netProfit >= 0 ? "+" : ""}${analytics.netProfit.toLocaleString()}`} tone={analytics.netProfit >= 0 ? "up" : "down"} />
        <Stat label="Win rate" value={`${analytics.winRate}%`} />
        <Stat label="Profit factor" value={analytics.profitFactor} tone={analytics.profitFactor >= 1 ? "up" : "down"} />
        <Stat label="Max drawdown" value={analytics.maxDrawdown.toLocaleString()} tone="down" />
        <Stat label="Consistency" value={`${analytics.consistencyScore}/100`} tone={analytics.consistencyScore >= 60 ? "up" : "neutral"} />
        <Stat label="Avg hold" value={analytics.avgHoldingMin >= 60 ? `${(analytics.avgHoldingMin / 60).toFixed(1)}h` : `${analytics.avgHoldingMin}m`} />
        <Stat label="Avg risk/trade" value={analytics.riskPerTrade.count ? `${analytics.riskPerTrade.avg.toLocaleString()}` : "n/a"} />
        <Stat label="Best session" value={analytics.bestSession ?? "—"} />
        <Stat label="Best instrument" value={analytics.bestSymbol ?? "—"} />
      </div>

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Equity curve</div>
        <Sparkline points={analytics.equity.map((p) => p.v)} height={90} color={analytics.netProfit >= 0 ? "#22c55e" : "#ef4444"} />
      </section>

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Daily profit / loss</div>
        <div className="flex h-16 items-end gap-0.5">
          {analytics.dailyPnl.slice(-30).map((d) => (
            <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.pnl >= 0 ? "+" : ""}${d.pnl}`}>
              <div className={cn("w-full rounded-sm", d.pnl >= 0 ? "bg-emerald-500/60" : "bg-red-500/60")}
                style={{ height: `${Math.max(2, (Math.abs(d.pnl) / maxDaily) * 60)}px` }} />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Drawdown curve</div>
        <Sparkline points={analytics.drawdown.map((d) => -d.dd)} height={60} color="#ef4444" />
        <div className="text-right text-[9px] text-muted-foreground">peak drawdown {analytics.maxDrawdown.toLocaleString()}</div>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">By session</div>
          {analytics.bySession.map((s) => (
            <div key={s.session} className="flex justify-between py-0.5">
              <span>{s.session} <span className="text-muted-foreground">({s.trades})</span></span>
              <b className={cn("font-number", s.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{s.pnl >= 0 ? "+" : ""}{s.pnl}</b>
            </div>
          ))}
        </section>
        <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">By instrument</div>
          {analytics.bySymbol.slice(0, 5).map((s) => (
            <div key={s.symbol} className="flex justify-between py-0.5">
              <span>{s.symbol} <span className="text-muted-foreground">{s.winRate}%</span></span>
              <b className={cn("font-number", s.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{s.pnl >= 0 ? "+" : ""}{s.pnl}</b>
            </div>
          ))}
        </section>
        <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">By weekday</div>
          {analytics.byWeekday.map((w) => (
            <div key={w.wd} className="flex justify-between py-0.5">
              <span>{w.wd} <span className="text-muted-foreground">({w.trades})</span></span>
              <b className={cn("font-number", w.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{w.pnl >= 0 ? "+" : ""}{w.pnl}</b>
            </div>
          ))}
        </section>
        <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Frequency & risk</div>
          <div className="flex justify-between py-0.5"><span>Trades / week</span><b className="font-number">{analytics.frequency.perWeek}</b></div>
          <div className="flex justify-between py-0.5"><span>Trades / day</span><b className="font-number">{analytics.frequency.perDay}</b></div>
          <div className="flex justify-between py-0.5"><span>Max planned risk</span><b className="font-number">{analytics.riskPerTrade.count ? analytics.riskPerTrade.max.toLocaleString() : "n/a"}</b></div>
          <div className="flex justify-between py-0.5"><span>Trades without SL</span><b className="font-number text-amber-400">{analytics.riskOfRupeeTrades}</b></div>
        </section>
      </div>
      {analytics.riskPerTrade.count === 0 && (
        <p className="text-[9px] text-muted-foreground">Risk-per-trade metrics appear once trades are placed with a stop-loss (the terminal computes planned risk from the SL distance).</p>
      )}
    </div>
  );
}
