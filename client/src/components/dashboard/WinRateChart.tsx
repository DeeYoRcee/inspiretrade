import { useState, useMemo } from "react";
import { useTrades } from "@/hooks/use-trades";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, isWithinInterval, startOfDay, endOfDay } from "date-fns";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language-context";

type Period = "all" | "monthly" | "weekly" | "daily";
export function WinRateChart({ category = "ALL" }: { category?: string }) {
  const { t } = useLanguage();
  const [period, setPeriod] = useState<Period>("all");
  const { data: allTrades } = useTrades();

  const trades = useMemo(() => {
    const base = allTrades?.filter(t => category === "ALL" || t.category === category) || [];
    const now = new Date();
    if (period === "all") return base;
    if (period === "daily") return base.filter(t => isWithinInterval(new Date(t.timestamp), { start: startOfDay(now), end: endOfDay(now) }));
    if (period === "weekly") return base.filter(t => isWithinInterval(new Date(t.timestamp), { start: startOfWeek(now), end: endOfWeek(now) }));
    if (period === "monthly") return base.filter(t => isWithinInterval(new Date(t.timestamp), { start: startOfMonth(now), end: endOfMonth(now) }));
    return base;
  }, [allTrades, category, period]);

  const total = trades.length;
  const wins = trades.filter(t => t.profit > 0).length;
  const losses = trades.filter(t => t.profit <= 0).length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const radius = 42;
  const circ = 2 * Math.PI * radius;
  const winArc = total > 0 ? (wins / total) * circ : 0;
  const periods: { key: Period; label: string }[] = [
    { key: "all", label: t("allTime") },
    { key: "monthly", label: t("monthly") },
    { key: "weekly", label: t("weekly") },
    { key: "daily", label: t("today") },
  ];

  return (
    <Card className="glass-panel">
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="text-lg">{t("winRate")}</CardTitle>
          <div className="flex gap-1 bg-secondary/50 rounded-lg p-1">
            {periods.map(p => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={cn(
                  "px-2 py-1 text-xs rounded-md transition-all font-medium",
                  period === p.key ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="w-28 h-28 flex-shrink-0">
            <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r={radius} fill="none" stroke="hsl(var(--muted))" strokeWidth="12" />
              {total > 0 && (
                <circle
                  cx="50" cy="50" r={radius} fill="none"
                  stroke="hsl(var(--success))" strokeWidth="12"
                  strokeDasharray={`${winArc} ${circ}`}
                  strokeLinecap="round"
                />
              )}
              <text
                x="50" y="50"
                textAnchor="middle" dominantBaseline="middle"
                className="rotate-90"
                style={{ transform: "rotate(90deg) translate(0, -100px)", fontSize: "18px", fontWeight: "bold", fill: "hsl(var(--foreground))" }}
              />
            </svg>
            <div className="relative -mt-28 flex items-center justify-center h-28">
              <span className="text-xl font-bold font-number text-foreground">{winRate.toFixed(0)}%</span>
            </div>
          </div>
          <div className="flex-1 space-y-2">
            <div>
              <p className="text-3xl font-bold font-number text-primary">{winRate.toFixed(1)}%</p>
                <p className="text-xs text-muted-foreground">{t("winRate")}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-success/10 rounded-lg p-2">
                <p className="text-lg font-bold font-number text-success">{wins}</p>
                  <p className="text-xs text-muted-foreground">{t("wins")}</p>
              </div>
              <div className="bg-destructive/10 rounded-lg p-2">
                <p className="text-lg font-bold font-number text-destructive">{losses}</p>
                  <p className="text-xs text-muted-foreground">{t("losses")}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{total} {t("totalTrades").toLowerCase()}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
