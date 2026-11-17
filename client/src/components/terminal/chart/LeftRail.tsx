/**
 * LeftRail — TradingView-style vertical drawing toolbar.
 *
 * Drawing tools on top (cursor, trend, hline, vline, ray, extended, fib×2,
 * rect, channel, brush, text, measure), object-state controls at the bottom
 * (magnet, lock, hide, delete-all). Every button is functional; icons only,
 * tooltips included. Rendered inside PriceChart so the tool state stays
 * imperative — moving the mouse never re-renders the chart.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight, Crosshair, Eraser, Eye, EyeOff, Layers, Lock, LockOpen, Magnet, Minus,
  MoveUpRight, MoveVertical, Pencil, Ruler, Square, TrendingUp, Type,
} from "lucide-react";
import type { DrawingType } from "@/lib/drawings";
import { cn } from "@/lib/utils";

const TOOLS: { id: DrawingType; icon: React.ReactNode; title: string }[] = [
  { id: "trend", icon: <TrendingUp className="h-4 w-4" />, title: "Trend line (T)" },
  { id: "hline", icon: <Minus className="h-4 w-4" />, title: "Horizontal line (H)" },
  { id: "vline", icon: <MoveVertical className="h-4 w-4" />, title: "Vertical line (V)" },
  { id: "ray", icon: <ArrowUpRight className="h-4 w-4" />, title: "Ray" },
  { id: "extended", icon: <MoveUpRight className="h-4 w-4" />, title: "Extended line — infinite both ways (I)" },
  { id: "fib-retracement", icon: <span className="text-[9px] font-bold leading-none">fib</span>, title: "Fibonacci retracement (F)" },
  { id: "fib-extension", icon: <span className="text-[9px] font-bold leading-none">fib·e</span>, title: "Fibonacci extension (E) — 3 clicks" },
  { id: "rect", icon: <Square className="h-4 w-4" />, title: "Rectangle (R)" },
  { id: "channel", icon: <span className="text-[9px] font-bold leading-none">∥</span>, title: "Parallel channel (P) — 3 clicks" },
  { id: "brush", icon: <Pencil className="h-4 w-4" />, title: "Brush — freehand" },
  { id: "text", icon: <Type className="h-4 w-4" />, title: "Text (X)" },
  { id: "measure", icon: <Ruler className="h-4 w-4" />, title: "Price range measure (M)" },
];

export function LeftRail({
  activeTool, onToolSelect, magnet, onMagnetToggle,
  locked, onLockToggle, hiddenAll, onHideAllToggle,
  drawingsCount, onDeleteAll,
  objectsOpen, onObjectsToggle,
}: {
  activeTool: DrawingType | "cursor";
  onToolSelect: (t: DrawingType | "cursor") => void;
  magnet: boolean;
  onMagnetToggle: () => void;
  locked: boolean;
  onLockToggle: () => void;
  hiddenAll: boolean;
  onHideAllToggle: () => void;
  drawingsCount: number;
  onDeleteAll: () => void;
  objectsOpen: boolean;
  onObjectsToggle: () => void;
}) {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-slate-800 bg-[#0b1220] py-1">
      <RailButton
        title="Cursor / crosshair (Esc)"
        active={activeTool === "cursor"}
        onClick={() => onToolSelect("cursor")}
      >
        <Crosshair className="h-4 w-4" />
      </RailButton>
      <div className="my-0.5 h-px w-6 bg-slate-800" />
      {TOOLS.map((t) => (
        <RailButton
          key={t.id}
          title={t.title}
          active={activeTool === t.id}
          onClick={() => onToolSelect(t.id)}
        >
          {t.icon}
        </RailButton>
      ))}
      <div className="my-0.5 h-px w-6 bg-slate-800" />
      <RailButton title={magnet ? "Magnet mode ON — crosshair snaps to OHLC" : "Magnet mode OFF"} active={magnet} onClick={onMagnetToggle}>
        <Magnet className="h-4 w-4" />
      </RailButton>
      <RailButton title={locked ? "All drawings LOCKED — cannot be moved or edited" : "Unlock drawings"} active={locked} onClick={onLockToggle}>
        {locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
      </RailButton>
      <RailButton title={hiddenAll ? "Show all drawings" : "Hide all drawings"} active={hiddenAll} onClick={onHideAllToggle}>
        {hiddenAll ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </RailButton>
      <RailButton
        title={drawingsCount > 0 ? `Delete all drawings (${drawingsCount})` : "No drawings"}
        danger
        disabled={drawingsCount === 0 || locked}
        onClick={onDeleteAll}
      >
        <Eraser className="h-4 w-4" />
      </RailButton>
      <div className="my-0.5 h-px w-6 bg-slate-800" />
      <RailButton title="Object tree — drawings & indicators" active={objectsOpen} onClick={onObjectsToggle}>
        <Layers className="h-4 w-4" />
      </RailButton>
    </div>
  );
}

function RailButton({
  title, active, danger, disabled, onClick, children,
}: {
  title: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded transition-colors",
        active
          ? "bg-sky-600 text-white"
          : danger
            ? "text-slate-400 hover:bg-red-500/15 hover:text-red-400"
            : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
        disabled && "opacity-30 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}
