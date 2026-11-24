/**
 * DrawingPropsBar — floating properties toolbar for the SELECTED drawing
 * (TradingView-style): color, width, dash, fill, attached text (color · size
 · position), line extension, endpoint labels, Fibonacci level toggles,
 * TIMEFRAME VISIBILITY grid, per-anchor coordinate editing, and object
 * actions (duplicate / lock / hide / delete).
 */
import { useState } from "react";
import { RotateCcw, Copy, Lock, LockOpen, Eye, EyeOff, Trash2, PenLine, Save } from "lucide-react";
import { ColorPicker } from "./ColorPicker";
import { DEFAULT_STYLE,
  FIB_TOOLS, levelsFor, FIB_DEFAULT_LEVELS,
  isPositionTool, positionCalc, fmtPositionPrice, snapToTick,
  type Drawing, type DrawingType, type DrawingRenderEnv, type FibLevel, TEXT_LIKE} from "@/lib/drawings";
import { TIMEFRAMES, type Timeframe } from "@shared/terminal";
import type { FibPreset } from "@/lib/chart-persistence";
import { cn } from "@/lib/utils";

const SHAPE_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>([
  // P39 §9 — ONLY tools whose renderer actually applies style.fill; the fill
  // slider used to show for long/short/polyline where it did nothing
  "rect", "rrect", "triangle", "circle", "ellipse", "channel", "hchannel", "dchannel",
  "price-range", "date-range", "datetime-range",
]);

