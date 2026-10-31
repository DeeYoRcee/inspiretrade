import { useMemo } from "react";
import { useTrades } from "@/hooks/use-trades";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { subDays, isSameDay, format } from "date-fns";
import { useLanguage } from "@/lib/language-context";

export function DailyPnLChart({ category = "ALL" }: { category?: string }) {
  const { t } = useLanguage();
  const { data: allTrades } = useTrades();

  const chartData = useMemo(() => {
    const trades = allTrades?.filter(t => category === "ALL" || t.category === category) || [];
    return Array.from({ length: 30 }, (_, i) => {
      const date = subDays(new Date(), 29 - i);
      const dayTrades = trades.filter(t => isSameDay(new Date(t.timestamp), date));
      return {
        date: format(date, "dd"),
        label: format(date, "MMM dd"),
        pnl: parseFloat(dayTrades.reduce((acc, t) => acc + t.profit, 0).toFixed(2)),
      };
    });
  }, [allTrades, category]);

  const hasData = chartData.some(d => d.pnl !== 0);
  const maxAbs = Math.max(...chartData.map(d => Math.abs(d.pnl)), 1);
  const chartH = 120;

  return (
    <Card className="glass-panel">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{t("dailyPnl30")}</CardTitle>
          <span className="text-xs text-muted-foreground">{t("updatedDaily")}</span>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            {t("noTradesLast30")}
          </div>
        ) : (
          <div className="relative">
            <svg width="100%" height={chartH + 24} viewBox={`0 0 ${chartData.length * 14} ${chartH + 24}`} preserveAspectRatio="none">
              {/* Zero line */}
              <line x1="0" y1={chartH / 2} x2={chartData.length * 14} y2={chartH / 2}
                stroke="hsl(var(--border))" strokeDasharray="4 4" strokeWidth="1" />

              {chartData.map((d, i) => {
                if (d.pnl === 0) return null;
                const barH = Math.max(2, (Math.abs(d.pnl) / maxAbs) * (chartH / 2 - 4));
                const y = d.pnl >= 0 ? chartH / 2 - barH : chartH / 2;
                const color = d.pnl >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))";
                return (
                  <g key={i}>
                    <rect x={i * 14 + 2} y={y} width={10} height={barH} fill={color} opacity={0.8} rx={2}>
                      <title>{d.label}: ${d.pnl >= 0 ? "+" : ""}{d.pnl}</title>
                    </rect>
                  </g>
                );
              })}

              {/* Date labels every 5 days */}
              {chartData.map((d, i) => {
                if (i % 5 !== 0) return null;
                return (
                  <text key={i} x={i * 14 + 7} y={chartH + 16}
                    textAnchor="middle" fontSize="8" fill="hsl(var(--muted-foreground))">
                    {d.date}
                  </text>
                );
              })}
            </svg>

            {/* Summary row */}
            <div className="flex justify-between mt-2 text-xs text-muted-foreground">
              <span>{chartData.filter(d => d.pnl > 0).length} {t("profitDays")}</span>
              <span className={`font-bold font-number ${chartData.reduce((a, b) => a + b.pnl, 0) >= 0 ? "text-success" : "text-destructive"}`}>
                {chartData.reduce((a, b) => a + b.pnl, 0) >= 0 ? "+" : ""}
                ${chartData.reduce((a, b) => a + b.pnl, 0).toFixed(2)} {t("total")}
              </span>
              <span>{chartData.filter(d => d.pnl < 0).length} {t("lossDays")}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
