/**
 * ReplayChallengePanel (§10) — training challenge: random historical start,
 * hidden future, configurable target / max drawdown / max daily loss / min
 * trading days, live status and a final report. Entirely separate from the
 * real Prop Firm challenge system.
 */
import { useState } from "react";
import { Target } from "lucide-react";
import { Stat } from "./ToolDrawer";
import type { ReplaySession } from "@/hooks/use-replay";
import { cn } from "@/lib/utils";

export function ReplayChallengePanel({ rs }: { rs: ReplaySession }) {
  const [targetPct, setTargetPct] = useState(10);
  const [maxDdPct, setMaxDdPct] = useState(8);
  const [maxDailyLossPct, setMaxDailyLossPct] = useState(4);
  const [minDays, setMinDays] = useState(2);
  const [randomStart, setRandomStart] = useState(true);
  const [balance, setBalance] = useState(10000);

  const ch = rs.challenge;
  const retPct = ch ? ((rs.equity - ch.startBalance) / ch.startBalance) * 100 : 0;

  const begin = () => {
    const idx = randomStart
      ? Math.floor(30 + Math.random() * Math.max(1, rs.bars.length - 200))
      : Math.floor(rs.bars.length * 0.7);
    rs.setCfg({ startingBalance: balance });
    // reset engine at the (possibly random) start, then arm the challenge
    rs.start(idx);
    rs.setChallenge({
      targetPct, maxDdPct, maxDailyLossPct, minDays,
      startBalance: balance, startTime: rs.bars[idx]?.time ?? 0,
      status: "running",
    });
  };

  if (ch) {
    const passed = ch.status === "passed";
    return (
      <div className="space-y-3 p-3 text-[11px]">
        <section className={cn("rounded-xl border p-3", passed ? "border-emerald-500/40 bg-emerald-500/10" : ch.status === "failed" ? "border-red-500/40 bg-red-500/10" : "border-sky-500/40 bg-sky-500/5")}>
          <div className="flex items-center justify-between">
            <b className="flex items-center gap-1.5"><Target className="h-4 w-4 text-sky-400" />Replay Challenge</b>
            <span className={cn("rounded px-2 py-0.5 text-[10px] font-black uppercase", passed ? "bg-emerald-500/25 text-emerald-300" : ch.status === "failed" ? "bg-red-500/25 text-red-300" : "bg-sky-500/20 text-sky-300")}>{ch.status}</span>
          </div>
          {ch.status === "failed" && ch.failReason && <p className="mt-1.5 text-red-300">{ch.failReason}</p>}
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Stat label="Target" value={`+${ch.targetPct}%`} />
            <Stat label="Progress" value={`${retPct >= 0 ? "+" : ""}${retPct.toFixed(1)}%`} tone={retPct >= 0 ? "up" : "down"} />
            <Stat label="Equity" value={`$${rs.equity.toFixed(0)}`} />
            <Stat label="Trades" value={rs.engine.closed.length} />
            <Stat label="Max DD rule" value={`${ch.maxDdPct}%`} />
            <Stat label="Daily loss rule" value={`${ch.maxDailyLossPct}%`} />
          </div>
          <button onClick={() => rs.evaluateChallenge()} className="mt-2 w-full rounded-lg border border-border/60 py-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground">
            Re-evaluate status
          </button>
          <p className="mt-1.5 text-[9px] text-muted-foreground">Status auto-updates after every closed trade. The report lives in STATS too.</p>
        </section>
        <button onClick={() => rs.setChallenge(null)} className="w-full rounded-lg border border-border/60 py-2 text-[10px] font-bold text-muted-foreground hover:text-foreground">Abandon challenge</button>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-[11px]">
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-2.5">
        <b className="flex items-center gap-1.5"><Target className="h-4 w-4 text-sky-400" />Training challenge</b>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          You start at a historical point with the future hidden. Hit the profit target before breaking the drawdown rules.
          Training only — this never touches the real Prop Firm system.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-border/50 bg-card/40 p-2.5">
        <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Profit target %</span>
          <input type="number" step="any" value={targetPct} onChange={(e) => setTargetPct(Number(e.target.value))} className="num-input h-7 w-full" /></label>
        <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Max drawdown %</span>
          <input type="number" step="any" value={maxDdPct} onChange={(e) => setMaxDdPct(Number(e.target.value))} className="num-input h-7 w-full" /></label>
        <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Max daily loss %</span>
          <input type="number" step="any" value={maxDailyLossPct} onChange={(e) => setMaxDailyLossPct(Number(e.target.value))} className="num-input h-7 w-full" /></label>
        <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Min trading days</span>
          <input type="number" value={minDays} onChange={(e) => setMinDays(Math.max(1, Number(e.target.value)))} className="num-input h-7 w-full" /></label>
        <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Starting balance</span>
          <input type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} className="num-input h-7 w-full" /></label>
        <label className="mt-5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={randomStart} onChange={(e) => setRandomStart(e.target.checked)} className="accent-sky-500" />
          Random historical start (surprise test)
        </label>
      </div>
      <button onClick={begin} disabled={rs.loading || rs.bars.length < 60}
        className="w-full rounded-lg bg-sky-500/25 py-2 text-xs font-black text-sky-300 hover:bg-sky-500/35 disabled:opacity-40">
        {rs.loading ? "Loading history…" : `Start challenge on ${rs.symbol} ${rs.timeframe}`}
      </button>
      {rs.historyError && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-red-300">{rs.historyError.message}</p>}
    </div>
  );
}
