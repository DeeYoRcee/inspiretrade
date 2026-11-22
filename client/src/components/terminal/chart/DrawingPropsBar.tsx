/**
 * DrawingPropsBar — floating properties toolbar for the SELECTED drawing
 * (TradingView-style): color, width, dash, fill, attached text (color · size
 · position), line extension, endpoint labels, Fibonacci level toggles,
 * TIMEFRAME VISIBILITY grid, per-anchor coordinate editing, and object
 * actions (duplicate / lock / hide / delete).
 */
import { Copy, Lock, LockOpen, Eye, EyeOff, Trash2, PenLine, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown } from "lucide-react";
import {
  FIB_TOOLS, levelsFor, FIB_DEFAULT_LEVELS,
  type Drawing, type DrawingType, type FibLevel,
} from "@/lib/drawings";
import { TIMEFRAMES, type Timeframe } from "@shared/terminal";
import type { FibPreset } from "@/lib/chart-persistence";
import { cn } from "@/lib/utils";

const COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa", "#e2e8f0", "#14b8a6", "#f472b6"];

const SHAPE_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>([
  "rect", "rrect", "triangle", "circle", "ellipse", "channel", "hchannel", "dchannel",
  "price-range", "date-range", "datetime-range", "long-position", "short-position", "polyline",
]);

const tfLabel = (tf: Timeframe) => (tf === "1W" ? "W1" : tf === "1M" ? "MN" : tf.toUpperCase());

/** Phase 37 §2 — compact on/off pill for the fib display options */
function ToggleBtn({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded border px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
        on ? "border-sky-500/50 bg-sky-500/15 text-sky-300" : "border-slate-700 text-slate-400 hover:text-slate-200",
      )}
    >
      {label}
    </button>
  );
}

