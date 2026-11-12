/**
 * ChallengeDashboard — Prop-Firm style metrics for the terminal's DEMO
 * challenge account: balance, equity, profit target, daily/max drawdown with
 * progress bars and breach warnings. All figures are SIMULATED (demo
 * execution) — real challenge enforcement will run server-side via the
 * execution adapter once a broker bridge exists.
 */
import { Progress } from "@/components/ui/progress";
import { useLanguage } from "@/lib/language-context";
import { useTerminalTrading, computeChallengeMetrics, type ChallengeMetrics } from "@/hooks/use-terminal-trading";
import { cn } from "@/lib/utils";

export function ChallengeDashboard({
  prices, className,
}: {
  prices: Record<string, number>;
  className?: string;
}) {
  const { t } = useLanguage();
  const { account, positions, resetAccount } = useTerminalTrading();
  if (!account) return null;
  const m: ChallengeMetrics = computeChallengeMetrics(account, positions, prices);
  const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  const rows: { label: string; value: string; pct: number; tone: "good" | "warn" | "bad" }[] = [
    { label: t("chTarget"), value: `${usd(m.profit)} / ${usd(m.profitTarget)}`, pct: Math.min(100, Math.max(0, (m.profit / m.profitTarget) * 100)), tone: m.targetReached ? "good" : "good" },
    { label: t("chDailyDD"), value: `${usd(m.currentDailyDD)} / ${usd(m.dailyDrawdownLimit)}`, pct: Math.min(100, (m.currentDailyDD / m.dailyDrawdownLimit) * 100), tone: m.currentDailyDD / m.dailyDrawdownLimit > 0.7 ? "bad" : "warn" },
    { label: t("chMaxDD"), value: `${usd(m.currentMaxDD)} / ${usd(m.maxDrawdownLimit)}`, pct: Math.min(100, (m.currentMaxDD / m.maxDrawdownLimit) * 100), tone: m.currentMaxDD / m.maxDrawdownLimit > 0.7 ? "bad" : "warn" },
  ];

  return (
    <div className={cn("space-y-3 p-3 text-xs", className)}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-orange-500/15 px-2 py-0.5 text-[10px] font-bold text-orange-400">DEMO ACCOUNT</span>
        <span className="text-muted-foreground">{t("demoAccountNote")}</span>
      </div>

      {m.breached && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] font-bold text-red-400">
          ⛔ {t("challengeBreach")}
        </div>
      )}
      {!m.breached && m.targetReached && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] font-bold text-emerald-400">
          🎉 {t("targetReached")}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Stat label={t("chBalance")} value={usd(m.balance)} />
        <Stat label={t("chEquity")} value={usd(m.equity)} tone={m.equity >= m.startingBalance ? "good" : "bad"} />
        <Stat label={t("chStarting")} value={usd(m.startingBalance)} />
        <Stat label={t("chProfit")} value={`${m.profit >= 0 ? "+" : ""}${usd(m.profit)} (${m.profitPct.toFixed(2)}%)`} tone={m.profit >= 0 ? "good" : "bad"} />
      </div>

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-1 flex justify-between text-[10px]">
              <span className="text-muted-foreground">{r.label}</span>
              <b className="font-number text-foreground">{r.value}</b>
            </div>
            <Progress value={r.pct} className={cn("h-1.5", r.tone === "bad" && "[&>div]:bg-red-500", r.tone === "good" && "[&>div]:bg-emerald-500")} />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
        <span>{t("chOpenRisk")}: <b className="text-foreground">{usd(m.openRisk)}</b></span>
        <button onClick={() => { if (window.confirm("Reset DEMO account to starting balance?")) resetAccount(m.startingBalance); }} className="rounded border border-border/60 px-2 py-1 hover:text-foreground">
          {t("resetDemo")}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("font-number mt-0.5 text-sm font-bold", tone === "good" && "text-emerald-400", tone === "bad" && "text-red-400")}>{value}</div>
    </div>
  );
}
