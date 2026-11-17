/**
 * LeftRail — TradingView-style vertical drawing toolbar.
 *
 * Tools live in EXPANDABLE GROUPS (cursor · trend lines · Fibonacci · shapes
 * · freehand · annotations · measurement · patterns); clicking a group button
 * opens its submenu, clicking a tool selects it and closes the popover.
 * Object-state controls at the bottom (magnet, lock, hide, delete-all).
 * Every button is functional; icons only, tooltips included. Rendered inside
 * PriceChart so tool state stays imperative — moving the mouse never
 * re-renders the chart.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight, Crosshair, Eraser, Eye, EyeOff, Layers, Lock, LockOpen, Magnet, Minus,
  MoveUpRight, MoveVertical, Pencil, Ruler, Square, TrendingUp, Type,
} from "lucide-react";
import type { DrawingType } from "@/lib/drawings";
import { cn } from "@/lib/utils";
import type { CursorMode } from "./cursor-mode";

const g = (id: DrawingType, label: string, hint?: string) => ({ id, label, hint });
const ic = (glyph: string) => <span className="text-[9px] font-bold leading-none">{glyph}</span>;

interface ToolGroup {
  id: string;
  title: string;
  icon: React.ReactNode;
  tools: { id: DrawingType; label: string; hint?: string }[];
}

const GROUPS: ToolGroup[] = [
  {
    id: "trend",
    title: "Trend line tools",
    icon: <TrendingUp className="h-4 w-4" />,
    tools: [
      g("trend", "Trend line", "T"),
      g("hline", "Horizontal line", "H"),
      g("vline", "Vertical line", "V"),
      g("ray", "Ray — extends through B"),
      g("extended", "Extended line — infinite", "I"),
      g("info-line", "Info line — slope + Δ"),
      g("trend-angle", "Trend angle"),
      g("hray", "Horizontal ray"),
      g("hchannel", "Horizontal channel"),
      g("channel", "Parallel channel", "P"),
      g("regression", "Regression trend — least-squares fit"),
      g("dchannel", "Disjoint channel"),
    ],
  },
  {
    id: "fib",
    title: "Fibonacci tools",
    icon: ic("fib"),
    tools: [
      g("fib-retracement", "Fibonacci retracement", "F"),
      g("fib-extension", "Fibonacci extension", "E"),
      g("fib-trend-ext", "Trend-based Fibonacci extension"),
      g("fib-channel", "Fibonacci channel"),
      g("fib-timezone", "Fibonacci time zone"),
      g("fib-fan", "Fibonacci speed resistance fan"),
      g("fib-arc", "Fibonacci arcs"),
      g("fib-circle", "Fibonacci circles"),
      g("fib-spiral", "Fibonacci spiral"),
      g("fib-wedge", "Fibonacci wedge"),
    ],
  },
  {
    id: "shapes",
    title: "Geometric shapes",
    icon: <Square className="h-4 w-4" />,
    tools: [
      g("rect", "Rectangle", "R"),
      g("rrect", "Rotated rectangle"),
      g("triangle", "Triangle"),
      g("circle", "Circle"),
      g("ellipse", "Ellipse"),
      g("path", "Path — click points · Enter/2×click ends"),
      g("polyline", "Polyline — click points · Enter/2×click ends"),
      g("curve", "Curve"),
      g("double-curve", "Double curve"),
      g("arc", "Arc"),
    ],
  },
  {
    id: "freehand",
    title: "Brush & freehand",
    icon: <Pencil className="h-4 w-4" />,
    tools: [
      g("brush", "Brush — freehand"),
      g("highlighter", "Highlighter"),
      g("arrow", "Arrow"),
      g("arrow-marker", "Arrow marker"),
      g("callout", "Callout"),
      g("price-label", "Price label"),
    ],
  },
  {
    id: "annotation",
    title: "Annotations",
    icon: <Type className="h-4 w-4" />,
    tools: [
      g("text", "Text", "X"),
      g("anchored-text", "Anchored text"),
      g("note", "Note"),
      g("price-note", "Price note"),
      g("signpost", "Signpost"),
      g("comment", "Comment"),
      g("flag", "Flag"),
      g("price-range", "Price range"),
      g("date-range", "Date range"),
      g("datetime-range", "Date and price range"),
    ],
  },
  {
    id: "measure",
    title: "Measurement",
    icon: <Ruler className="h-4 w-4" />,
    tools: [
      g("measure", "Measure", "M"),
      g("price-range", "Price range"),
      g("date-range", "Date range"),
      g("long-position", "Long position — entry/stop/target"),
      g("short-position", "Short position — entry/stop/target"),
      g("forecast", "Forecast"),
    ],
  },
  {
    id: "patterns",
    title: "Patterns",
    icon: ic("W"),
    tools: [
      g("elliott-impulse", "Elliott impulse wave — 6 clicks"),
      g("elliott-correction", "Elliott correction wave"),
      g("head-shoulders", "Head and shoulders — 7 clicks"),
      g("xabcd", "XABCD harmonic pattern"),
      g("abcd", "ABCD pattern"),
      g("three-drives", "Three drives pattern"),
    ],
  },
];

export function LeftRail({
  activeTool, onToolSelect, magnet, onMagnetToggle,
  locked, onLockToggle, hiddenAll, onHideAllToggle,
  drawingsCount, onDeleteAll,
  objectsOpen, onObjectsToggle,
  cursorMode, onCursorMode,
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
  cursorMode: CursorMode;
  onCursorMode: (m: CursorMode) => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  // close the popover when clicking anywhere outside the rail
  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent) => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) setOpenGroup(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [openGroup]);

  const pick = (t: DrawingType | "cursor") => {
    onToolSelect(t);
    setOpenGroup(null);
  };

  return (
    <div ref={railRef} className="relative flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-slate-800 bg-[#0b1220] py-1">
      {/* cursor group — cross / dot / arrow pointer modes */}
      <div className="relative">
        <button
          title="Cursor — cross · dot · arrow (Esc resets)"
          onClick={() => setOpenGroup(openGroup === "cursor" ? null : "cursor")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded transition-colors",
            activeTool === "cursor" ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
          )}
        >
          {cursorMode === "arrow" ? <span className="text-[11px] leading-none">➤</span>
            : cursorMode === "dot" ? <span className="text-[13px] leading-none">·</span>
            : <Crosshair className="h-4 w-4" />}
        </button>
        {openGroup === "cursor" && (
          <div className="absolute left-full top-0 z-40 ml-1 w-44 rounded-lg border border-slate-700 bg-slate-900/97 py-1 shadow-2xl backdrop-blur">
            {([
              { mode: "cross", label: "Cross cursor", glyph: <Crosshair className="h-4 w-4" /> },
              { mode: "dot", label: "Dot cursor", glyph: <span className="text-[13px] leading-none">·</span> },
              { mode: "arrow", label: "Arrow cursor", glyph: <span className="text-[11px] leading-none">➤</span> },
            ] as { mode: CursorMode; label: string; glyph: React.ReactNode }[]).map((row) => (
              <button
                key={row.mode}
                onClick={() => { onCursorMode(row.mode); pick("cursor"); }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-slate-800",
                  cursorMode === row.mode && activeTool === "cursor" ? "text-sky-300" : "text-slate-300",
                )}
              >
                <span className="flex h-5 w-5 items-center justify-center text-slate-400">{row.glyph}</span>
                {row.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="my-0.5 h-px w-6 bg-slate-800" />
      {GROUPS.map((grp) => {
        const anyActive = grp.tools.some((t) => t.id === activeTool);
        return (
          <div key={grp.id} className="relative">
            <button
              title={grp.title}
              onClick={() => setOpenGroup(openGroup === grp.id ? null : grp.id)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded transition-colors",
                anyActive ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
              )}
            >
              {grp.icon}
            </button>
            {openGroup === grp.id && (
              <div className="absolute left-full top-0 z-40 ml-1 max-h-[72vh] w-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/97 py-1 shadow-2xl backdrop-blur">
                {grp.tools.map((t) => (
                  <button
                    key={`${grp.id}-${t.id}`}
                    title={t.hint ? `${t.label} (${t.hint})` : t.label}
                    onClick={() => pick(t.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-slate-800",
                      activeTool === t.id ? "text-sky-300" : "text-slate-300",
                    )}
                  >
                    <span className="truncate">{t.label}</span>
                    {t.hint && <span className="shrink-0 text-[10px] text-slate-500">{t.hint}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
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
