/**
 * Phase 57 — visual source identification for journal trades.
 * prop → gold professional badge (official InspireTrade Prop Account trade,
 * auto-synced + verified), external → sky badge with the broker name,
 * manual → neutral slate badge. One compact pill used everywhere.
 */
import { Building2, Pencil, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { tradeSource, type TradeSource } from "@/lib/trade-source";
import type { Trade } from "@/hooks/use-trades";

const SOURCE_STYLE: Record<TradeSource, string> = {
  prop: "border-amber-400/50 bg-amber-400/12 text-amber-300",
  external: "border-sky-400/50 bg-sky-400/12 text-sky-300",
  manual: "border-border/60 bg-secondary/50 text-muted-foreground",
};

export function SourceBadge({ trade, compact = false }: { trade: Pick<Trade, "source" | "brokerName">; compact?: boolean }) {
  const source = tradeSource(trade);
  const broker = source === "external" && trade.brokerName ? trade.brokerName : null;
  return (
    <span
      title={
        source === "prop"
          ? "InspireTrade Prop Account — auto-synced & verified"
          : source === "external"
            ? `External broker${broker ? `: ${broker}` : ""}`
            : "Manual entry"
      }
      className={cn(
        "inline-flex max-w-[130px] items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider whitespace-nowrap",
        SOURCE_STYLE[source],
      )}
    >
      {source === "prop" && <ShieldCheck className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />}
      {source === "external" && <Building2 className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />}
      {source === "manual" && <Pencil className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />}
      <span className="truncate">
        {source === "prop" ? "Prop" : source === "external" ? broker || "External" : "Manual"}
      </span>
    </span>
  );
}

/** Tiny per-day source presence dots for calendar cells. */
export function SourceDots({ sources }: { sources: TradeSource[] }) {
  const unique = [...new Set(sources)];
  if (unique.length === 0) return null;
  return (
    <span className="flex items-center gap-0.5" aria-label="trade sources">
      {unique.map((s) => (
        <span
          key={s}
          title={s === "prop" ? "Prop" : s === "external" ? "External broker" : "Manual"}
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            s === "prop" ? "bg-amber-400" : s === "external" ? "bg-sky-400" : "bg-muted-foreground",
          )}
        />
      ))}
    </span>
  );
}
