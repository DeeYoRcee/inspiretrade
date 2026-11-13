/**
 * MtfPanel — multi-timeframe trend analysis for the selected instrument.
 * Loads REAL bars for M1/M5/M15/H1/H4/D1 (TTL-cached) and classifies each
 * timeframe with a transparent, configurable score: EMA gap (ATR-normalized)
 * + price vs EMA + RSI zone + MACD direction. Research aid, not advice.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Timeframe } from "@shared/terminal";
import { GroupedOptions } from "@/components/terminal/SymbolOptions";
import { loadBarsMany } from "@/lib/terminal/data-feeds";
import { mtfTable, mtfVerdict, DEFAULT_MTF, type MtfConfig, type MtfRow } from "@/lib/terminal/mtf";
import { cn } from "@/lib/utils";

export function MtfPanel({ symbol, onSelect }: { symbol: string; onSelect?: (s: string) => void }) {
  const [cfg, setCfg] = useState<MtfConfig>(DEFAULT_MTF);
  const [showCfg, setShowCfg] = useState(false);

  // per-tf loads through the TTL-cached feed layer (staggered batches inside)
  const mtfQ = useQuery({
    queryKey: ["mtf", symbol, cfg],
    queryFn: async () => {
      const tfs: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
      const map: Partial<Record<Timeframe, Awaited<ReturnType<typeof import("@/lib/terminal/data-feeds").loadBarsCached>>>> = {};
      for (const tf of tfs) {
        try { map[tf] = await loadBarsMany([symbol], tf, 500).then((r) => r[symbol]); } catch { /* tf unavailable */ }
      }
      return mtfTable(map, cfg);
    },
    staleTime: 5 * 60_000,
  });

  const rows: MtfRow[] = mtfQ.data ?? [];

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex items-center justify-between">
        <div className="font-bold">Multi-Timeframe — {symbol}</div>
        <select value={symbol} onChange={(e) => onSelect?.(e.target.value)} className="num-input h-7 w-28">
          <GroupedOptions />
        </select>
      </div>

      {mtfQ.isLoading && <div className="py-6 text-center text-muted-foreground">Loading 6 timeframes of real data…</div>}
      {mtfQ.isError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-red-300">History unavailable for some timeframes — showing what loaded.</div>}

      {rows.length > 0 && (
        <table className="w-full">
          <thead><tr className="text-[9px] uppercase text-muted-foreground">
            <th className="text-left font-medium">TF</th><th className="text-left font-medium">Trend</th>
            <th className="text-right font-medium">Score</th><th className="text-center font-medium">EMA</th>
            <th className="text-right font-medium">RSI</th><th className="text-center font-medium">MACD</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tf} className="border-t border-border/30">
                <td className="py-1.5 font-bold">{r.tf}</td>
                <td><span className={cn("rounded px-1.5 py-0.5 text-[9px] font-bold",
                  r.trend === "BULLISH" ? "bg-emerald-500/20 text-emerald-400" : r.trend === "BEARISH" ? "bg-red-500/20 text-red-400" : "bg-muted text-muted-foreground")}>{r.trend}</span></td>
                <td className={cn("text-right font-number", r.score > 0 ? "text-emerald-400" : r.score < 0 ? "text-red-400" : "")}>{r.score > 0 ? "+" : ""}{r.score}</td>
                <td className={cn("text-center text-[10px]", r.emaAlign === "bull" ? "text-emerald-400" : r.emaAlign === "bear" ? "text-red-400" : "text-muted-foreground")}>{r.emaAlign}</td>
                <td className="text-right font-number">{r.rsi ?? "—"}</td>
                <td className={cn("text-center text-[10px]", r.macd === "bull" ? "text-emerald-400" : r.macd === "bear" ? "text-red-400" : "text-muted-foreground")}>{r.macd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-card/40 px-2.5 py-2">
          <b>Verdict:</b> {mtfVerdict(rows)}
          <span className="ml-1 text-muted-foreground">— average score {Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length)}</span>
        </div>
      )}

      <button onClick={() => setShowCfg((v) => !v)} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300">
        {showCfg ? "Hide" : "Show"} calculation settings
      </button>
      {showCfg && (
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border/50 bg-card/40 p-2.5">
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">EMA fast</span>
            <input type="number" value={cfg.emaFast} onChange={(e) => setCfg({ ...cfg, emaFast: Number(e.target.value) })} className="num-input h-7 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">EMA slow</span>
            <input type="number" value={cfg.emaSlow} onChange={(e) => setCfg({ ...cfg, emaSlow: Number(e.target.value) })} className="num-input h-7 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">RSI period</span>
            <input type="number" value={cfg.rsiPeriod} onChange={(e) => setCfg({ ...cfg, rsiPeriod: Number(e.target.value) })} className="num-input h-7 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">RSI bull ≥</span>
            <input type="number" value={cfg.rsiBull} onChange={(e) => setCfg({ ...cfg, rsiBull: Number(e.target.value) })} className="num-input h-7 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">RSI bear ≤</span>
            <input type="number" value={cfg.rsiBear} onChange={(e) => setCfg({ ...cfg, rsiBear: Number(e.target.value) })} className="num-input h-7 w-full" /></label>
          <div className="col-span-3 text-[9px] leading-relaxed text-muted-foreground">
            Score = ATR-normalized EMA gap (±50) + price-vs-EMA (±15) + RSI zone (±20) + MACD direction (±15). Thresholds ±35 decide the label.
          </div>
        </div>
      )}
      <p className="text-[9px] text-muted-foreground">Technical classification of historical data — not guaranteed trading recommendations.</p>
    </div>
  );
}
