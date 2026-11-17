/**
 * LeaderboardPanel — the verified prop-firm rankings table (daily / weekly /
 * monthly / all-time). Rendered inside the Prop Firm hub (first tab) and on
 * the standalone /leaderboard page. Data comes from the server-computed
 * leaderboard endpoint; public fields only.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trophy, Medal, TrendingUp, ShieldCheck, CircleCheck, CircleX, Activity, PauseCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { propApi, type LeaderboardRow } from "@/lib/trading-api";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

const PERIODS = ["daily", "weekly", "monthly", "all"] as const;
type Period = (typeof PERIODS)[number];

const money = (v: number) =>
  `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}${v < 0 ? " loss" : ""}`;

function StatusIcon({ status }: { status: string }) {
  const cls = "h-3.5 w-3.5";
  if (status === "passed") return <CircleCheck className={cn(cls, "text-emerald-400")} />;
  if (status === "failed") return <CircleX className={cn(cls, "text-red-400")} />;
  return <Activity className={cn(cls, "text-primary")} />;
}

export function LeaderboardPanel({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [period, setPeriod] = useState<Period>("all");

  const q = useQuery({
    queryKey: ["leaderboard", period],
    queryFn: () => propApi.getLeaderboard(period),
    enabled: !!user,
    refetchInterval: 60_000,
  });

  const rows: LeaderboardRow[] = q.data?.rows || [];
  const label: Record<Period, string> = {
    daily: t("lbDaily"), weekly: t("lbWeekly"), monthly: t("lbMonthly"), all: t("lbAll"),
  };

  if (!user) {
    return (
      <Card className="border-border/60 bg-card/50">
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-primary" />
          Sign in to view the verified leaderboard.
        </CardContent>
      </Card>
    );
  }

  if (q.data && !q.data.enabled) {
    return (
      <Card className="border-amber-500/30 bg-card/50">
        <CardContent className="p-8 text-center text-sm text-amber-300">
          <PauseCircle className="mx-auto mb-3 h-8 w-8" />
          {t("lbDisabled")}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {!compact && (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Leaderboard period">
          {PERIODS.map((p) => (
            <button
              key={p} role="tab" aria-selected={period === p} onClick={() => setPeriod(p)}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm transition-colors",
                period === p ? "bg-amber-500/15 font-medium text-amber-300" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >{label[p]}</button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <Card className="border-border/60 bg-card/50">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">{t("lbEmpty")}</CardContent>
        </Card>
      ) : (
        <Card className="border-border/60 bg-card/60">
          <CardContent className="p-2 sm:p-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="pb-2 pl-2 pr-2">{t("lbRank")}</th>
                    <th className="pb-2 pr-3">{t("lbTrader")}</th>
                    <th className="pb-2 pr-3">{t("lbProfit")}</th>
                    <th className="pb-2 pr-3">{t("lbWinRate")}</th>
                    <th className="pb-2 pr-3">{t("lbTrades")}</th>
                    <th className="pb-2 pr-2">{t("lbStatus")}</th>
                  </tr>
                </thead>
                <tbody className="font-number">
                  {rows.map((r) => (
                    <tr key={r.rank} className="border-t border-border/40">
                      <td className="py-2.5 pl-2 pr-2">
                        {r.rank <= 3 ? (
                          <span className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                            r.rank === 1 ? "bg-amber-500/20 text-amber-300" : r.rank === 2 ? "bg-slate-400/20 text-slate-300" : "bg-orange-700/25 text-orange-300",
                          )}>
                            <Medal className="h-3.5 w-3.5" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{r.rank}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <p className="font-semibold text-foreground">{r.name}</p>
                        {r.challengeName && <p className="text-[11px] text-muted-foreground">{r.challengeName} · ${r.size.toLocaleString("en-US")}</p>}
                      </td>
                      <td className={cn("py-2.5 pr-3 font-bold", r.profitPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                        <span className="inline-flex items-center gap-1">
                          <TrendingUp className={cn("h-3 w-3", r.profitPct < 0 && "rotate-180")} />
                          {r.profitPct >= 0 ? "+" : ""}{r.profitPct}%
                        </span>
                        <p className="text-[10px] font-normal text-muted-foreground">{money(r.profitUsd)}</p>
                      </td>
                      <td className="py-2.5 pr-3">{r.winRate != null ? `${r.winRate}%` : "—"}</td>
                      <td className="py-2.5 pr-3">{r.trades}</td>
                      <td className="py-2.5 pr-2"><StatusIcon status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        <ShieldCheck className="mr-1 inline h-3 w-3" />
        Rankings are computed server-side from the immutable trade ledger — balances and private data are never shown.
      </p>
    </>
  );
}

export function LeaderboardPageHeader() {
  const { t } = useLanguage();
  return (
    <div className="mb-5">
      <p className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider text-amber-400">
        <Trophy className="h-4 w-4" />PROP FIRM
      </p>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("lbTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("lbSubtitle")}</p>
    </div>
  );
}
