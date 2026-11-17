/**
 * ChartToolbar — tool strip above the chart: cursor/drawing tools, indicator
 * add-menu + active chips, symbol search, settings, layouts, reset, fullscreen.
 * Every button is wired; nothing decorative.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight, Camera, Crosshair, Eye, EyeOff, LayoutTemplate, Maximize2, Minus, MoveUpRight,
  MoveVertical, Plus, Redo2, RotateCcw, Ruler, Search, Settings, Square, TrendingUp, Type, Undo2, X,
  Trash2, SlidersHorizontal, Waves,
} from "lucide-react";
import type { ChartType } from "@/lib/chart-types";
import type { DrawingType } from "@/lib/drawings";
import { INDICATOR_CATALOG, indicatorLabel, type IndicatorConfig, type IndicatorType } from "@/lib/indicators-config";
import { cn } from "@/lib/utils";

const TOOLS: { id: DrawingType | "cursor"; label: string; icon: React.ReactNode; title: string }[] = [
  { id: "cursor", label: "", icon: <Crosshair className="h-3.5 w-3.5" />, title: "Cursor / select (Esc)" },
  { id: "trend", label: "", icon: <TrendingUp className="h-3.5 w-3.5" />, title: "Trend line" },
  { id: "ray", label: "", icon: <ArrowUpRight className="h-3.5 w-3.5" />, title: "Ray" },
  { id: "hline", label: "", icon: <Minus className="h-3.5 w-3.5" />, title: "Horizontal line" },
  { id: "vline", label: "", icon: <MoveVertical className="h-3.5 w-3.5" />, title: "Vertical line" },
  { id: "extended", label: "", icon: <MoveUpRight className="h-3.5 w-3.5" />, title: "Extended line (infinite both ways)" },
  { id: "rect", label: "", icon: <Square className="h-3.5 w-3.5" />, title: "Rectangle" },
  { id: "channel", label: "ch", icon: null, title: "Parallel channel (3 clicks)" },
  { id: "fib-retracement", label: "fib", icon: null, title: "Fibonacci retracement" },
  { id: "fib-extension", label: "fib ext", icon: null, title: "Fibonacci extension (3 clicks)" },
  { id: "measure", label: "", icon: <Ruler className="h-3.5 w-3.5" />, title: "Price range measure (Δprice, Δ%, bars)" },
  { id: "text", label: "", icon: <Type className="h-3.5 w-3.5" />, title: "Text annotation" },
];

export function ChartToolbar({
  activeTool, onToolSelect,
  indicators, onAddIndicator, onIndicatorToggle, onIndicatorRemove, onIndicatorConfigure,
  onOpenSettings, onOpenLayouts, onOpenSearch, onReset, onFullscreen, onClearDrawings,
  drawingsCount,
  chartType, onChartTypeChange,
  canUndo, canRedo, onUndo, onRedo, onScreenshot,
}: {
  activeTool: DrawingType | "cursor";
  onToolSelect: (t: DrawingType | "cursor") => void;
  indicators: IndicatorConfig[];
  onAddIndicator: (t: IndicatorType) => void;
  onIndicatorToggle: (id: string) => void;
  onIndicatorRemove: (id: string) => void;
  onIndicatorConfigure: (id: string) => void;
  onOpenSettings: () => void;
  onOpenLayouts: () => void;
  onOpenSearch: () => void;
  onReset: () => void;
  onFullscreen: () => void;
  onClearDrawings: () => void;
  drawingsCount: number;
  chartType: ChartType;
  onChartTypeChange: (t: ChartType) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onScreenshot: () => void;
}) {
  const [indOpen, setIndOpen] = useState(false);
  const indRef = useRef<HTMLDivElement | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const typeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!indOpen && !typeOpen) return;
    const close = (e: MouseEvent) => {
      if (indRef.current && !indRef.current.contains(e.target as Node)) setIndOpen(false);
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) setTypeOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [indOpen, typeOpen]);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-900/80 px-1.5 py-1">
      {/* drawing tools */}
      <div className="flex items-center gap-0.5 rounded-md border border-slate-700/70 p-0.5">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            title={t.title}
            onClick={() => onToolSelect(t.id)}
            className={cn(
              "flex h-6 min-w-6 items-center justify-center gap-1 rounded px-1.5 text-[10px] font-semibold transition-colors",
              activeTool === t.id ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <button title="Undo drawing (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent">
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button title="Redo drawing (Ctrl+Y)" onClick={onRedo} disabled={!canRedo}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent">
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        {drawingsCount > 0 && (
          <button
            title="Clear all drawings"
            onClick={onClearDrawings}
            className="flex h-6 items-center justify-center rounded px-1.5 text-slate-400 hover:bg-red-500/15 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* chart type selector */}
      <div ref={typeRef} className="relative">
        <button
          onClick={() => setTypeOpen((v) => !v)}
          title="Chart type"
          className="flex h-6 items-center gap-1 rounded-md border border-slate-700/70 px-2 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
        >
          {CHART_TYPES.find((c) => c.id === chartType)?.icon}
          {CHART_TYPES.find((c) => c.id === chartType)?.label}
        </button>
        {typeOpen && (
          <div className="absolute left-0 top-7 z-40 w-44 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
            {CHART_TYPES.map((c) => (
              <button
                key={c.id}
                onClick={() => { onChartTypeChange(c.id); setTypeOpen(false); }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-slate-800",
                  chartType === c.id ? "text-sky-300" : "text-slate-300",
                )}
              >
                {c.icon} {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* indicators dropdown + chips */}
      <div ref={indRef} className="relative">
        <button
          onClick={() => setIndOpen((v) => !v)}
          className="flex h-6 items-center gap-1 rounded-md border border-slate-700/70 px-2 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
        >
          <Waves className="h-3.5 w-3.5" /> Indicators <Plus className="h-3 w-3" />
        </button>
        {indOpen && (
          <div className="absolute left-0 top-7 z-40 w-60 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
            {Object.values(INDICATOR_CATALOG).map((m) => (
              <button
                key={m.type}
                onClick={() => { onAddIndicator(m.type); setIndOpen(false); }}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[11px] text-slate-300 hover:bg-slate-800"
              >
                {m.label}
                <span className="text-[9px] uppercase text-slate-500">{m.pane === "main" ? "overlay" : "pane"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {indicators.map((cfg) => (
        <div
          key={cfg.id}
          className={cn(
            "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold",
            cfg.visible ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-slate-700 text-slate-500",
          )}
        >
          <button onClick={() => onIndicatorConfigure(cfg.id)} className="hover:underline">
            {indicatorLabel(cfg)}
          </button>
          <button onClick={() => onIndicatorToggle(cfg.id)} title={cfg.visible ? "Hide" : "Show"}>
            {cfg.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          </button>
          <button onClick={() => onIndicatorRemove(cfg.id)} title="Remove" className="hover:text-red-400">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {/* right cluster */}
      <div className="ml-auto flex items-center gap-0.5">
        <ToolButton title="Screenshot (PNG)" onClick={onScreenshot}><Camera className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="Symbol search" onClick={onOpenSearch}><Search className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="Chart settings" onClick={onOpenSettings}><Settings className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="Chart layouts" onClick={onOpenLayouts}><LayoutTemplate className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="Reset chart view" onClick={onReset}><RotateCcw className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="Fullscreen" onClick={onFullscreen}><Maximize2 className="h-3.5 w-3.5" /></ToolButton>
      </div>
    </div>
  );
}

const CHART_TYPES: { id: ChartType; label: string; icon: React.ReactNode }[] = [
  { id: "candles", label: "Candles", icon: <CandleChartIcon /> },
  { id: "hollow", label: "Hollow candles", icon: <CandleChartIcon hollow /> },
  { id: "line", label: "Line", icon: <LineIcon /> },
  { id: "area", label: "Area", icon: <AreaIcon /> },
];

/** tiny inline SVGs — lucide has no hollow-candle glyph */
function CandleChartIcon({ hollow = false }: { hollow?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="3" width="3" height="7" rx="0.5" stroke="currentColor" fill={hollow ? "none" : "currentColor"} />
      <line x1="3.5" y1="0.5" x2="3.5" y2="3" stroke="currentColor" />
      <rect x="7" y="1.5" width="3" height="6" rx="0.5" stroke="currentColor" fill="currentColor" />
      <line x1="8.5" y1="7.5" x2="8.5" y2="11.5" stroke="currentColor" />
    </svg>
  );
}
function LineIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <polyline points="0.5,9 3.5,4 6.5,7 11.5,1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function AreaIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M0.5 9 L3.5 4 L6.5 7 L11.5 1.5 L11.5 11.5 L0.5 11.5 Z" fill="currentColor" opacity="0.4" />
      <polyline points="0.5,9 3.5,4 6.5,7 11.5,1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ToolButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-6 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
    >
      {children}
    </button>
  );
}

// re-export for the params dialog in dialogs.tsx
export { SlidersHorizontal };
