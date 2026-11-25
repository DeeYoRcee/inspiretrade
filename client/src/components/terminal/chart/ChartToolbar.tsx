/**
 * ChartToolbar — tool strip above the chart: cursor/drawing tools, indicator
 * add-menu + active chips, symbol search, settings, layouts, reset, fullscreen.
 * Every button is wired; nothing decorative.
 */
import { useEffect, useRef, useState } from "react";
import {
  Camera, ChevronDown, Eye, EyeOff, Image as ImageIcon, LayoutTemplate, Lock, Maximize2, Palette, Plus, Redo2,
  RotateCcw, Rewind, Settings, Undo2, X, SlidersHorizontal, Waves,
} from "lucide-react";
import type { ChartType } from "@/lib/chart-types";
import type { DrawingType } from "@/lib/drawings";
import { indicatorLabel, type IndicatorConfig, type IndicatorType } from "@/lib/indicators-config";
import { cn } from "@/lib/utils";
import { APPEARANCE_PRESETS, type ChartSettings } from "@/components/terminal/chart/dialogs";
import { updateInstrumentSettings } from "@/lib/instrument-settings";
import { applyChartSettings } from "@/lib/chart-persistence";
import { SYMBOLS } from "@/lib/news-api";
import { useAuth } from "@/hooks/use-auth";
import { usePremiumStatus, useUserProfile } from "@/hooks/use-premium";
import { useIsAdmin } from "@/hooks/use-admin";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";



