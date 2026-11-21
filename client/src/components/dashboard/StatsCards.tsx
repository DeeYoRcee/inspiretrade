import { useTrades } from "@/hooks/use-trades";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/language-context";

/**
 * Compact inline sparklines (Phase 32): the big decorative sticker icons on
 * the Overview stat cards are replaced with small real-data charts — same
 * footprint as the old stickers (top-right corner of the card), fixed size
 * so the stat row never wraps or overflows.
 */

interface TradeLite { profit: number; timestamp: number }

/** Fixed-size SVG line sparkline — never scales with content, never wraps. */
function LineSparkline({ points, className, w = 64, h = 30 }: { points: number[]; className?: string; w?: number; h?: number }) {
  if (points.length < 2) return <div style={{ width: w, height: h }} aria-hidden />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const d = points.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={h - 3 - ((points[points.length - 1] - min) / span) * (h - 6)} r="2.2" fill="currentColor" />
    </svg>
  );
}

/** Fixed-size SVG bar sparkline (per-day buckets). */
function BarSparkline({ values, className, w = 64, h = 30 }: { values: number[]; className?: string; w?: number; h?: number }) {
  const max = Math.max(...values, 1);
  const bw = w / values.length;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      {values.map((v, i) => {
        const bh = Math.max((v / max) * (h - 4), v > 0 ? 2 : 0.8);
        return <rect key={i} x={(i * bw + 1).toFixed(1)} y={(h - bh).toFixed(1)} width={Math.max(bw - 2, 1.5).toFixed(1)} height={bh.toFixed(1)} rx="1" fill="currentColor" opacity={v > 0 ? 0.9 : 0.3} />;
      })}
    </svg>
  );
}

const DAY_MS = 86400000;

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

  // -- sparkline data (all bounded, pure computation) --
  const chrono = [...trades].sort((a, b) => a.timestamp - b.timestamp) as TradeLite[];
  // cumulative PnL curve, downsampled to ≤32 points
  let cum = 0;
  const cumAll = chrono.map((tr) => (cum += tr.profit));
  const stride = cumAll.length > 32 ? Math.ceil(cumAll.length / 32) : 1;
  const pnlPoints = cumAll.filter((_, i) => i % stride === 0 || i === cumAll.length - 1);
  // rolling winrate over the last 10 trades (window walk)
  const WR_WINDOW = 10;
  const wrPoints = chrono
    .slice(-30)
    .map((_, i, arr) => {
      const win = arr.slice(Math.max(0, i - WR_WINDOW + 1), i + 1);
      return (win.filter((x) => x.profit > 0).length / win.length) * 100;
    })
    .filter((_, i) => i >= WR_WINDOW - 1 || i === 0);
  // trades per day, last 14 days
  const now = Date.now();
  const perDay = new Array(14).fill(0);
  for (const tr of chrono) {
    const dayIdx = 13 - Math.floor((now - tr.timestamp) / DAY_MS);
    if (dayIdx >= 0 && dayIdx < 14) perDay[dayIdx]++;
  }

  const container = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1 } }
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
          {/* sparkline chip — fixed size, same slot as the old sticker, never wraps */}
          <div className={`pointer-events-none absolute right-3 top-3 ${isProfitable ? "text-success" : "text-destructive"}`} aria-hidden>
            <LineSparkline points={pnlPoints.length >= 2 ? pnlPoints : [0, 0]} />
          </div>
          <div className="relative z-10 pr-16">
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
          <div className="pointer-events-none absolute right-3 top-3 text-primary" aria-hidden>
            <LineSparkline points={wrPoints.length >= 2 ? wrPoints : [0, 0]} />
          </div>
          <div className="relative z-10 pr-16">
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
          <div className="pointer-events-none absolute right-3 top-3 text-primary" aria-hidden>
            <BarSparkline values={perDay} />
          </div>
          <div className="relative z-10 pr-16">
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
