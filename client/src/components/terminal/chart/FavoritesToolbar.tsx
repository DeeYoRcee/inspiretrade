/**
 * FavoritesToolbar — P41 §2: TradingView-style floating quick-access bar for
 * favorited drawing tools, hosted inside the chart area (data-chart-ui so
 * canvas capture handlers ignore it). Click = activate the real tool;
 * hover shows the tool name; drag the grip = move the bar anywhere INSIDE
 * the chart (position persisted); HTML5 drag on items = live reorder; the ×
 * removes. Hidden entirely when empty.
 *
 * P44 §7 — the grip makes the bar draggable like TradingView's floating
 * toolbar: clamped to the chart bounds, persisted in localStorage.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { GripVertical, X } from "lucide-react";
import { ToolIcon, toolDisplayName } from "./LeftRail";
import type { DrawingType } from "@/lib/drawings";
import { cn } from "@/lib/utils";

const POS_KEY = "it-fav-toolbar-pos";
/** defaults match the original fixed spot (left-2 top-14) */
const DEFAULT_POS = { left: 8, top: 56 };

function readPos(): { left: number; top: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (p && typeof p.left === "number" && typeof p.top === "number" && Number.isFinite(p.left) && Number.isFinite(p.top)) return p;
  } catch { /* private mode */ }
  return null;
}

export function FavoritesToolbar({
  favs, activeTool, onActivate, onToggleFav, onReorder,
}: {
  favs: string[];
  activeTool: DrawingType | "cursor";
  onActivate: (t: DrawingType) => void;
  onToggleFav: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [pos, setPos] = useState(readPos);
  const [moving, setMoving] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<{ px: number; py: number; base: { left: number; top: number } } | null>(null);

  // keep a persisted position inside the (resized) chart bounds
  useLayoutEffect(() => {
    if (!pos || !barRef.current) return;
    const parent = barRef.current.offsetParent as HTMLElement | null;
    if (!parent) return;
    const maxLeft = Math.max(0, parent.clientWidth - barRef.current.offsetWidth - 2);
    const maxTop = Math.max(0, parent.clientHeight - barRef.current.offsetHeight - 2);
    if (pos.left > maxLeft || pos.top > maxTop) setPos({ left: Math.min(pos.left, maxLeft), top: Math.min(pos.top, maxTop) });
  }, [pos, favs.length]);

  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const bar = barRef.current;
    if (!bar || e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    moveRef.current = { px: e.clientX, py: e.clientY, base: pos ?? { ...DEFAULT_POS } };
    setMoving(true);
  };
  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = moveRef.current;
    const bar = barRef.current;
    if (!st || !bar) return;
    const parent = bar.offsetParent as HTMLElement | null;
    const maxLeft = parent ? Math.max(0, parent.clientWidth - bar.offsetWidth - 2) : 0;
    const maxTop = parent ? Math.max(0, parent.clientHeight - bar.offsetHeight - 2) : 0;
    setPos({
      left: Math.round(Math.min(maxLeft, Math.max(0, st.base.left + e.clientX - st.px))),
      top: Math.round(Math.min(maxTop, Math.max(0, st.base.top + e.clientY - st.py))),
    });
  };
  const onGripUp = () => {
    if (!moveRef.current) return;
    moveRef.current = null;
    setMoving(false);
    setPos((p) => {
      if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* private mode */ } }
      return p;
    });
  };

  if (!favs.length) return null;
  return (
    <div
      ref={barRef}
      data-chart-ui
      style={{ left: pos?.left ?? DEFAULT_POS.left, top: pos?.top ?? DEFAULT_POS.top }}
      className={cn(
        "pointer-events-auto absolute z-30 flex max-w-[calc(100%-5.5rem)] flex-wrap items-center gap-0.5 rounded-lg border bg-slate-900/95 px-1 py-1 shadow-xl backdrop-blur",
        moving ? "border-sky-500/70 shadow-2xl" : "border-slate-700",
      )}
    >
      {/* drag grip — moves the bar anywhere inside the chart */}
      <button
        title="Drag to move the toolbar"
        aria-label="Drag to move the toolbar"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        className="flex h-9 w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-slate-500 hover:text-slate-200 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {favs.map((t, i) => (
        <div
          key={t}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            try { e.dataTransfer.setData("text/plain", t); } catch { /* older engines */ }
            setDragIdx(i);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragIdx == null || dragIdx === i) return;
            onReorder(dragIdx, i);
            setDragIdx(i);
          }}
          onDrop={(e) => e.preventDefault()}
          onDragEnd={() => setDragIdx(null)}
          className={cn(
            "group/f relative flex h-9 w-9 items-center justify-center rounded transition-colors",
            activeTool === t ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
            dragIdx === i && "opacity-30",
          )}
        >
          <button
            title={toolDisplayName(t as DrawingType)}
            aria-label={toolDisplayName(t as DrawingType)}
            onClick={() => onActivate(t as DrawingType)}
            className="flex h-full w-full items-center justify-center"
          >
            <ToolIcon id={t as DrawingType} className="h-5 w-5" />
          </button>
          <button
            title={`Remove ${toolDisplayName(t as DrawingType)} from favorites`}
            onClick={(e) => { e.stopPropagation(); onToggleFav(t); }}
            className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-slate-300 hover:border-red-500 hover:bg-red-500 hover:text-white group-hover/f:flex"
          >
            <X className="h-2 w-2" />
          </button>
        </div>
      ))}
    </div>
  );
}
