/**
 * ToolsDialog — searchable launcher for every advanced terminal tool
 * (command-palette style). Keyboard-friendly: type to filter, Enter opens
 * the first match.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolId =
  | "replay" | "backtest" | "sessions" | "heatmap" | "screener" | "mtf"
  | "volume" | "alerts" | "templates" | "analytics" | "calculators" | "compare";

interface ToolDef { id: ToolId; name: string; desc: string; keywords: string; icon: string }

const TOOLS: ToolDef[] = [
  { id: "replay", name: "Bar Replay", desc: "Replay historical candles step by step with simulated trades", keywords: "replay history practice simulate backtest candle", icon: "⏵" },
  { id: "backtest", name: "Strategy Tester", desc: "Backtest entry/exit rules on real data with full statistics", keywords: "backtest strategy tester rules equity drawdown winrate", icon: "🧪" },
  { id: "sessions", name: "Session Analyzer", desc: "Sydney/Tokyo/London/NY times, ranges and chart overlays", keywords: "session london tokyo newyork sydney timezone overlay", icon: "🌍" },
  { id: "heatmap", name: "Market Heatmap", desc: "Daily performance of every instrument + currency strength", keywords: "heatmap currency strength usd eur performance", icon: "🔥" },
  { id: "screener", name: "Market Screener", desc: "Filter all instruments by RSI, crossovers, volatility…", keywords: "screener filter scan rsi ema macd atr", icon: "🔎" },
  { id: "mtf", name: "Multi-Timeframe", desc: "M1–D1 trend classification for the selected instrument", keywords: "mtf multi timeframe trend m1 m5 h4 d1", icon: "📊" },
  { id: "volume", name: "Volume Analysis", desc: "Volume profile, POC/VAH/VAL, anchored VWAP, delta", keywords: "volume profile poc vah val vwap delta anchored", icon: "📈" },
  { id: "alerts", name: "Advanced Alerts", desc: "Price/RSI/MACD/EMA/BB/trendline/S-R/daily H-L alerts", keywords: "alert notification trigger price rsi breakout", icon: "🔔" },
  { id: "templates", name: "Workspace Templates", desc: "Save and restore complete chart configurations", keywords: "template workspace save load layout preset", icon: "💾" },
  { id: "compare", name: "Chart Comparison", desc: "Normalized % comparison of two instruments", keywords: "compare correlation normalized performance vs", icon: "⚖️" },
  { id: "analytics", name: "Prop Firm Analytics", desc: "Equity, drawdown, consistency and session analytics of your trades", keywords: "prop firm analytics challenge equity drawdown consistency", icon: "🏆" },
  { id: "calculators", name: "Calculators", desc: "Position size, pips, margin, R:R, Fibonacci, compounding…", keywords: "calculator position lot pip margin fib drawdown compound", icon: "🧮" },
];

export function ToolsDialog({ open, onOpenChange, onLaunch }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onLaunch: (tool: ToolId) => void;
}) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOOLS;
    return TOOLS.filter((t) => `${t.name} ${t.desc} ${t.keywords}`.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => { if (open) setQuery(""); }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border/60 bg-[#0d1117] sm:max-w-md">
        <DialogHeader><DialogTitle className="text-sm">Terminal tools</DialogTitle></DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && list[0]) { onLaunch(list[0].id); onOpenChange(false); } }}
            placeholder="Search tools… (replay, rsi, margin…)"
            className="h-9 w-full rounded-lg border border-border/60 bg-background/60 pl-8 pr-2 text-sm outline-none focus:border-emerald-500/50" />
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          {list.map((t) => (
            <button key={t.id} onClick={() => { onLaunch(t.id); onOpenChange(false); }}
              className={cn("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-emerald-500/10")}>
              <span className="mt-0.5 text-base leading-none">{t.icon}</span>
              <span className="min-w-0">
                <span className="block text-xs font-bold text-foreground">{t.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{t.desc}</span>
              </span>
            </button>
          ))}
          {!list.length && <div className="py-6 text-center text-xs text-muted-foreground">No tool matches “{query}”.</div>}
        </div>
        <p className="text-[9px] text-muted-foreground">Tip: press Enter to open the top match.</p>
      </DialogContent>
    </Dialog>
  );
}
