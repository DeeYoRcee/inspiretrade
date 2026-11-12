/**
 * ToolDrawer — right-side sliding panel used by the advanced terminal tools
 * (strategy tester, screener, heatmap, sessions, MTF, volume, calculators…).
 * Overlays the workspace without disturbing the existing layout.
 */
import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function ToolDrawer({ open, onClose, title, subtitle, children, width = "w-[470px]" }: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-40 flex justify-end" role="dialog" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={cn("relative flex h-full max-w-[95vw] flex-col border-l border-border/60 bg-[#0d1117] shadow-2xl", width)}>
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/50 px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-card hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

/** Small labeled stat cell used across the tool panels. */
export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "up" | "down" | "neutral" }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-number text-sm font-bold", tone === "up" && "text-emerald-400", tone === "down" && "text-red-400")}>{value}</div>
    </div>
  );
}

/** Dependency-free SVG line chart (equity curves, P/L…). */
export function Sparkline({ points, height = 90, color = "#22c55e", fill = true }: {
  points: number[]; height?: number; color?: string; fill?: boolean;
}) {
  if (points.length < 2) return <div className="flex h-[90px] items-center justify-center text-[10px] text-muted-foreground">Not enough data</div>;
  const w = 100, h = height;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [(i / (points.length - 1)) * w, h - 6 - ((v - min) / span) * (h - 12)] as const);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${d} L${w},${h} L0,${h} Z`;
  const zeroY = max > 0 && min <= 0 ? h - 6 - ((0 - min) / span) * (h - 12) : null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {fill && <path d={area} fill={color} opacity="0.12" />}
      {zeroY != null && <line x1="0" x2={w} y1={zeroY} y2={zeroY} stroke="rgba(148,163,184,0.4)" strokeWidth="0.5" strokeDasharray="2 2" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
