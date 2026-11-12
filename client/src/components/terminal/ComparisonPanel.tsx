/**
 * ComparisonPanel — normalized % performance comparison of two instruments
 * over real daily bars, with an optional on-chart normalized overlay of
 * instrument B on the main chart.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { INSTRUMENTS } from "@shared/terminal";
import { loadBarsCached } from "@/lib/terminal/data-feeds";
import { Stat } from "./ToolDrawer";
import { cn } from "@/lib/utils";

function changes(bars: { time: number; close: number }[]): { d1: number | null; d7: number | null; d30: number | null; d90: number | null } {
  if (!bars.length) return { d1: null, d7: null, d30: null, d90: null };
  const last = bars[bars.length - 1].close;
  const at = (days: number) => {
    const cutoff = bars[bars.length - 1].time - days * 86400;
    let ref: number | null = null;
    for (const b of bars) { if (b.time >= cutoff) { ref = b.close; break; } }
    return ref ? ((last - ref) / ref) * 100 : null;
  };
  return { d1: at(1), d7: at(7), d30: at(30), d90: at(90) };
}

const fmtPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

export function ComparisonPanel({ symbol, compare, setCompare, onSelect }: {
  symbol: string;
  compare: string | null;
  setCompare: (s: string | null) => void;
  onSelect: (s: string) => void;
}) {
  const [base, setBase] = useState(compare ?? "BTCUSD");

  const aQ = useQuery({ queryKey: ["cmpA", symbol], queryFn: () => loadBarsCached(symbol, "1d", 400), staleTime: 300_000 });
  const bQ = useQuery({ queryKey: ["cmpB", base], queryFn: () => loadBarsCached(base, "1d", 400), staleTime: 300_000 });

  const aCh = useMemo(() => changes(aQ.data ?? []), [aQ.data]);
  const bCh = useMemo(() => changes(bQ.data ?? []), [bQ.data]);

  const overlap = Math.min(aQ.data?.length ?? 0, bQ.data?.length ?? 0);
  const corr = useMemo(() => {
    if (overlap < 30) return null;
    const A = aQ.data!.slice(-overlap).map((b) => b.close);
    const B = bQ.data!.slice(-overlap).map((b) => b.close);
    const ra = A.slice(1).map((v, i) => v / A[i] - 1);
    const rb = B.slice(1).map((v, i) => v / B[i] - 1);
    const ma = ra.reduce((s, x) => s + x, 0) / ra.length;
    const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
    const cov = ra.reduce((s, x, i) => s + (x - ma) * (rb[i] - mb), 0) / ra.length;
    const sa = Math.sqrt(ra.reduce((s, x) => s + (x - ma) ** 2, 0) / ra.length);
    const sb = Math.sqrt(rb.reduce((s, x) => s + (x - mb) ** 2, 0) / rb.length);
    return sa && sb ? Math.round((cov / (sa * sb)) * 100) / 100 : null;
  }, [aQ.data, bQ.data, overlap]);

  const Row = ({ label, a, b }: { label: string; a: number | null; b: number | null }) => (
    <tr className="border-t border-border/30">
      <td className="py-1 text-muted-foreground">{label}</td>
      <td className={cn("text-right font-number", (a ?? 0) >= 0 ? "text-emerald-400" : "text-red-400")}>{fmtPct(a)}</td>
      <td className={cn("text-right font-number", (b ?? 0) >= 0 ? "text-emerald-400" : "text-red-400")}>{fmtPct(b)}</td>
      <td className={cn("text-right font-number", a != null && b != null ? ((a - b) >= 0 ? "text-emerald-400" : "text-red-400") : "")}>{a != null && b != null ? fmtPct(a - b) : "—"}</td>
    </tr>
  );

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex items-center gap-1.5">
        <b>Compare</b>
        <select value={base} onChange={(e) => setBase(e.target.value)} className="num-input ml-auto h-7 w-28">
          {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
        </select>
        <button onClick={() => setCompare(base === compare ? null : base)}
          className={cn("rounded-lg border px-2 py-1 text-[10px] font-bold", base === compare ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}>
          {base === compare ? "ON CHART" : "Overlay"}
        </button>
      </div>

      <table className="w-full">
        <thead><tr className="text-[9px] uppercase text-muted-foreground">
          <th className="text-left font-medium">Period</th>
          <th className="text-right font-medium">{symbol}</th>
          <th className="text-right font-medium">{base}</th>
          <th className="text-right font-medium">Δ</th>
        </tr></thead>
        <tbody>
          <Row label="24h" a={aCh.d1} b={bCh.d1} />
          <Row label="7 days" a={aCh.d7} b={bCh.d7} />
          <Row label="30 days" a={aCh.d30} b={bCh.d30} />
          <Row label="90 days" a={aCh.d90} b={bCh.d90} />
        </tbody>
      </table>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Correlation (90d)" value={corr ?? "—"} tone={(corr ?? 0) > 0.5 ? "up" : (corr ?? 0) < -0.3 ? "down" : "neutral"} />
        <Stat label="Overlap days" value={overlap} />
        <Stat label="Overlay" value={compare ? base : "off"} />
      </div>

      <p className="text-[9px] leading-relaxed text-muted-foreground">
        Percent changes from real daily bars. The overlay plots {base}'s normalized %-performance on the main chart (own hidden scale, same pane).
        Correlation is the Pearson coefficient of daily returns over the overlapping window.
      </p>
      <button onClick={() => onSelect(base)} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300">Open {base} chart →</button>
    </div>
  );
}