export function ChartToolbar({
  symbol,
  indicators, onAddIndicator, onIndicatorToggle, onIndicatorRemove, onIndicatorConfigure,
  onOpenIndicatorLibrary, volumeNote,
  onOpenSettings, onOpenLayouts, onOpenSearch, onReset, onFullscreen,
  onOpenAlerts, onOpenReplay,
  chartType, onChartTypeChange,
  canUndo, canRedo, onUndo, onRedo, onScreenshot,
}: {
  symbol: string;
  indicators: IndicatorConfig[];
  onAddIndicator: (t: IndicatorType) => void;
  onIndicatorToggle: (id: string) => void;
  onIndicatorRemove: (id: string) => void;
  onIndicatorConfigure: (id: string) => void;
  /** Phase 36 §7 — opens the searchable indicator library dialog */
  onOpenIndicatorLibrary: () => void;
  /** honest-volume note shown on the volume chip for non-crypto feeds */
  volumeNote?: string;
  onOpenSettings: () => void;
  onOpenLayouts: () => void;
  onOpenSearch: () => void;
  onReset: () => void;
  onFullscreen: () => void;
  onOpenAlerts: () => void;
  onOpenReplay: () => void;
  chartType: ChartType;
  onChartTypeChange: (t: ChartType) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onScreenshot: () => void;
}) {


  const [typeOpen, setTypeOpen] = useState(false);
  const typeRef = useRef<HTMLDivElement | null>(null);
  // Phase 34b: chart theme dropdown (minimal preset collection)
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement | null>(null);
  // P64R4 user request: chart BACKGROUND dropdown to the LEFT of the theme icon
  const [bgOpen, setBgOpen] = useState(false);
  const bgRef = useRef<HTMLDivElement | null>(null);
  const { user } = useAuth();
  const { data: bgIsPremium = false } = usePremiumStatus();
  const bgProfileQ = useUserProfile();
  const bgIsAdmin = useIsAdmin();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const bgIsVip = bgIsPremium || bgIsAdmin
    || !!(bgProfileQ.data?.isPremium || (bgProfileQ.data as unknown as { ceo?: boolean } | null)?.ceo);
  useEffect(() => {
    if (!typeOpen && !themeOpen && !bgOpen) return;
    const close = (e: MouseEvent) => {
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) setTypeOpen(false);
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) setThemeOpen(false);
      if (bgRef.current && !bgRef.current.contains(e.target as Node)) setBgOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [typeOpen, themeOpen, bgOpen]);

  const readBgImage = (): string => {
    try { return String(JSON.parse(localStorage.getItem("it_chart_settings") || "{}").bgImage ?? ""); }
    catch { return ""; }
  };
  const applyBgImage = (id: string) => {
    let next: ChartSettings;
    try {
      next = { ...JSON.parse(localStorage.getItem("it_chart_settings") || "{}"), bgImage: id };
    } catch { next = { bgImage: id } as ChartSettings; }
    applyChartSettings(user?.uid, next); // P64R4 — cloud-save included
  };

  /** Apply an appearance preset globally and persist EVERYWHERE — local
   * mirror, broadcast AND the debounced cloud copy (P64R4: the missing cloud
   * write let SettingsSync resurrect the previous theme on the next visit —
   * the "theme not saved" report). The candle-color overrides of EVERY symbol
   * are cleared so no stale per-instrument colors can mask the preset. */
  const applyPreset = (s: Partial<ChartSettings>) => {
    let next: ChartSettings;
    try {
      next = { ...JSON.parse(localStorage.getItem("it_chart_settings") || "{}"), ...s };
    } catch { next = { ...(s as ChartSettings) }; }
    applyChartSettings(user?.uid, next);
    for (const sym of Array.from(new Set<string>([symbol, ...SYMBOLS]))) {
      updateInstrumentSettings(sym, { upColor: undefined, downColor: undefined });
    }
  };

  return (
    <div className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900/80 px-1.5 py-1 sm:flex-wrap sm:overflow-x-visible">
      {/* P78 — one scrollable strip on small screens instead of wrapping into
          several rows that eat the chart height; wrapping returns from sm up */}
      {/* symbol — TV-style: opens the search dialog */}
      <button
        onClick={onOpenSearch}
        title="Symbol search (/)"
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-slate-700/70 px-2 text-[11px] font-bold text-slate-100 hover:bg-slate-800"
      >
        {symbol}
        <ChevronDown className="h-3 w-3 text-slate-500" />
      </button>

      {/* chart type selector */}
      <div ref={typeRef} className="relative">
        <button
          onClick={() => setTypeOpen((v) => !v)}
          title="Chart type"
          aria-label="Chart type"
          aria-expanded={typeOpen}
          className={`flex h-6 shrink-0 items-center gap-1 rounded-md border border-slate-700/70 px-2 text-[10px] font-semibold hover:bg-slate-800 ${typeOpen ? "bg-slate-800 text-slate-100" : "text-slate-300"}`}
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
      <div>
        <button
          onClick={onOpenIndicatorLibrary}
          aria-label="Indicator library"
          className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-slate-700/70 px-2 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
          title="Indicator library — search, categories, active list"
        >
          <Waves className="h-4 w-4" /> Indicators <Plus className="h-3 w-3" />
        </button>
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
            {cfg.type === "volume" && volumeNote ? "Vol · tick/sample" : indicatorLabel(cfg)}
          </button>
          <button onClick={() => onIndicatorToggle(cfg.id)} title={cfg.visible ? "Hide" : "Show"}>
            {cfg.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          </button>
          <button onClick={() => onIndicatorRemove(cfg.id)} title="Remove" className="hover:text-red-400">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {/* P77 user request — the Add-alert button is gone; Bar replay owns this spot */}
      <div className="mx-1 h-5 w-px bg-slate-800" />
      {/* P77 user request — the Bar replay icon glows GOLD so the entry point
          stands out from the ordinary gray tools */}
      <ToolButton title="Bar replay" onClick={onOpenReplay}><Rewind className="h-4 w-4 text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.65)]" /></ToolButton>

      {/* undo / redo drawings */}
      <div className="mx-1 h-5 w-px bg-slate-800" />
      <ToolButton title="Undo drawing (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}><Undo2 className="h-4 w-4" /></ToolButton>
      <ToolButton title="Redo drawing (Ctrl+Y)" onClick={onRedo} disabled={!canRedo}><Redo2 className="h-4 w-4" /></ToolButton>

      {/* right cluster — Phase 34b: chart theme dropdown leads it */}
      <div className="ml-auto flex items-center gap-0.5">
        {/* P64R4 user request — BACKGROUND sits to the LEFT of the theme
            (palette) icon: VIP-only image behind the candles. */}
        <div ref={bgRef} className="relative">
          <ToolButton title="Chart background" active={bgOpen} onClick={() => setBgOpen((v) => !v)}><ImageIcon className="h-4 w-4" /></ToolButton>
          {bgOpen && (
            <div className="absolute right-0 top-7 z-40 w-44 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
              <p className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400">
                Background {!bgIsVip && <Lock className="h-3 w-3" />}
              </p>
              {[
                { id: "", label: "None" },
                { id: "/backgrounds/skywalker.jpg", label: "Skywalker" },
                { id: "/backgrounds/knight.jpg", label: "Knight ✦" },
              ].map((o) => {
                const active = readBgImage() === o.id;
                return (
                  <button
                    key={o.label}
                    onClick={() => {
                      setBgOpen(false);
                      if (!bgIsVip) {
                        toast({ title: "VIP background", description: "Chart backgrounds are part of Premium — unlock on the Premium page." });
                        navigate("/premium");
                        return;
                      }
                      applyBgImage(o.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-slate-800",
                      active ? "bg-slate-800 text-primary" : "text-slate-300",
                    )}
                  >
                    {o.id
                      ? <img src={o.id} alt="" className="h-4 w-7 shrink-0 rounded-sm border border-slate-700 object-cover" />
                      : <span className="h-4 w-7 shrink-0 rounded-sm border border-slate-700 bg-slate-800" />}
                    {o.label}
                  </button>
                );
              })}
              <p className="px-2 pb-1 pt-1 text-[9px] leading-snug text-slate-500">VIP only — image behind the candles</p>
            </div>
          )}
        </div>
        <div ref={themeRef} className="relative">
          <ToolButton title="Chart theme" active={themeOpen} onClick={() => setThemeOpen((v) => !v)}><Palette className="h-4 w-4" /></ToolButton>
          {themeOpen && (
            <div className="absolute right-0 top-7 z-40 w-44 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
              {APPEARANCE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { applyPreset(p.s); setThemeOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-slate-300 hover:bg-slate-800"
                >
                  {/* the theme's BACKGROUND is part of the preset — show it */}
                  <span className="relative h-4 w-7 shrink-0 overflow-hidden rounded-sm border border-slate-700" style={{ background: p.s.bgColor }}>
                    <span className="absolute left-1 top-0.5 h-3 w-1.5 rounded-[1px]" style={{ background: p.s.upColor }} />
                    <span className="absolute right-1 top-1 h-2.5 w-1.5 rounded-[1px]" style={{ background: p.s.downColor }} />
                  </span>
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <ToolButton title="Screenshot (PNG)" onClick={onScreenshot}><Camera className="h-4 w-4" /></ToolButton>
        <ToolButton title="General settings" onClick={onOpenSettings}><Settings className="h-4 w-4" /></ToolButton>
        <ToolButton title="Chart layouts" onClick={onOpenLayouts}><LayoutTemplate className="h-4 w-4" /></ToolButton>
        <ToolButton title="Reset chart view" onClick={onReset}><RotateCcw className="h-4 w-4" /></ToolButton>
        <ToolButton title="Fullscreen" onClick={onFullscreen}><Maximize2 className="h-4 w-4" /></ToolButton>
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

function ToolButton({ title, onClick, disabled, children, active }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 w-8 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 ${active ? "bg-sky-600/80 text-white hover:bg-sky-600 hover:text-white" : ""} ${disabled ? "opacity-30 hover:bg-transparent hover:text-slate-400" : ""}`}
    >
      {children}
    </button>
  );
}

// re-export for the params dialog in dialogs.tsx
export { SlidersHorizontal };