export function DrawingPropsBar({
  drawing, onChange, onDuplicate, onDelete, onEditText, onReorder,
  fibPresets, onSaveFibPreset, onDeleteFibPreset,
}: {
  drawing: Drawing;
  onChange: (patch: Partial<Drawing>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Phase 27 §4 — bring forward / send backward (render stack z-order) */
  onReorder?: (action: "front" | "back" | "forward" | "backward") => void;
  onEditText: () => void;
  /** Phase 37 §5 — the user's saved Fibonacci presets */
  fibPresets?: FibPreset[];
  onSaveFibPreset?: (name: string, levels: FibLevel[]) => void;
  onDeleteFibPreset?: (name: string) => void;
}) {
  const isFib = FIB_TOOLS.has(drawing.type);
  const isTrend = drawing.type === "trend";
  const levels = levelsFor(drawing);
  const style = drawing.style;
  const tfs = drawing.tfs ?? [];

  const setStyle = (patch: Partial<Drawing["style"]>) => onChange({ style: { ...style, ...patch } });
  /** effective level list the editor works on (defaults materialized) */
  const baseLevels: FibLevel[] = drawing.levels?.length
    ? drawing.levels.map((x) => ({ ...x }))
    : (FIB_DEFAULT_LEVELS[drawing.type] || [0, 0.5, 1]).map((ratio): FibLevel => ({ ratio, show: true }));
  const setLevel = (i: number, lv: FibLevel) => onChange({ levels: baseLevels.map((x, k) => (k === i ? lv : x)) });
  const toggleTf = (tf: Timeframe) => {
    const cur = new Set(drawing.tfs ?? []);
    if (cur.has(tf)) cur.delete(tf);
    else cur.add(tf);
    const list = TIMEFRAMES.filter((t) => cur.has(t));
    onChange({ tfs: list.length === TIMEFRAMES.length ? undefined : list });
  };

  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900/95 px-2 py-1.5 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {/* color swatches */}
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              title={`Color ${c}`}
              onClick={() => setStyle({ color: c, fill: style.fill ? { ...style.fill, color: c } : undefined })}
              className={cn(
                "h-4 w-4 rounded-full border",
                style.color === c ? "border-white ring-1 ring-white/60" : "border-transparent",
              )}
              style={{ background: c }}
            />
          ))}
          <input
            type="color"
            title="Custom color"
            value={style.color}
            onChange={(e) => setStyle({ color: e.target.value })}
            className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
          />
        </div>
        <span className="h-4 w-px bg-slate-700" />
        {/* width */}
        <div className="flex items-center gap-0.5" title="Line thickness">
          {[1, 2, 3, 4].map((w) => (
            <button
              key={w}
              onClick={() => setStyle({ width: w })}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded",
                style.width === w ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800",
              )}
            >
              <span className="rounded-full bg-current" style={{ height: w, width: w + 4 }} />
            </button>
          ))}
        </div>
        {/* dash */}
        <div className="flex items-center gap-0.5" title="Line style">
          {(["solid", "dashed", "dotted"] as const).map((dash) => (
            <button
              key={dash}
              title={dash}
              onClick={() => setStyle({ dash })}
              className={cn(
                "flex h-5 items-center justify-center rounded px-1",
                style.dash === dash ? "bg-sky-600" : "hover:bg-slate-800",
              )}
            >
              <svg width="16" height="6">
                <line x1="0" y1="3" x2="16" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray={dash === "dashed" ? "4 3" : dash === "dotted" ? "1.5 2.5" : undefined} />
              </svg>
            </button>
          ))}
        </div>
        {/* fill for shapes */}
        {SHAPE_TOOLS.has(drawing.type) && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            <label className="flex items-center gap-1 text-slate-400" title="Fill opacity">
              <span>Fill</span>
              <input
                type="range" min={0} max={0.4} step={0.02}
                value={style.fill?.opacity ?? 0}
                onChange={(e) => {
                  const opacity = Number(e.target.value);
                  setStyle({ fill: opacity > 0 ? { color: style.color, opacity } : undefined });
                }}
                className="h-3 w-14 accent-sky-500"
              />
            </label>
          </>
        )}
        {/* trend extension + endpoint labels */}
        {isTrend && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            <select
              title="Line extension"
              value={style.extend || "none"}
              onChange={(e) => setStyle({ extend: e.target.value as "none" | "right" | "left" | "both" })}
              className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
            >
              <option value="none">Segment</option>
              <option value="left">Extend left</option>
              <option value="right">Extend right (ray)</option>
              <option value="both">Extend both (infinite)</option>
            </select>
            <button
              title="Toggle endpoint price labels"
              onClick={() => setStyle({ showLabels: !style.showLabels })}
              className={cn("rounded px-1.5 py-0.5", style.showLabels ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800")}
            >
              $
            </button>
            <button
              title="Toggle price change + percentage label"
              onClick={() => setStyle({ showPrices: !style.showPrices })}
              className={cn("rounded px-1.5 py-0.5", style.showPrices ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800")}
            >
              Δ
            </button>
            <button
              title="Toggle endpoint time labels"
              onClick={() => setStyle({ showTimeLabels: !style.showTimeLabels })}
              className={cn("rounded px-1.5 py-0.5", style.showTimeLabels ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800")}
            >
              T
            </button>
          </>
        )}
        {/* attached text — every drawing can carry a label that moves with it */}
        <span className="h-4 w-px bg-slate-700" />
        <input
          value={drawing.text ?? ""}
          onChange={(e) => onChange({ text: e.target.value.slice(0, 200) || undefined })}
          placeholder="Label…"
          className="h-5 w-24 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200 placeholder:text-slate-500"
        />
        <input
          type="color"
          title="Text color"
          value={style.textColor || style.color}
          onChange={(e) => setStyle({ textColor: e.target.value })}
          className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <select
          title="Text size"
          value={style.fontSize}
          onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}
          className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
        >
          {[10, 12, 14, 16, 20, 24].map((s) => <option key={s} value={s}>{s}px</option>)}
        </select>
        <select
          title="Text position"
          value={style.textPos || "start"}
          onChange={(e) => setStyle({ textPos: e.target.value as "start" | "end" | "above" | "below" })}
          className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
        >
          <option value="start">At start</option>
          <option value="end">At end</option>
          <option value="above">Above middle</option>
          <option value="below">Below middle</option>
        </select>
        <button title="Edit text" onClick={onEditText} className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
          <PenLine className="h-3.5 w-3.5" />
        </button>

        {/* Fibonacci level toggles */}
        {isFib && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            <details className="relative">
              <summary className="cursor-pointer list-none rounded px-1 text-slate-400 hover:bg-slate-800" title="Fibonacci levels">Levels ({levels.filter((l) => l.show).length})</summary>
              <div className="absolute bottom-6 left-0 z-40 w-64 rounded-lg border border-slate-700 bg-slate-900/97 p-2 shadow-2xl">
                {/* Phase 37 §2 — display options */}
                <div className="mb-1.5 flex flex-wrap gap-1">
                  <ToggleBtn label="Labels" on={style.showLabels !== false} onClick={() => setStyle({ showLabels: style.showLabels === false ? undefined : false })} />
                  <ToggleBtn label="Prices" on={style.showPrices === true} onClick={() => setStyle({ showPrices: style.showPrices === true ? undefined : true })} />
                  <ToggleBtn label="Extend" on={style.extend === "right" || style.extend === "both"} onClick={() => setStyle({ extend: style.extend === "right" || style.extend === "both" ? undefined : "right" })} />
                  <ToggleBtn label="Reverse" on={style.reverse === true} onClick={() => setStyle({ reverse: style.reverse === true ? undefined : true })} />
                </div>
                {baseLevels.map((lvl, i) => (
                  <div key={`${lvl.ratio}-${i}`} className="flex items-center gap-1.5 py-0.5 text-slate-300">
                    <input
                      type="checkbox"
                      checked={lvl.show}
                      title={lvl.show ? "Hide level" : "Show level"}
                      onChange={(e) => setLevel(i, { ...lvl, show: e.target.checked })}
                      className="accent-sky-500"
                    />
                    <input
                      type="number" step={0.001} min={-10} max={100}
                      value={lvl.ratio}
                      title="Level ratio — multiple of the measured span"
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) setLevel(i, { ...lvl, ratio: v });
                      }}
                      className="num-input w-14 px-1 py-0.5 text-right text-[10px]"
                    />
                    <select
                      value={lvl.dash ?? ""}
                      title="Level line style"
                      onChange={(e) => setLevel(i, { ...lvl, dash: (e.target.value || undefined) as FibLevel["dash"] })}
                      className="h-5 rounded border border-slate-700 bg-slate-950 text-[10px]"
                    >
                      <option value="">—</option>
                      <option value="solid">solid</option>
                      <option value="dashed">dash</option>
                      <option value="dotted">dot</option>
                    </select>
                    <input
                      type="color"
                      value={lvl.color || style.color}
                      title="Level color"
                      onChange={(e) => setLevel(i, { ...lvl, color: e.target.value })}
                      className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                    <button
                      title="Remove level"
                      onClick={() => onChange({ levels: baseLevels.filter((_, k) => k !== i) })}
                      className="text-[10px] text-slate-500 hover:text-red-400"
                    >✕</button>
                  </div>
                ))}
                <div className="mt-1 flex items-center justify-between">
                  <button
                    onClick={() => onChange({ levels: [...baseLevels, { ratio: 0.886, show: true }] })}
                    className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300"
                  >+ Add level</button>
                  <button onClick={() => onChange({ levels: undefined })} className="text-[10px] text-slate-500 hover:text-slate-300">
                    Reset to defaults
                  </button>
                </div>
                {/* Phase 37 §5 — custom Fibonacci presets (per user) */}
                {fibPresets && fibPresets.length > 0 && (
                  <div className="mt-1.5 border-t border-slate-800 pt-1.5">
                    <select
                      value=""
                      onChange={(e) => {
                        const preset = fibPresets.find((x) => x.name === e.target.value);
                        if (preset) onChange({ levels: preset.levels.map((l) => ({ ...l })) });
                      }}
                      className="h-6 w-full rounded border border-slate-700 bg-slate-950 text-[10px] text-slate-300"
                    >
                      <option value="">Apply preset…</option>
                      {fibPresets.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.levels.length})</option>)}
                    </select>
                    <div className="mt-1 flex justify-between">
                      <button
                        onClick={() => {
                          const name = window.prompt("Preset name", drawing.type);
                          if (name?.trim()) onSaveFibPreset?.(name.trim(), baseLevels);
                        }}
                        className="text-[10px] font-semibold text-sky-400 hover:text-sky-300"
                      >Save current as preset</button>
                      <button
                        onClick={() => {
                          const name = window.prompt("Delete which preset?", fibPresets[0]?.name || "");
                          if (name?.trim()) onDeleteFibPreset?.(name.trim());
                        }}
                        className="text-[10px] text-red-400 hover:text-red-300"
                      >Delete preset</button>
                    </div>
                  </div>
                )}
                {(!fibPresets || fibPresets.length === 0) && onSaveFibPreset && (
                  <button
                    onClick={() => {
                      const name = window.prompt("Preset name", drawing.type);
                      if (name?.trim()) onSaveFibPreset(name.trim(), baseLevels);
                    }}
                    className="mt-1.5 block text-[10px] font-semibold text-sky-400 hover:text-sky-300"
                  >Save levels as preset</button>
                )}
              </div>
            </details>
          </>
        )}

        {/* timeframe visibility — empty selection = visible on EVERY timeframe */}
        <span className="h-4 w-px bg-slate-700" />
        <details className="relative">
          <summary
            className="cursor-pointer list-none rounded px-1 text-slate-400 hover:bg-slate-800"
            title="Timeframe visibility — which timeframes show this object"
          >
            TF {tfs.length ? `(${tfs.length})` : "(all)"}
          </summary>
          <div className="absolute bottom-6 right-0 z-40 w-56 rounded-lg border border-slate-700 bg-slate-900/97 p-2 shadow-2xl">
            <p className="mb-1 text-[10px] text-slate-500">Visible on timeframes — empty = all</p>
            <div className="grid grid-cols-4 gap-1">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => toggleTf(tf)}
                  className={cn(
                    "rounded px-1 py-0.5 text-[10px] font-semibold transition-colors",
                    (!drawing.tfs?.length || drawing.tfs.includes(tf))
                      ? "bg-sky-600 text-white"
                      : "bg-slate-800 text-slate-400 hover:bg-slate-700",
                  )}
                >
                  {tfLabel(tf)}
                </button>
              ))}
            </div>
            {drawing.tfs?.length ? (
              <button onClick={() => onChange({ tfs: undefined })} className="mt-1 text-[10px] text-slate-500 hover:text-slate-300">
                Show on all timeframes
              </button>
            ) : null}
          </div>
        </details>

        {/* per-anchor coordinate editor */}
        <details className="relative">
          <summary className="cursor-pointer list-none rounded px-1 text-slate-400 hover:bg-slate-800" title="Edit anchor coordinates">XY</summary>
          <div className="absolute bottom-6 right-0 z-40 max-h-64 w-64 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/97 p-2 shadow-2xl">
            {drawing.points.map((pt, i) => {
              const dt = new Date(pt.time * 1000);
              const pad = (n: number) => String(n).padStart(2, "0");
              const local = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
              return (
                <div key={i} className="mb-1 border-b border-slate-800 pb-1 text-[10px] text-slate-400">
                  <span className="mr-1 font-semibold">P{i}</span>
                  <input
                    type="number"
                    value={pt.price}
                    step="any"
                    title="Anchor price"
                    onChange={(e) => {
                      const price = Number(e.target.value);
                      if (!Number.isFinite(price)) return;
                      onChange({ points: drawing.points.map((q, k) => (k === i ? { ...q, price } : q)) });
                    }}
                    className="ml-1 w-24 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-slate-200"
                  />
                  <input
                    type="datetime-local"
                    value={local}
                    title="Anchor time (local)"
                    onChange={(e) => {
                      const ms = new Date(e.target.value).getTime();
                      if (!Number.isFinite(ms)) return;
                      onChange({ points: drawing.points.map((q, k) => (k === i ? { ...q, time: Math.floor(ms / 1000) } : q)) });
                    }}
                    className="ml-1 w-40 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-slate-200"
                  />
                </div>
              );
            })}
          </div>
        </details>

        <span className="h-4 w-px bg-slate-700" />
        {/* object actions */}
        <button title="Duplicate" onClick={onDuplicate} className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          title={drawing.locked ? "Unlock" : "Lock"}
          onClick={() => onChange({ locked: !drawing.locked })}
          className={cn("flex h-5 w-5 items-center justify-center rounded hover:bg-slate-800", drawing.locked ? "text-amber-400" : "text-slate-400 hover:text-slate-200")}
        >
          {drawing.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        </button>
        <button
          title={drawing.hidden ? "Show" : "Hide"}
          onClick={() => onChange({ hidden: !drawing.hidden })}
          className={cn("flex h-5 w-5 items-center justify-center rounded hover:bg-slate-800", drawing.hidden ? "text-amber-400" : "text-slate-400 hover:text-slate-200")}
        >
          {drawing.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        {onReorder && (
          <>
            <button
              title="Bring forward"
              onClick={() => onReorder("forward")}
              className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              title="Send backward"
              onClick={() => onReorder("backward")}
              className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              title="Bring to front"
              onClick={() => onReorder("front")}
              className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <ChevronsUp className="h-3.5 w-3.5" />
            </button>
            <button
              title="Send to back"
              onClick={() => onReorder("back")}
              className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <ChevronsDown className="h-3.5 w-3.5" />
            </button>
            <span className="h-4 w-px bg-slate-700" />
          </>
        )}
        <button title="Delete" onClick={onDelete} className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-red-500/15 hover:text-red-400">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