/** P44 §2 — tools that carry their own text styling controls */

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
  drawing, onChange, onDuplicate, onDelete, onEditText,
  fibPresets, onSaveFibPreset, onDeleteFibPreset,
  positionEnv, onSetDefault,
}: {
  drawing: Drawing;
  onChange: (patch: Partial<Drawing>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEditText: () => void;
  /** Phase 37 §5 — the user's saved Fibonacci presets */
  fibPresets?: FibPreset[];
  onSaveFibPreset?: (name: string, levels: FibLevel[]) => void;
  onDeleteFibPreset?: (name: string) => void;
  /** P41 — instrument metadata + live balance for the position panel */
  positionEnv?: DrawingRenderEnv;
  /** P44 §5 — persist the current style as this tool's default */
  onSetDefault?: () => void;
}) {
  const isFib = FIB_TOOLS.has(drawing.type);
  const [presetName, setPresetName] = useState("");
  const isTrend = drawing.type === "trend";
  const levels = levelsFor(drawing);
  const style = drawing.style;
  const tfs = drawing.tfs ?? [];
  // P41 §4/§5 — live position math (instrument metadata + real balance)
  const isPosition = isPositionTool(drawing.type);
  const posDigits = positionEnv?.digits ?? 2;
  const posCalc = positionCalc(
    drawing.points[0]?.price ?? 0,
    drawing.points[1]?.price ?? 0,
    drawing.points[2]?.price ?? 0,
    positionEnv && positionEnv.contractSize
      ? { digits: posDigits, pipSize: positionEnv.pipSize ?? 0, contractSize: positionEnv.contractSize }
      : undefined,
    positionEnv?.balance,
    drawing.riskPct,
  );

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
    <div data-chart-ui className="pointer-events-auto absolute bottom-3 left-1/2 z-30 max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900/95 px-2 py-1.5 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {/* P44 §1 — TradingView-style compact color picker */}
        <ColorPicker
          value={style.color || DEFAULT_STYLE.color}
          title="Line color"
          onChange={(c) => setStyle({ color: c })}
        />
        <span className="h-4 w-px bg-slate-700" />
        {/* width */}
        <div className="flex items-center gap-0.5" title="Line thickness">
          {[1, 2, 3, 4].map((w) => (
            <button
              key={w}
              onClick={() => setStyle({ width: w })}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded",
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
        {/* P39 §1 — per-drawing transparency, honored by every renderer */}
        <label className="flex items-center gap-1 text-slate-400" title="Transparency">
          <span>Op</span>
          <input
            type="range" min={0.15} max={1} step={0.05}
            value={style.opacity ?? 1}
            onChange={(e) => setStyle({ opacity: Number(e.target.value) })}
            className="h-3 w-14 accent-sky-500"
          />
        </label>
        {/* P39 §9 — reset to defaults */}
        <button
          title="Reset style to defaults"
          onClick={() => setStyle({ ...DEFAULT_STYLE })}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        {/* P44 §5 — save this style as the per-tool default (Firebase-backed) */}
        {onSetDefault && (
          <button
            title={`Save this style as the default for new ${drawing.type} objects`}
            onClick={onSetDefault}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-sky-500/15 hover:text-sky-300"
          >
            <Save className="h-4 w-4" />
          </button>
        )}
        {/* fill for shapes */}
        {SHAPE_TOOLS.has(drawing.type) && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            <ColorPicker
              value={style.fill?.color ?? style.color ?? DEFAULT_STYLE.color}
              title="Fill color"
              onChange={(c) => setStyle({ fill: { color: c, opacity: style.fill?.opacity ?? 0.15 } })}
            />
            <label className="flex items-center gap-1 text-slate-400" title="Fill opacity">
              <span>Fill</span>
              <input
                type="range" min={0} max={0.4} step={0.02}
                value={style.fill?.opacity ?? 0}
                onChange={(e) => {
                  const opacity = Number(e.target.value);
                  setStyle({ fill: opacity > 0 ? { color: style.fill?.color ?? style.color, opacity } : undefined });
                }}
                className="h-3 w-14 accent-sky-500"
              />
            </label>
          </>
        )}
        {/* P41 — position tools: level prices, risk %, calculations */}
        {isPosition && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            {(["Entry", "Stop", "Target"] as const).map((lbl, i) => (
              <label key={lbl} className="flex items-center gap-0.5" title={`${lbl} price`}>
                <span className={cn("font-semibold", i === 0 ? "text-slate-300" : i === 1 ? "text-red-400" : "text-emerald-400")}>{lbl}</span>
                <input
                  type="number"
                  step="any"
                  value={drawing.points[i]?.price ?? 0}
                  onChange={(e) => {
                    // Phase 59: Number("") === 0 used to COMMIT a level of 0 —
                    // the risk math collapsed and the zero persisted to RTDB.
                    // An empty/transient field keeps the previous level.
                    const raw = e.target.value.trim();
                    if (!raw || !drawing.points[i]) return;
                    const v = Number(raw);
                    if (!Number.isFinite(v) || v <= 0) return;
                    // P46 §1.4 — every level lands on the instrument tick
                    const snapped = snapToTick(v, positionEnv?.tickSize);
                    onChange({ points: drawing.points.map((q, k) => (k === i ? { ...q, price: snapped } : q)) });
                  }}
                  className="h-5 w-20 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200 tabular-nums"
                />
              </label>
            ))}
            <label className="flex items-center gap-0.5" title="Risk % — the position is sized so a stop-out loses this share of the balance">
              <span className="text-slate-400">Risk%</span>
              <input
                type="number" min={0.01} max={100} step={0.05}
                value={drawing.riskPct ?? 1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) onChange({ riskPct: Math.min(100, v) });
                }}
                className="h-5 w-12 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200 tabular-nums"
              />
            </label>
            <details className="relative">
              <summary className="cursor-pointer list-none rounded px-1 text-slate-400 hover:bg-slate-800" title="Position calculations & zone colors">
                {posCalc.rr.toFixed(1)}R
              </summary>
              <div className="absolute bottom-6 left-0 z-40 w-72 rounded-lg border border-slate-700 bg-slate-900/97 p-2 text-slate-300 shadow-2xl">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
                  <span className="text-slate-500">Entry</span><span>{fmtPositionPrice(posCalc.entry, posDigits)}</span>
                  <span className="text-red-400">Stop</span><span>{fmtPositionPrice(posCalc.stop, posDigits)}</span>
                  <span className="text-emerald-400">Target</span><span>{fmtPositionPrice(posCalc.target, posDigits)}</span>
                  <span className="text-slate-500">Risk dist</span><span>{fmtPositionPrice(posCalc.riskDist, posDigits)} ({posCalc.riskPctOfPrice.toFixed(2)}%)</span>
                  <span className="text-slate-500">Reward dist</span><span>{fmtPositionPrice(posCalc.rewardDist, posDigits)} ({posCalc.rewardPctOfPrice.toFixed(2)}%)</span>
                  <span className="text-slate-500">R:R</span><span>1 : {posCalc.rr.toFixed(2)}</span>
                  <span className="text-slate-500">Balance</span>
                  <span>{positionEnv?.balance != null ? `$${positionEnv.balance.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—"}</span>
                  <span className="text-slate-500">Size</span><span>{posCalc.lots != null ? `${posCalc.lots.toFixed(2)} lots` : "—"}</span>
                  <span className="text-slate-500">Loss @ stop</span><span>{posCalc.riskAmount != null ? `$${posCalc.riskAmount.toFixed(2)}` : "—"}</span>
                  <span className="text-slate-500">Gain @ target</span><span>{posCalc.rewardAmount != null ? `$${posCalc.rewardAmount.toFixed(2)}` : "—"}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <label className="flex items-center gap-1.5" title="Take-profit zone color">
                    <span className="text-slate-500">Profit</span>
                    <ColorPicker value={style.profitColor || "#22c55e"} title="Take-profit zone color" onChange={(c) => setStyle({ profitColor: c })} />
                  </label>
                  <label className="flex items-center gap-1.5" title="Stop-loss zone color">
                    <span className="text-slate-500">Loss</span>
                    <ColorPicker value={style.lossColor || "#ef4444"} title="Stop-loss zone color" onChange={(c) => setStyle({ lossColor: c })} />
                  </label>
                  <label className="flex items-center gap-1" title="Zone opacity">
                    <span className="text-slate-500">Zones</span>
                    <input
                      type="range" min={0.05} max={0.4} step={0.01}
                      value={style.fill?.opacity ?? 0.16}
                      onChange={(e) => setStyle({ fill: { color: style.fill?.color ?? style.color, opacity: Number(e.target.value) } })}
                      className="h-3 w-14 accent-sky-500"
                    />
                  </label>
                  <ToggleBtn label="Labels" on={style.showLabels !== false} onClick={() => setStyle({ showLabels: style.showLabels === false ? undefined : false })} />
                  {/* PHASE 65 §3 — verbose stats (%/pips/lots/$) are off the
                      chart by default; this toggle brings them back */}
                  <ToggleBtn label="Stats" on={style.showStats === true} onClick={() => setStyle({ showStats: style.showStats === true ? undefined : true })} />
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                  Size derives from the instrument's contract size and the live balance so a stop-out loses
                  the Risk% — no invented figures; "—" means metadata/balance is unavailable.
                </p>
              </div>
            </details>
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
          </>
        )}
        {/* P44 §2 — text styling only for text-bearing tools (relevant
            controls only; other drawings keep any previously-set label).
            PHASE 65 §4 — the annotation INPUT itself is universal: every
            drawing can carry a description from the properties bar. */}
        <span className="h-4 w-px bg-slate-700" />
        <input
          value={drawing.text ?? ""}
          onChange={(e) => onChange({ text: e.target.value.slice(0, 200) || undefined })}
          placeholder="Label…"
          title="Annotation — moves with the drawing"
          className="h-5 w-24 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200 placeholder:text-slate-500"
        />
        {/* P66 §2 — the text-styling controls now cover the trend family as
            well (label position left/center/right · above/below), so a
            trendline's label can be placed like TradingView's */}
        {(TEXT_LIKE.has(drawing.type) || isTrend) && (
        <>
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
          onChange={(e) => setStyle({ textPos: e.target.value as "start" | "center" | "end" | "above" | "below" })}
          className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
        >
          <option value="start">Left end</option>
          <option value="center">Center</option>
          <option value="end">Right end</option>
          <option value="above">Above middle</option>
          <option value="below">Below middle</option>
        </select>
        <select
          title="Text weight"
          value={style.fontWeight || "normal"}
          onChange={(e) => setStyle({ fontWeight: e.target.value as "normal" | "bold" })}
          className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
        >
          <option value="normal">Normal</option>
          <option value="bold">Bold</option>
        </select>
        <select
          title="Text alignment"
          value={style.textAlign || "left"}
          onChange={(e) => setStyle({ textAlign: e.target.value as "left" | "center" | "right" })}
          className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
        <input
          type="color"
          title="Text background"
          value={style.textBg || "#0f172a"}
          onChange={(e) => setStyle({ textBg: e.target.value })}
          className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <button title="Edit text" onClick={onEditText} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
          <PenLine className="h-4 w-4" />
        </button>
        </>
        )}

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
                  {/* PHASE 65 §3 — verbose stats (%/pips/lots/$) are off the
                      chart by default; this toggle brings them back */}
                  <ToggleBtn label="Stats" on={style.showStats === true} onClick={() => setStyle({ showStats: style.showStats === true ? undefined : true })} />
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
                    <select
                      value={lvl.width ?? ""}
                      title="Level line width"
                      onChange={(e) => setLevel(i, { ...lvl, width: e.target.value ? Number(e.target.value) : undefined })}
                      className="h-5 rounded border border-slate-700 bg-slate-950 text-[10px]"
                    >
                      <option value="">—</option>
                      <option value="1">1px</option>
                      <option value="2">2px</option>
                      <option value="3">3px</option>
                    </select>
                    <ColorPicker
                      value={lvl.color || style.color}
                      title="Level color"
                      align="right"
                      onChange={(c) => setLevel(i, { ...lvl, color: c })}
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
                {/* P44 §4 — custom Fibonacci templates (per user, Firebase) */}
                {onSaveFibPreset && (
                  <div className="mt-1.5 border-t border-slate-800 pt-1.5">
                    {fibPresets && fibPresets.length > 0 && (
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
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      <input
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value.slice(0, 32))}
                        placeholder="Preset name…"
                        className="num-input h-6 min-w-0 flex-1 px-1 text-[10px]"
                      />
                      <button
                        disabled={!presetName.trim()}
                        onClick={() => { onSaveFibPreset(presetName.trim(), baseLevels); setPresetName(""); }}
                        className="h-6 shrink-0 rounded bg-sky-600 px-2 text-[10px] font-semibold text-white disabled:opacity-40"
                      >Save</button>
                      {fibPresets && fibPresets.length > 0 && onDeleteFibPreset && (
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) { onDeleteFibPreset(e.target.value); } }}
                          className="h-6 rounded border border-red-900/50 bg-slate-950 text-[10px] text-red-400"
                        >
                          <option value="">Delete…</option>
                          {fibPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
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
                      const raw = e.target.value.trim();
                      if (!raw) return; // Phase 59: "" must not become 0
                      const price = Number(raw);
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
        {/* object actions — P46: z-order buttons removed per user request;
            reorder lives in the object-tree context menu (front/back) */}
        <button title="Duplicate" onClick={onDuplicate} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
          <Copy className="h-4 w-4" />
        </button>
        <button
          title={drawing.locked ? "Unlock" : "Lock"}
          onClick={() => onChange({ locked: !drawing.locked })}
          className={cn("flex h-6 w-6 items-center justify-center rounded hover:bg-slate-800", drawing.locked ? "text-amber-400" : "text-slate-400 hover:text-slate-200")}
        >
          {drawing.locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
        </button>
        <button
          title={drawing.hidden ? "Show" : "Hide"}
          onClick={() => onChange({ hidden: !drawing.hidden })}
          className={cn("flex h-6 w-6 items-center justify-center rounded hover:bg-slate-800", drawing.hidden ? "text-amber-400" : "text-slate-400 hover:text-slate-200")}
        >
          {drawing.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        <button title="Delete" onClick={onDelete} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-red-500/15 hover:text-red-400">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
