/**
 * DrawingPropsBar — floating properties toolbar for the SELECTED drawing
 * (TradingView-style): color, width, dash, fill, text size, Fibonacci level
 * toggles, and object actions (duplicate / lock / hide / delete).
 * Imperative positioning — a bar at the bottom-center of the chart area.
 */
import {
  Copy, Lock, LockOpen, Eye, EyeOff, Trash2, PenLine,
} from "lucide-react";
import {
  FIB_TOOLS, levelsFor, FIB_DEFAULT_LEVELS,
  type Drawing, type DrawingType, type FibLevel,
} from "@/lib/drawings";
import { cn } from "@/lib/utils";

const COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa", "#e2e8f0", "#14b8a6", "#f472b6"];

const SHAPE_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>([
  "rect", "rrect", "triangle", "circle", "ellipse", "channel", "hchannel", "dchannel",
  "price-range", "date-range", "datetime-range", "long-position", "short-position", "polyline",
]);
const TEXT_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>([
  "text", "anchored-text", "note", "price-note", "signpost", "comment", "flag", "callout",
]);

export function DrawingPropsBar({
  drawing, onChange, onDuplicate, onDelete, onEditText,
}: {
  drawing: Drawing;
  onChange: (patch: Partial<Drawing>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEditText: () => void;
}) {
  const isFib = FIB_TOOLS.has(drawing.type);
  const levels = levelsFor(drawing);
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900/95 px-2 py-1.5 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {/* color swatches */}
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              title={`Color ${c}`}
              onClick={() => onChange({ style: { ...drawing.style, color: c } })}
              className={cn(
                "h-4 w-4 rounded-full border",
                drawing.style.color === c ? "border-white ring-1 ring-white/60" : "border-transparent",
              )}
              style={{ background: c }}
            />
          ))}
          <input
            type="color"
            title="Custom color"
            value={drawing.style.color}
            onChange={(e) => onChange({ style: { ...drawing.style, color: e.target.value } })}
            className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
          />
        </div>
        <span className="h-4 w-px bg-slate-700" />
        {/* width */}
        <div className="flex items-center gap-0.5" title="Line thickness">
          {[1, 2, 3, 4].map((w) => (
            <button
              key={w}
              onClick={() => onChange({ style: { ...drawing.style, width: w } })}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded",
                drawing.style.width === w ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800",
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
              onClick={() => onChange({ style: { ...drawing.style, dash } })}
              className={cn(
                "flex h-5 items-center justify-center rounded px-1",
                drawing.style.dash === dash ? "bg-sky-600" : "hover:bg-slate-800",
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
                value={drawing.style.fill?.opacity ?? 0}
                onChange={(e) => {
                  const opacity = Number(e.target.value);
                  onChange({ style: { ...drawing.style, fill: opacity > 0 ? { color: drawing.style.color, opacity } : undefined } });
                }}
                className="h-3 w-14 accent-sky-500"
              />
              <span className="font-number w-8 text-slate-300">
                {Math.round((drawing.style.fill?.opacity ?? 0) * 250)}%
              </span>
            </label>
          </>
        )}
        {/* text size + edit */}
        {TEXT_TOOLS.has(drawing.type) && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            <select
              title="Text size"
              value={drawing.style.fontSize}
              onChange={(e) => onChange({ style: { ...drawing.style, fontSize: Number(e.target.value) } })}
              className="h-5 rounded border border-slate-700 bg-slate-800 px-1 text-slate-200"
            >
              {[10, 12, 14, 16, 20, 24].map((s) => <option key={s} value={s}>{s}px</option>)}
            </select>
            <button title="Edit text" onClick={onEditText} className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <PenLine className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {/* Fibonacci level toggles */}
        {isFib && (
          <>
            <span className="h-4 w-px bg-slate-700" />
            <details className="relative">
              <summary className="cursor-pointer list-none rounded px-1 text-slate-400 hover:bg-slate-800" title="Fibonacci levels">Levels</summary>
              <div className="absolute bottom-6 left-0 z-40 w-44 rounded-lg border border-slate-700 bg-slate-900/97 p-2 shadow-2xl">
                {(drawing.levels?.length
                  ? drawing.levels
                  : (FIB_DEFAULT_LEVELS[drawing.type] || [0, 0.5, 1]).map((ratio): FibLevel => ({ ratio, show: true }))
                ).map((lvl, i) => (
                  <label key={`${lvl.ratio}-${i}`} className="flex items-center gap-2 py-0.5 text-slate-300">
                    <input
                      type="checkbox"
                      checked={lvl.show}
                      onChange={(e) => {
                        const base: FibLevel[] = drawing.levels?.length
                          ? drawing.levels.map((x) => ({ ...x }))
                          : (FIB_DEFAULT_LEVELS[drawing.type] || [0, 0.5, 1]).map((ratio): FibLevel => ({ ratio, show: true }));
                        base[i] = { ...base[i], show: e.target.checked };
                        onChange({ levels: base });
                      }}
                      className="accent-sky-500"
                    />
                    <span className="font-number">{(lvl.ratio * 100).toFixed(1)}%</span>
                    <input
                      type="color"
                      value={lvl.color || drawing.style.color}
                      title="Level color"
                      onChange={(e) => {
                        const base: FibLevel[] = drawing.levels?.length
                          ? drawing.levels.map((x) => ({ ...x }))
                          : (FIB_DEFAULT_LEVELS[drawing.type] || [0, 0.5, 1]).map((ratio): FibLevel => ({ ratio, show: true }));
                        base[i] = { ...base[i], color: e.target.value };
                        onChange({ levels: base });
                      }}
                      className="ml-auto h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                  </label>
                ))}
                <button
                  onClick={() => onChange({ levels: undefined })}
                  className="mt-1 text-[10px] text-slate-500 hover:text-slate-300"
                >
                  Reset to defaults
                </button>
              </div>
            </details>
          </>
        )}
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
        <button title="Delete" onClick={onDelete} className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-red-500/15 hover:text-red-400">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
