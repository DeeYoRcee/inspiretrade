/**
 * ChartSettingsDialog — TradingView-style chart settings for the terminal.
 * Five tabs (Canvas / Scales / Symbol / Crosshair / Status) over the
 * ChartPrefs object that lives in TerminalSettings.chartPrefs — every change
 * applies to ALL chart slots instantly and persists (localStorage + RTDB).
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_CHART_PREFS, type ChartPrefs, type LineStyleKind } from "./TerminalChart";

const LINE_STYLES: { id: LineStyleKind; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "dashed", label: "Dashed" },
  { id: "dotted", label: "Dotted" },
  { id: "large-dashed", label: "Large dashed" },
  { id: "sparse-dotted", label: "Sparse dotted" },
];

const TABS = [
  { id: "canvas", label: "Canvas" },
  { id: "scales", label: "Scales" },
  { id: "symbol", label: "Symbol" },
  { id: "crosshair", label: "Crosshair" },
  { id: "status", label: "Status" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ChartSettingsDialog({
  open, onOpenChange, prefs, onChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  prefs: ChartPrefs;
  onChange: (patch: Partial<ChartPrefs>) => void;
}) {
  const [tab, setTab] = useState<TabId>("canvas");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-xl border-border/60 bg-card sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Chart settings</DialogTitle>
        </DialogHeader>

        {/* tab strip */}
        <div className="flex gap-1 overflow-x-auto rounded-lg bg-background/60 p-1">
          {TABS.map((x) => (
            <button
              key={x.id}
              onClick={() => setTab(x.id)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
                tab === x.id ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="space-y-2.5 pb-1">
          {tab === "canvas" && (
            <>
              <Hint>Grid color follows the chart theme (Themes tool). Grid style applies to both axes.</Hint>
              <Toggle label="Vertical grid lines" on={prefs.gridVert} onToggle={() => onChange({ gridVert: !prefs.gridVert })} />
              <Toggle label="Horizontal grid lines" on={prefs.gridHorz} onToggle={() => onChange({ gridHorz: !prefs.gridHorz })} />
              <SelectRow label="Grid line style" value={prefs.gridStyle} options={LINE_STYLES} onPick={(v) => onChange({ gridStyle: v })} />
              <SliderRow label="Empty space above" value={Math.round(prefs.marginTop * 100)} min={0} max={50} suffix="%"
                onCommit={(v) => onChange({ marginTop: v / 100 })} />
              <SliderRow label="Empty space below" value={Math.round(prefs.marginBottom * 100)} min={0} max={50} suffix="%"
                onCommit={(v) => onChange({ marginBottom: v / 100 })} />
            </>
          )}

          {tab === "scales" && (
            <>
              <Toggle label="Right price scale" on={prefs.priceScale} onToggle={() => onChange({ priceScale: !prefs.priceScale })} />
              <Toggle label="Left price scale (mirror)" on={prefs.leftScale} onToggle={() => onChange({ leftScale: !prefs.leftScale })} />
              <Toggle label="Time scale (bottom axis)" on={prefs.timeScale} onToggle={() => onChange({ timeScale: !prefs.timeScale })} />
              <Hint>Double-click an axis to reset the zoom, drag it to scale — like TradingView.</Hint>
            </>
          )}

          {tab === "symbol" && (
            <>
              <Toggle label="Candle body borders" on={prefs.candleBorder} onToggle={() => onChange({ candleBorder: !prefs.candleBorder })} />
              <Toggle label="High/low wicks" on={prefs.candleWick} onToggle={() => onChange({ candleWick: !prefs.candleWick })} />
              <SliderRow label="Volume overlay opacity" value={Math.round(prefs.volumeOpacity * 100)} min={5} max={90} suffix="%"
                onCommit={(v) => onChange({ volumeOpacity: v / 100 })} />
              <Hint>Candle up/down and line colors are set in the Themes tool. Hollow candles always keep their border.</Hint>
            </>
          )}

          {tab === "crosshair" && (
            <>
              <Toggle label="Vertical crosshair" on={prefs.crossVert} onToggle={() => onChange({ crossVert: !prefs.crossVert })} />
              <Toggle label="Horizontal crosshair" on={prefs.crossHorz} onToggle={() => onChange({ crossHorz: !prefs.crossHorz })} />
              <SelectRow label="Crosshair style" value={prefs.crossStyle} options={LINE_STYLES} onPick={(v) => onChange({ crossStyle: v })} />
              <ColorRow label="Crosshair color" value={prefs.crossColor} fallback="#9aa4b2" swatches={["#9aa4b2", "#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#e2e8f0"]}
                onPick={(v) => onChange({ crossColor: v })} />
              <ColorRow label="Axis label background" value={prefs.crossLabelBg} fallback="#1f2937" swatches={["#1f2937", "#2962ff", "#131722", "#4b5563"]}
                onPick={(v) => onChange({ crossLabelBg: v })} />
              <Hint>The magnet toggle in the toolbar snaps the crosshair to OHLC values.</Hint>
            </>
          )}

          {tab === "status" && (
            <>
              <Toggle label="OHLC legend (top bar)" on={prefs.legend} onToggle={() => onChange({ legend: !prefs.legend })} />
              <Toggle label="Bar-close countdown" on={prefs.countdown} onToggle={() => onChange({ countdown: !prefs.countdown })} />
              <TextRow label="Watermark text" value={prefs.watermark} placeholder="e.g. XAUUSD — empty = off"
                onCommit={(v) => onChange({ watermark: v.slice(0, 18) })} />
              <Hint>The watermark renders faintly behind the chart on every slot.</Hint>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 pt-2.5">
          <button
            onClick={() => onChange(DEFAULT_CHART_PREFS)}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
          </button>
          <span className="text-[10px] text-muted-foreground">Saved automatically</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** on/off pill — matches the terminal's toggle look */
function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground hover:border-emerald-500/40"
    >
      <span>{label}</span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-emerald-500/80" : "bg-muted-foreground/30")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
  );
}

function SelectRow({ label, value, options, onPick }: {
  label: string; value: string; options: { id: string; label: string }[];
  onPick: (v: any) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className="w-32 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs outline-none focus:border-emerald-500/50"
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** commit on pointer-up + change so dragging doesn't spam Firebase writes */
function SliderRow({ label, value, min, max, suffix, onCommit }: {
  label: string; value: number; min: number; max: number; suffix: string;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground">
      <div className="mb-1.5 flex items-center justify-between">
        <span>{label}</span>
        <span className="font-number text-muted-foreground">{shown}{suffix}</span>
      </div>
      <input
        type="range" min={min} max={max} step={1} value={shown}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => { if (local != null) { onCommit(local); setLocal(null); } }}
        onKeyUp={() => { if (local != null) { onCommit(local); setLocal(null); } }}
        className="w-full accent-emerald-500"
      />
    </div>
  );
}

function ColorRow({ label, value, fallback, swatches, onPick }: {
  label: string; value: string; fallback: string; swatches: string[];
  onPick: (v: string) => void;
}) {
  const hex = value.startsWith("#") ? value : fallback;
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground">
      <div className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <label className="relative h-6 w-9 shrink-0 cursor-pointer rounded-md border border-border/60" style={{ background: value }}>
          <input
            type="color" value={hex}
            onChange={(e) => onPick(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {swatches.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className={cn("h-5 w-5 rounded-full border", value === s ? "border-emerald-400 ring-1 ring-emerald-500/60" : "border-border/60")}
            style={{ background: s }}
            title={s}
          />
        ))}
      </div>
    </div>
  );
}

function TextRow({ label, value, placeholder, onCommit }: {
  label: string; value: string; placeholder: string; onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  return (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground">
      <span className="shrink-0">{label}</span>
      <input
        value={shown}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft != null) { onCommit(draft.trim()); setDraft(null); } }}
        onKeyDown={(e) => { if (e.key === "Enter" && draft != null) { onCommit(draft.trim()); setDraft(null); } }}
        className="w-40 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs outline-none focus:border-emerald-500/50"
      />
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-sky-300/90">
      {children}
    </p>
  );
}
