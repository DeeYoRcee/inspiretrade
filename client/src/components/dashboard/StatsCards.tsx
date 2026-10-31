import { useTrades } from "@/hooks/use-trades";
import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Target, ActivitySquare } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/language-context";

export function StatsCards({ category = "ALL" }: { category?: string }) {
  const { t } = useLanguage();
  const { data: allTrades, isLoading } = useTrades();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 rounded-2xl bg-card" />
        ))}
      </div>
    );
  }

  const trades = allTrades?.filter(t => category === "ALL" || t.category === category) || [];
  const totalTrades = trades.length;
  const totalProfit = trades.reduce((acc, trade) => acc + trade.profit, 0);
  const winningTrades = trades.filter((t) => t.profit > 0).length;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  
  const isProfitable = totalProfit >= 0;

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };

  return (
    <motion.div 
      variants={container}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 md:grid-cols-3 gap-6"
    >
      <motion.div variants={item}>
        <Card className="p-6 glass-panel relative overflow-hidden group">
          <div className={`absolute top-0 right-0 p-4 opacity-10 transition-transform duration-500 group-hover:scale-110 ${isProfitable ? 'text-success' : 'text-destructive'}`}>
            {isProfitable ? <TrendingUp className="w-24 h-24" /> : <TrendingDown className="w-24 h-24" />}
          </div>
          <div className="relative z-10">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t("totalNetPnl")}
            </p>
            <h2 className={`text-4xl font-bold font-number tracking-tight ${isProfitable ? 'text-success' : 'text-destructive'}`}>
              ${totalProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </h2>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={item}>
        <Card className="p-6 glass-panel relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 transition-transform duration-500 group-hover:scale-110 text-primary">
            <Target className="w-24 h-24" />
          </div>
          <div className="relative z-10">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t("winRate")}
            </p>
            <h2 className="text-4xl font-bold font-number tracking-tight text-primary">
              {winRate.toFixed(1)}%
            </h2>
            <p className="text-sm text-muted-foreground mt-2">
              {winningTrades} {t("wins").toLowerCase()} {t("winningOutOf")} {totalTrades}
            </p>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={item}>
        <Card className="p-6 glass-panel relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 transition-transform duration-500 group-hover:scale-110 text-primary">
            <ActivitySquare className="w-24 h-24" />
          </div>
          <div className="relative z-10">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t("totalTrades")}
            </p>
            <h2 className="text-4xl font-bold font-number tracking-tight text-foreground">
              {totalTrades}
            </h2>
          </div>
        </Card>
      </motion.div>
    </motion.div>
  );
}
