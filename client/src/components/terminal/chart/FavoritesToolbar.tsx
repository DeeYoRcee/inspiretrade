/**
 * FavoritesToolbar — P41 §2: TradingView-style floating quick-access bar for
 * favorited drawing tools, hosted inside the chart area (data-chart-ui so
 * canvas capture handlers ignore it). Click = activate the real tool;
 * hover shows the tool name; drag = live reorder; the × removes. Hidden
 * entirely when empty (elegant empty state).
 */
import { useState } from "react";
import { X } from "lucide-react";
import { ToolIcon, toolDisplayName } from "./LeftRail";
import type { DrawingType } from "@/lib/drawings";
import { cn } from "@/lib/utils";

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
  if (!favs.length) return null;
  return (
    <div
      data-chart-ui
      className="pointer-events-auto absolute left-2 top-14 z-30 flex max-w-[calc(100%-5.5rem)] flex-wrap items-center gap-0.5 rounded-lg border border-slate-700 bg-slate-900/95 px-1 py-1 shadow-xl backdrop-blur"
    >
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
            "group/f relative flex h-7 w-7 items-center justify-center rounded transition-colors",
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
            <ToolIcon id={t as DrawingType} className="h-4 w-4" />
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
