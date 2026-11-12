/**
 * StrategyTester — backtesting environment over REAL historical bars.
 * Configurable entry/exit rule sets, SL/TP, risk sizing, commission and
 * spread; results include the full stat block, equity curve, monthly table,
 * long-vs-short split and the complete trade history. All computation runs
 * through lib/terminal/backtest.ts (no look-ahead, pessimistic SL priority).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Plus, Trash2 } from "lucide-react";
import { INSTRUMENTS, TIMEFRAMES, type Bar, type Timeframe } from "@shared/terminal";
import { loadBarsCached } from "@/lib/terminal/data-feeds";
import { RULE_CATALOG, runBacktest, DEFAULT_BACKTEST, type BacktestConfig, type BacktestResult, type Rule, type RuleKind } from "@/lib/terminal/backtest";
import { Stat, Sparkline } from "./ToolDrawer";
import { cn } from "@/lib/utils";

const PERIODS = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 6 months", days: 182 },
  { label: "Last 12 months", days: 365 },
  { label: "All loaded history", days: 0 },
];

export function StrategyTester({ symbol: currentSymbol }: { symbol: string }) {
  const [cfg, setCfg] = useState<BacktestConfig>({ ...DEFAULT_BACKTEST, symbol: currentSymbol });
  const [periodDays, setPeriodDays] = useState(90);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const barsQ = useQuery({
    queryKey: ["btBars", cfg.symbol, cfg.timeframe],
    queryFn: () => loadBarsCached(cfg.symbol, cfg.timeframe as Timeframe, 1000),
    staleTime: 60_000,
  });
  const bars: Bar[] = barsQ.data ?? [];

  const patch = (p: Partial<BacktestConfig>) => setCfg((c) => ({ ...c, ...p }));

  const run = () => {
    setRunning(true);
    setError(null);
    // yield a frame so the button shows the running state on big datasets
    setTimeout(() => {
      const fromTime = periodDays > 0 ? Math.floor(Date.now() / 1000) - periodDays * 86400 : 0;
      const res = runBacktest(bars, cfg, fromTime);
      if ("error" in res) { setResult(null); setError(res.error); }
      else setResult(res);
      setRunning(false);
    }, 30);
  };

  const addRule = (target: "entryLong" | "entryShort") => {
    const spec = RULE_CATALOG[0];
    patch({ [target]: [...cfg[target], { kind: spec.kind, p1: spec.params[0]?.def, p2: spec.params[1]?.def, p3: spec.params[2]?.def }] } as Partial<BacktestConfig>);
  };
  const setRule = (target: "entryLong" | "entryShort", i: number, rule: Rule) => {
    const list = cfg[target].slice(); list[i] = rule;
    patch({ [target]: list } as Partial<BacktestConfig>);
  };
  const delRule = (target: "entryLong" | "entryShort", i: number) => {
    patch({ [target]: cfg[target].filter((_, j) => j !== i) } as Partial<BacktestConfig>);
  };

  return (
    <div className="space-y-3 text-[11px]">
      {/* ---- configuration ---- */}
      <section className="space-y-2 rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Instrument</span>
            <select value={cfg.symbol} onChange={(e) => patch({ symbol: e.target.value })} className="num-input h-7 w-full">{INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}</select>
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Timeframe</span>
            <select value={cfg.timeframe} onChange={(e) => patch({ timeframe: e.target.value })} className="num-input h-7 w-full">{TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Direction</span>
            <select value={cfg.direction} onChange={(e) => patch({ direction: e.target.value as BacktestConfig["direction"] })} className="num-input h-7 w-full">
              <option value="both">Long + Short</option><option value="long">Long only</option><option value="short">Short only</option>
            </select>
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Period</span>
            <select value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} className="num-input h-7 w-full">
              {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
            </select>
          </label>
        </div>

        {(["entryLong", "entryShort"] as const).map((target) => (
          <div key={target} className="rounded-lg border border-border/40 p-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{target === "entryLong" ? "Entry LONG rules (AND)" : "Entry SHORT rules (AND)"}</span>
              <button onClick={() => addRule(target)} className="flex items-center gap-0.5 text-emerald-400 hover:text-emerald-300"><Plus className="h-3 w-3" />add</button>
            </div>
            {cfg[target].length === 0 && <p className="mt-1 text-[10px] text-muted-foreground">No rules — this direction will never trigger.</p>}
            {cfg[target].map((rule, i) => {
              const spec = RULE_CATALOG.find((s) => s.kind === rule.kind)!;
              return (
                <div key={i} className="mt-1 flex items-center gap-1">
                  <select value={rule.kind} onChange={(e) => {
                    const s2 = RULE_CATALOG.find((x) => x.kind === e.target.value as RuleKind)!;
                    setRule(target, i, { kind: s2.kind, p1: s2.params[0]?.def, p2: s2.params[1]?.def, p3: s2.params[2]?.def });
                  }} className="num-input h-7 min-w-0 flex-1">
                    {RULE_CATALOG.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
                  </select>
                  {spec.params.map((p) => (
                    <input key={p.key} type="number" step="any" value={(rule as any)[p.key] ?? ""}
                      onChange={(e) => setRule(target, i, { ...rule, [p.key]: Number(e.target.value) } as Rule)}
                      title={p.label} className="num-input h-7 w-14" />
                  ))}
                  <button onClick={() => delRule(target, i)} className="text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                </div>
              );
            })}
          </div>
        ))}

        <div className="grid grid-cols-4 gap-1.5">
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Stop loss</span>
            <div className="flex gap-1">
              <select value={cfg.slType} onChange={(e) => patch({ slType: e.target.value as BacktestConfig["slType"] })} className="num-input h-7 w-14">
                <option value="atr">ATR×</option><option value="pct">%</option><option value="points">pts</option>
              </select>
              <input type="number" step="any" value={cfg.slValue} onChange={(e) => patch({ slValue: Number(e.target.value) })} className="num-input h-7 w-full" />
            </div>
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Take profit</span>
            <div className="flex gap-1">
              <select value={cfg.tpType} onChange={(e) => patch({ tpType: e.target.value as BacktestConfig["tpType"] })} className="num-input h-7 w-16">
                <option value="rr">R:R</option><option value="atr">ATR×</option><option value="pct">%</option><option value="points">pts</option>
              </select>
              <input type="number" step="any" value={cfg.tpValue} onChange={(e) => patch({ tpValue: Number(e.target.value) })} className="num-input h-7 w-full" />
            </div>
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Risk / trade %</span>
            <input type="number" step="any" value={cfg.riskPct} onChange={(e) => patch({ riskPct: Number(e.target.value) })} className="num-input h-7 w-full" />
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Start balance</span>
            <input type="number" value={cfg.startingBalance} onChange={(e) => patch({ startingBalance: Number(e.target.value) })} className="num-input h-7 w-full" />
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Commission % (side)</span>
            <input type="number" step="any" value={cfg.commissionPct} onChange={(e) => patch({ commissionPct: Number(e.target.value) })} className="num-input h-7 w-full" />
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Spread (pips)</span>
            <input type="number" step="any" value={cfg.spreadPips} onChange={(e) => patch({ spreadPips: Number(e.target.value) })} className="num-input h-7 w-full" />
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Exit on opposite</span>
            <select value={cfg.exitOpposite ? "1" : "0"} onChange={(e) => patch({ exitOpposite: e.target.value === "1" })} className="num-input h-7 w-full">
              <option value="0">No</option><option value="1">Yes</option>
            </select>
          </label>
          <label className="space-y-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">Max bars open</span>
            <input type="number" value={cfg.maxBarsOpen} onChange={(e) => patch({ maxBarsOpen: Number(e.target.value) })} className="num-input h-7 w-full" />
          </label>
        </div>

        <button onClick={run} disabled={running || barsQ.isLoading || bars.length < 120}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/20 py-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-40">
          <Play className="h-3.5 w-3.5" />{running ? "Running…" : barsQ.isLoading ? "Loading history…" : `Run backtest on ${bars.length} real bars`}
        </button>
        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-red-300">{error}</p>}
      </section>

      {/* ---- results ---- */}
      {result && (
        <>
          <section className="grid grid-cols-3 gap-1.5">
            <Stat label="Total trades" value={result.stats.total} />
            <Stat label="Win rate" value={`${result.stats.winRate}%`} tone={result.stats.winRate >= 50 ? "up" : "neutral"} />
            <Stat label="Net profit" value={`${result.stats.netProfit >= 0 ? "+" : ""}${result.stats.netProfit}`} tone={result.stats.netProfit >= 0 ? "up" : "down"} />
            <Stat label="Profit factor" value={result.stats.profitFactor} tone={result.stats.profitFactor >= 1 ? "up" : "down"} />
            <Stat label="Max drawdown" value={`${result.stats.maxDrawdown} (${result.stats.maxDrawdownPct}%)`} tone="down" />
            <Stat label="Avg R:R" value={result.stats.avgRR} />
            <Stat label="Wins / Losses" value={`${result.stats.wins} / ${result.stats.losses}`} />
            <Stat label="Avg win / loss" value={`${result.stats.avgWin} / ${result.stats.avgLoss}`} />
            <Stat label="Fees paid" value={result.stats.fees} />
          </section>

          <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Equity curve (closed trades)</div>
            <Sparkline points={result.equity.map((p) => p.value)} height={110} color={result.stats.netProfit >= 0 ? "#22c55e" : "#ef4444"} />
          </section>

          <section className="grid grid-cols-3 gap-1.5">
            <Stat label="Long trades" value={`${result.stats.longs} · WR ${result.stats.longWinRate}%`} tone={result.stats.longNet >= 0 ? "up" : "down"} />
            <Stat label="Short trades" value={`${result.stats.shorts} · WR ${result.stats.shortWinRate}%`} tone={result.stats.shortNet >= 0 ? "up" : "down"} />
            <Stat label="Long / Short net" value={`${result.stats.longNet} / ${result.stats.shortNet}`} />
          </section>

          <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Monthly performance</div>
            <table className="w-full text-[10px]">
              <thead><tr className="text-muted-foreground"><th className="text-left font-medium">Month</th><th className="text-right font-medium">Trades</th><th className="text-right font-medium">Win rate</th><th className="text-right font-medium">Net P/L</th></tr></thead>
              <tbody className="font-number">
                {result.monthly.map((m) => (
                  <tr key={m.month} className="border-t border-border/30">
                    <td>{m.month}</td><td className="text-right">{m.trades}</td><td className="text-right">{m.winRate}%</td>
                    <td className={cn("text-right", m.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{m.pnl >= 0 ? "+" : ""}{m.pnl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Trade history ({result.trades.length})</div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-[#0d1117]"><tr className="text-muted-foreground">
                  <th className="text-left font-medium">#</th><th className="text-left font-medium">Side</th>
                  <th className="text-right font-medium">Entry</th><th className="text-right font-medium">Exit</th>
                  <th className="text-right font-medium">Pips</th><th className="text-right font-medium">P/L</th><th className="text-left font-medium">Exit by</th>
                </tr></thead>
                <tbody className="font-number">
                  {result.trades.map((t) => (
                    <tr key={t.id} className="border-t border-border/30">
                      <td>{t.id}</td>
                      <td className={t.side === "long" ? "text-emerald-400" : "text-red-400"}>{t.side === "long" ? "L" : "S"}</td>
                      <td className="text-right">{t.entry.toFixed(4)}</td>
                      <td className="text-right">{t.exit.toFixed(4)}</td>
                      <td className="text-right">{t.pips}</td>
                      <td className={cn("text-right", t.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{t.pnl >= 0 ? "+" : ""}{t.pnl}</td>
                      <td className="uppercase text-muted-foreground">{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="text-[9px] leading-relaxed text-muted-foreground">
            Model: fills at next bar open with spread; stops fill before targets inside the same bar (pessimistic); commission on both sides.
            Signals evaluated on closed bars only — no look-ahead. Results are simulated research output, NOT trading advice.
          </p>
        </>
      )}
    </div>
  );
}
