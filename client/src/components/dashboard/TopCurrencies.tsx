import { useMemo } from "react";
import { useTrades } from "@/hooks/use-trades";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/lib/language-context";

export function TopCurrencies({ category = "ALL" }: { category?: string }) {
  const { t } = useLanguage();
  const { data: allTrades } = useTrades();

  const data = useMemo(() => {
    const trades = allTrades?.filter(t => category === "ALL" || t.category === category) || [];
    const assetMap: Record<string, { total: number; wins: number; count: number }> = {};
    for (const t of trades) {
      if (!assetMap[t.assetName]) assetMap[t.assetName] = { total: 0, wins: 0, count: 0 };
      assetMap[t.assetName].total += t.profit;
      assetMap[t.assetName].count += 1;
      if (t.profit > 0) assetMap[t.assetName].wins += 1;
    }
    return Object.entries(assetMap)
      .map(([name, v]) => ({
        name,
        profit: parseFloat(v.total.toFixed(2)),
        winRate: parseFloat(((v.wins / v.count) * 100).toFixed(1)),
        count: v.count,
      }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 6);
  }, [allTrades, category]);

  const maxAbs = Math.max(...data.map(d => Math.abs(d.profit)), 1);

  if (data.length === 0) {
    return (
      <Card className="glass-panel">
        <CardHeader><CardTitle className="text-lg">{t("topCurrencies")}</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-center h-24 text-muted-foreground text-sm">{t("noDataYet")}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{t("topCurrencies")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.map((d, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground w-20 truncate">{d.name}</span>
                <span className="text-muted-foreground">{d.winRate}% {t("wr")}</span>
              </div>
              <span className={`font-bold font-number text-sm ${d.profit >= 0 ? "text-success" : "text-destructive"}`}>
                {d.profit >= 0 ? "+" : ""}${d.profit}
              </span>
            </div>
            <div className="w-full bg-muted/40 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${d.profit >= 0 ? "bg-success" : "bg-destructive"}`}
                style={{ width: `${(Math.abs(d.profit) / maxAbs) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
