import { Crown, TrendingUp, Trophy, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useLeaderboard } from "@/hooks/use-premium";
import { StatsPeriod } from "@/hooks/use-trades";
import { useLanguage } from "@/lib/language-context";

const MEDAL: Record<number, string> = { 0: "🥇", 1: "🥈", 2: "🥉" };

interface LeaderboardProps {
  period: StatsPeriod;
}

export function Leaderboard({ period }: LeaderboardProps) {
  const { t } = useLanguage();
  const { data: entries, isLoading } = useLeaderboard(period);

  if (isLoading) {
    return (
      <Card className="glass-panel">
        <CardHeader><CardTitle className="text-xl font-display flex items-center gap-2"><Trophy className="w-5 h-5 text-yellow-500" /> {t("leaderboard")}</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 rounded-lg bg-secondary/40 animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <Card className="glass-panel">
        <CardHeader><CardTitle className="text-xl font-display flex items-center gap-2"><Trophy className="w-5 h-5 text-yellow-500" /> {t("leaderboard")}</CardTitle></CardHeader>
        <CardContent>
          <p className="text-center text-muted-foreground text-sm py-6">{t("noTrades")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-xl font-display flex items-center gap-2">
          <Trophy className="w-5 h-5 text-yellow-500" /> {t("leaderboard")}
          <span className="text-xs text-muted-foreground font-normal ml-auto">{t("winRateBy")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {entries.map((entry, i) => (
          <div
            key={entry.uid}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all",
              i === 0 && "bg-yellow-500/10 border border-yellow-500/30",
              i === 1 && "bg-slate-400/10 border border-slate-400/20",
              i === 2 && "bg-amber-700/10 border border-amber-700/20",
              i > 2 && "bg-secondary/30"
            )}
          >
            {/* Rank */}
            <span className="text-lg w-6 text-center shrink-0">
              {MEDAL[i] || <span className="text-xs text-muted-foreground font-bold">{i + 1}</span>}
            </span>

            {/* Username / anonymous */}
            <div className="flex-1 min-w-0">
              {entry.isPremium && entry.username ? (
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm truncate">@{entry.username}</span>
                  <span className="inline-flex shrink-0" title="Premium">
                    <Crown className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Lock className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-sm italic">{t("anonymousTrader")}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{entry.totalTrades} {t("trade")}</p>
            </div>

            {/* Win Rate */}
            <div className="text-right shrink-0">
              <span className={cn(
                "text-sm font-bold font-number",
                parseFloat(entry.winRate) >= 50 ? "text-success" : "text-destructive"
              )}>
                {entry.winRate}%
              </span>
              <div className="w-16 h-1.5 rounded-full bg-secondary/50 mt-1 overflow-hidden">
                <div
                  className={cn("h-full rounded-full", parseFloat(entry.winRate) >= 50 ? "bg-success" : "bg-destructive")}
                  style={{ width: `${Math.min(100, parseFloat(entry.winRate))}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
