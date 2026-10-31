import { useTrades, useDeleteTrade } from "@/hooks/use-trades";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, TrendingUp, TrendingDown, Clock } from "lucide-react";
import { format } from "date-fns";
import { useLanguage } from "@/lib/language-context";

export function TradeTable({ category = "ALL" }: { category?: string }) {
  const { t } = useLanguage();
  const { data: allTrades, isLoading } = useTrades();
  const { mutate: deleteTrade, isPending: isDeleting } = useDeleteTrade();

  const trades = allTrades?.filter(t => category === "ALL" || t.category === category) || [];

  if (isLoading) {
    return <Skeleton className="h-96 w-full rounded-2xl bg-card" />;
  }

  if (!trades || trades.length === 0) {
    return (
      <Card className="p-12 glass-panel flex flex-col items-center justify-center text-center">
        <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
          <Clock className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="text-xl font-display font-semibold mb-2">{t("noTrades")}</h3>
        <p className="text-muted-foreground max-w-sm">
          {t("startJournal")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="glass-panel overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-secondary/50">
            <TableRow className="border-border/50 hover:bg-transparent">
              <TableHead className="font-semibold uppercase tracking-wider text-xs">{t("date")}</TableHead>
              <TableHead className="font-semibold uppercase tracking-wider text-xs">{t("asset")}</TableHead>
              <TableHead className="font-semibold uppercase tracking-wider text-xs">{t("positionType")}</TableHead>
              <TableHead className="font-semibold uppercase tracking-wider text-xs text-right">{t("entryPrice")}</TableHead>
              <TableHead className="font-semibold uppercase tracking-wider text-xs text-right">{t("exitPrice")}</TableHead>
              <TableHead className="font-semibold uppercase tracking-wider text-xs text-right">{t("lotSize")}</TableHead>
              <TableHead className="font-semibold uppercase tracking-wider text-xs text-right">{t("netPnl")}</TableHead>
              <TableHead className="w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trades.map((trade) => {
              const isProfit = trade.profit >= 0;
              const instrumentSymbol = trade.instrumentSymbol || trade.assetName;
              return (
                <TableRow key={trade.id} className="border-border/50 hover:bg-secondary/30 transition-colors">
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {trade.timestamp ? format(new Date(trade.timestamp), "MMM dd, yyyy HH:mm") : "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-semibold">{instrumentSymbol}</div>
                    {trade.instrumentName && (
                      <div className="text-xs text-muted-foreground">{trade.instrumentName}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold ${
                      trade.type === "BUY" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
                    }`}>
                      {trade.type === "BUY" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {trade.type === "BUY" ? t("tradeBuy") : t("tradeSell")}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-number whitespace-nowrap text-muted-foreground">
                    ${trade.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right font-number whitespace-nowrap text-muted-foreground">
                    ${trade.exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right font-number whitespace-nowrap">
                    {trade.lotSize}
                  </TableCell>
                  <TableCell className={`text-right font-number font-bold whitespace-nowrap ${
                    isProfit ? "text-success" : "text-destructive"
                  }`}>
                    {isProfit ? "+" : ""}${trade.profit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={isDeleting}
                      onClick={() => deleteTrade({ tradeId: trade.id, profit: trade.profit })}
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
