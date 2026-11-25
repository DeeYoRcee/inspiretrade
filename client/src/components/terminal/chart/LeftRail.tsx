/**
 * LeftRail — TradingView-style vertical drawing toolbar (Phase 14).
 *
 * Tools live in EXPANDABLE GROUPS (cursor · trend lines · Fibonacci · shapes
 * · freehand · annotations · measurement · patterns); clicking a group button
 * opens a compact floating ICON GRID submenu — every tool has its own custom
 * 16px SVG (consistent 1.5 stroke, monochrome, anchor dots) with the full
 * name + shortcut in the tooltip. The group button shows the group's
 * last-used tool (persisted), like TradingView. Object-state controls at the
 * bottom (magnet, lock, hide, delete-all). Rendered inside PriceChart OUTSIDE
 * the chart capture area, so interacting with menus never draws on the chart;
 * tool state stays imperative — moving the mouse never re-renders the chart.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Crosshair, Eraser, Eye, EyeOff, Layers, Lock, LockOpen, Magnet, PencilLine, Star, Trash2,
} from "lucide-react";
import type { DrawingType } from "@/lib/drawings";
import { MAX_FAVORITES } from "@/lib/drawing-favorites";
import { cn } from "@/lib/utils";
import type { CursorMode } from "./cursor-mode";

// ---------------------------------------------------------------------------
// Custom SVG icon set — 16×16 viewBox, stroke-width 1.5, currentColor.
// TradingView-like: strokes with small anchor dots at handle points.
// ---------------------------------------------------------------------------
type IconSpec = {
  p?: string[];                                  // stroked paths
  w?: number[];                                  // per-path stroke width override
  c?: [number, number, number][];                // circles [cx, cy, r]
  r?: [number, number, number, number][];        // rects [x, y, w, h]
  d?: [number, number][];                        // anchor dots
  dashed?: number[];                             // indices of paths rendered dashed
};
const ICONS: Partial<Record<DrawingType, IconSpec>> = {
  // ---- trend line tools ----------------------------------------------------
  trend: { p: ["M3 13L13 3"], d: [[3, 13], [13, 3]] },
  hline: { p: ["M1 8L15 8"], d: [[8, 8]] },
  vline: { p: ["M8 1L8 15"], d: [[8, 8]] },
  ray: { p: ["M4 12L13.5 2.5", "M10.8 2.9L14 2L13.1 5.2"], d: [[4, 12]] },
  extended: { p: ["M1 15L15 1", "M1 11L5 15", "M11 1L15 5"], d: [[6.5, 9.5], [9.5, 6.5]] },
  "info-line": { p: ["M3 13L13 3", "M9 13A4 4 0 0 0 13 9"], d: [[3, 13], [13, 3]] },
  "trend-angle": { p: ["M3 13L13 3", "M3 13L9.5 13", "M8.5 13A6.5 6.5 0 0 0 9.5 8"], d: [[3, 13], [13, 3]] },
  hray: { p: ["M3 8L13 8", "M10.5 5.5L13.5 8L10.5 10.5"], d: [[3, 8]] },
  hchannel: { p: ["M2 4.5L14 4.5", "M2 8L14 8", "M2 11.5L14 11.5"], d: [[2, 4.5], [14, 11.5]] },
  channel: { p: ["M3 13L11 5", "M6 13L14 5", "M4.5 14.7L12.5 6.7"], d: [[3, 13], [11, 5]] },
  regression: { p: ["M2 12.5C5.5 3.5 10.5 13 14 4"], d: [[2, 12.5], [14, 4]] },
  dchannel: { p: ["M2.5 6.5L9 3", "M7 13.2L13.5 9.7", "M4 8.2L10.5 4.7"], d: [[2.5, 6.5], [9, 3]] },
  pitchfork: { p: ["M3 3.5L13 8", "M3 3.5L13 3", "M3 3.5L13 13", "M13 3L13 13"], d: [[3, 3.5]] },
  // ---- Fibonacci ------------------------------------------------------------
  "fib-retracement": { p: ["M2 13.5L14 4", "M3.5 12L9 12", "M3.5 9.3L11.5 9.3", "M3.5 6.6L10.5 6.6", "M3.5 4L8.5 4"] },
  "fib-extension": { p: ["M2 14L9 4.5L14 8.5", "M4.5 11L14 11", "M4.5 8L12 8", "M4.5 5L8.5 5"] },
  "fib-trend-ext": { p: ["M2 14L7 5.5L10.5 10L14 4", "M4 11.2L14 11.2", "M4 8.4L13 8.4"] },
  "fib-channel": { p: ["M2 13.5L12 3.5", "M5 14L14.5 4.5", "M2 9.5L9.5 9.5", "M2 6.5L8 6.5"] },
  "fib-timezone": { p: ["M2 13L14 3", "M5 2.5L5 13.5", "M9 2.5L9 13.5", "M13 2.5L13 13.5"], dashed: [1, 2, 3] },
  "fib-fan": { p: ["M2.5 13.5L14 3", "M2.5 13.5L14 7", "M2.5 13.5L14 13.5"], d: [[2.5, 13.5]] },
  "fib-arc": { p: ["M3 13A8 8 0 0 0 11 13", "M3 13A4.5 4.5 0 0 0 7.5 13"], d: [[3, 13]] },
  "fib-circle": { c: [[8, 8, 5.5], [8, 8, 2.5]], d: [[8, 8]] },
  "fib-spiral": { p: ["M8 8C8 5.5 11 5.5 11 8C11 11.5 5.5 11.5 5.5 8C5.5 3.5 13 3.5 13 8C13 13.5 4 13.5 4 8"], d: [[8, 8]] },
  "fib-wedge": { p: ["M2.5 13.5L14 3", "M2.5 13.5L14 7.5", "M2.5 13.5L14 11", "M5 13.5L13.5 13.5"], d: [[2.5, 13.5]] },
  // ---- geometric shapes ------------------------------------------------------
  rect: { r: [[3, 4.5, 10, 7]], d: [[3, 4.5], [13, 11.5]] },
  rrect: { p: ["M3.5 11.5L12.5 4.5", "M2 8.5L4.5 12.5L14 7.5L11.5 3.5Z"], d: [[2, 8.5], [14, 7.5]] },
  triangle: { p: ["M8 3L14 13L2 13Z"], d: [[8, 3], [14, 13]] },
  circle: { c: [[8, 8, 5.5]], d: [[13.5, 8]] },
  ellipse: { p: ["M8 3.8C11.6 3.8 14 5.7 14 8C14 10.3 11.6 12.2 8 12.2C4.4 12.2 2 10.3 2 8C2 5.7 4.4 3.8 8 3.8Z"], d: [[13.5, 8]] },
  arc: { p: ["M2.5 12.5A8.5 8.5 0 0 1 13.5 12.5"], d: [[2.5, 12.5], [13.5, 12.5]] },
  path: { p: ["M2.5 12.5L7 4L10.5 9.5L13.5 6.5", "M13.5 6.5L14.5 11"], d: [[2.5, 12.5], [7, 4], [10.5, 9.5]] },
  polyline: { p: ["M2 12.5L6.5 4L10 9.5L14 5.5"], d: [[2, 12.5], [6.5, 4], [10, 9.5], [14, 5.5]] },
  curve: { p: ["M2 12.5C5 2.5 11 13.5 14 3.5"], d: [[2, 12.5], [14, 3.5]] },
  "double-curve": { p: ["M2 11C5.5 3 8.5 13 11.5 6.5C12.5 4.5 13.5 5 14 7"], d: [[2, 11], [14, 7]] },
  // ---- brush & freehand ------------------------------------------------------
  brush: { p: ["M10.5 2.5L13.5 5.5L6.5 12.5L2.5 13.5L3.5 9.5Z", "M9 4L12 7"] },
  highlighter: { p: ["M4 12.5L11 3.5", "M5.5 14L14 14"], w: [3, 1.5] },
  arrow: { p: ["M3 13L13 3", "M7.5 3L13 3L13 8.5"] },
  "arrow-marker": { p: ["M8 8L13 3", "M9 3L13 3L13 7"], d: [[8, 8]] },
  callout: { r: [[2.5, 3, 11, 7]], p: ["M5 10L4 13.5L8 10"] },
  "price-label": { p: ["M2.5 10.5L2.5 5.5L9.5 5.5L14 8L9.5 10.5Z", "M5 8L11 8"], w: [1.5, 1] },
  // ---- annotations -------------------------------------------------------------
  text: { p: ["M3 3.5L13 3.5", "M8 3.5L8 13", "M5.5 13L10.5 13"] },
  "anchored-text": { p: ["M4 3L12 3", "M8 3L8 9.5", "M5.5 9.5L10.5 9.5"], d: [[8, 13]] },
  note: { r: [[2.5, 3.5, 11, 8]], p: ["M4.5 6H11.5", "M4.5 9H9.5"], w: [1.5, 1] },
  "price-note": { p: ["M2.5 10.5L2.5 5.5L9.5 5.5L14 8L9.5 10.5Z", "M14 8L15 8"], w: [1.5, 2], d: [[14, 8]] },
  signpost: { p: ["M8 2.5L8 13.5", "M4 4.5L8 2.5L12 4.5L8 6.5Z"], d: [[8, 13.5]] },
  comment: { p: ["M2.5 3.5H13.5V10H8L4.5 13V10H2.5Z"] },
  flag: { p: ["M5 2.5L5 13.5", "M5 3.5H12.5L10.5 6L12.5 8.5H5"], d: [[5, 13.5]] },
  // ---- measurement ---------------------------------------------------------------
  measure: { p: ["M8 2L8 14", "M5.5 4.5L8 2L10.5 4.5", "M5.5 11.5L8 14L10.5 11.5", "M11 5.5L13 5.5", "M11 8L13 8", "M11 10.5L13 10.5"] },
  "price-range": { p: ["M3 3L13 3", "M3 13L13 13", "M8 4.5L8 11.5", "M5.5 6.5L8 4L10.5 6.5", "M5.5 9.5L8 12L10.5 9.5"] },
  "date-range": { p: ["M3 3L3 13", "M13 3L13 13", "M4.5 8L11.5 8", "M6.5 5.5L4 8L6.5 10.5", "M9.5 5.5L12 8L9.5 10.5"] },
  "datetime-range": { p: ["M3 3L3 13L13 13", "M4.5 6L3 3.5L5.5 5", "M10.5 11.5L13 13L11 14"], w: [1.5, 1, 1] },
  "long-position": { r: [[4, 4, 8, 8]], p: ["M8 11L8 5", "M6 7L8 4.5L10 7", "M4 4L4 4"], d: [[4, 12]] },
  "short-position": { r: [[4, 4, 8, 8]], p: ["M8 5L8 11", "M6 9L8 11.5L10 9"], d: [[4, 4]] },
  forecast: { p: ["M2.5 13L8 7", "M8 7L13.5 2.5", "M10 2.5L13.5 2.5L13.5 6"], dashed: [1], d: [[2.5, 13]] },
  // ---- patterns --------------------------------------------------------------------
  "elliott-impulse": { p: ["M2 13L5.5 4L8.5 9.5L11.5 3.5L14 11"], d: [[2, 13], [5.5, 4], [8.5, 9.5], [11.5, 3.5], [14, 11]] },
  "elliott-correction": { p: ["M2 4L6 12.5L10 6.5L14 12"], d: [[2, 4], [6, 12.5], [10, 6.5], [14, 12]] },
  "head-shoulders": { p: ["M2 12L4.5 8L7 11.5L9.5 4.5L12 11.5L13.5 8"], d: [[2, 12], [13.5, 8]] },
  xabcd: { p: ["M2 3L5 12.5L9 6L13.5 10"], d: [[2, 3], [5, 12.5], [9, 6], [13.5, 10]] },
  abcd: { p: ["M2 12.5L6 4L9.5 10L13.5 3.5"], d: [[2, 12.5], [6, 4], [9.5, 10], [13.5, 3.5]] },
  "three-drives": { p: ["M2 12.5L5 8.5L6.5 11L9 5.5L11 8.5L13.5 3"], d: [[2, 12.5], [9, 5.5], [13.5, 3]] },
};

export function ToolIcon({ id, className }: { id: DrawingType; className?: string }) {
  const spec = ICONS[id];
  const st = (i: number) => ({
    fill: "none", stroke: "currentColor",
    strokeWidth: spec?.w?.[i] ?? 1.5,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    ...(spec?.dashed?.includes(i) ? { strokeDasharray: "2.4 2.2" } : {}),
  });
  if (!spec) return <span className="text-[9px] font-bold leading-none">?</span>;
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      {spec.p?.map((d, i) => <path key={`p${i}`} d={d} {...st(i)} />)}
      {spec.r?.map(([x, y, w, h], i) => <rect key={`r${i}`} x={x} y={y} width={w} height={h} {...st(0)} />)}
      {spec.c?.map(([cx, cy, r], i) => <circle key={`c${i}`} cx={cx} cy={cy} r={r} {...st(0)} />)}
      {spec.d?.map(([x, y], i) => <circle key={`d${i}`} cx={x} cy={y} r={1.35} fill="currentColor" />)}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tool groups (real, implemented tools only) — identical wiring to before.
// ---------------------------------------------------------------------------
const g = (id: DrawingType, label: string, hint?: string) => ({ id, label, hint });

interface ToolGroup {
  id: string;
  title: string;
  tools: { id: DrawingType; label: string; hint?: string }[];
}

/** P42 — palette category of a tool, for the object tree's type filter. */
export function toolGroupTitle(id: DrawingType): string {
  for (const grp of GROUPS) {
    if (grp.tools.some((t) => t.id === id)) return grp.title;
  }
  return "Other";
}

/** P41 — human label for tooltips (floating favorites toolbar, object tree). */
export function toolDisplayName(id: DrawingType): string {
  for (const grp of GROUPS) {
    const t = grp.tools.find((x) => x.id === id);
    if (t) return t.label;
  }
  return id;
}




const GROUPS: ToolGroup[] = [
  {
    id: "trend",
    title: "Trend line tools",
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
      g("pitchfork", "Andrews pitchfork — 3 pivots"),
    ],
  },
  {
    id: "fib",
    title: "Fibonacci tools",
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
    tools: [
      g("text", "Text", "X"),
      g("anchored-text", "Anchored text"),
      g("note", "Note"),
      g("price-note", "Price note"),
      g("signpost", "Signpost"),
      g("comment", "Comment"),
      g("flag", "Flag"),
    ],
  },
  {
    id: "measure",
    title: "Measurement",
    tools: [
      g("measure", "Measure", "M"),
      g("price-range", "Price range"),
      g("date-range", "Date range"),
      g("datetime-range", "Date and price range"),
      g("long-position", "Long position — entry/stop/target"),
      g("short-position", "Short position — entry/stop/target"),
      g("forecast", "Forecast"),
    ],
  },
  {
    id: "patterns",
    title: "Patterns",
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

const LAST_TOOL_KEY = "it-rail-last-tool";
/** Phase 37 §3 — pinned favorite tools, persisted locally */
const FAV_KEY = "it-rail-favorites";

function readFavs(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list.filter((x) => typeof x === "string") as string[]).slice(0, MAX_FAVORITES) : [];
  } catch { /* private mode */ }
  return [];
}

function readLastTool(): Partial<Record<string, DrawingType>> {
  try {
    const raw = localStorage.getItem(LAST_TOOL_KEY);
    if (raw) return JSON.parse(raw) as Partial<Record<string, DrawingType>>;
  } catch { /* private mode */ }
  return {};
}

export function LeftRail({
  activeTool, onToolSelect, magnetMode, onMagnetCycle,
  locked, onLockToggle, hiddenAll, onHideAllToggle,
  drawingsCount, onDeleteAll,
  stayDrawing, onStayDrawingToggle,
  hasSelected, onDeleteSelected,
  objectsOpen, onObjectsToggle,
  cursorMode, onCursorMode,
  favs: favsProp, onToggleFav,
}: {
  activeTool: DrawingType | "cursor";
  onToolSelect: (t: DrawingType | "cursor") => void;
  /** P46 §2 — 0=off · 1=normal · 2=strong */
  magnetMode: 0 | 1 | 2;
  onMagnetCycle: () => void;
  locked: boolean;
  onLockToggle: () => void;
  hiddenAll: boolean;
  onHideAllToggle: () => void;
  drawingsCount: number;
  onDeleteAll: () => void;
  /** P38 §1 — Stay in Drawing Mode toggle */
  stayDrawing: boolean;
  onStayDrawingToggle: () => void;
  /** P38 §3 — delete the SELECTED drawing from the toolbar */
  hasSelected: boolean;
  onDeleteSelected: () => void;
  objectsOpen: boolean;
  onObjectsToggle: () => void;
  cursorMode: CursorMode;
  onCursorMode: (m: CursorMode) => void;
  /** P41 — per-user favorites from PriceChart (LS+RTDB store); when absent
   *  the rail falls back to its own local pinned list (standalone usage) */
  favs?: string[];
  onToggleFav?: (id: string) => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // P78 — measure the open flyout's room once per open: flip to the left edge
  // when the pane is too narrow to fit minWidth 198px + margin on the right
  const [flyoutFlip, setFlyoutFlip] = useState(false);
  useEffect(() => {
    if (!openGroup) { setFlyoutFlip(false); return; }
    const btn = document.querySelector(`[data-rail-group="${openGroup}"]`);
    const r = btn?.getBoundingClientRect();
    setFlyoutFlip(!!r && r.right + 210 > window.innerWidth);
  }, [openGroup]);
  const [lastTool, setLastTool] = useState<Partial<Record<string, DrawingType>>>(readLastTool);
  const [localFavs, setLocalFavs] = useState<string[]>(readFavs);
  // P41 — the shared per-user store wins when PriceChart provides it
  const favs = favsProp ?? localFavs;
  const toggleFav = useCallback((id: string) => {
    if (onToggleFav) { onToggleFav(id); return; }
    setLocalFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(0, MAX_FAVORITES);
      try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, [onToggleFav]);
  const railRef = useRef<HTMLDivElement | null>(null);

  // close the popover on outside pointerdown / Esc — pointerdown INSIDE the
  // rail (submenu items!) must never close it before the click fires
  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent) => {
      if (railRef.current && e.target instanceof Node && railRef.current.contains(e.target)) return;
      setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenGroup(null); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [openGroup]);

  const pick = useCallback((groupId: string, t: DrawingType | "cursor") => {
    if (t !== "cursor" && groupId) {
      const next = { ...lastTool, [groupId]: t };
      setLastTool(next);
      try { localStorage.setItem(LAST_TOOL_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    }
    onToolSelect(t);
    setOpenGroup(null);
  }, [lastTool, onToolSelect]);

  const groupOf = (t: DrawingType) => GROUPS.find((grp) => grp.tools.some((x) => x.id === t));
/** PHASE 62: labels carry " — usage" hints; the flyout rows show the clean
    TradingView-style tool NAME only (no shortcuts, no usage hints). */
const nameCache = new Map<DrawingType, string>();
function cleanName(id: DrawingType): string {
  let n = nameCache.get(id);
  if (!n) {
    const label = GROUPS.flatMap((g) => g.tools).find((x) => x.id === id)?.label ?? id;
    n = label.split(" — ")[0].split(" (")[0];
    nameCache.set(id, n);
  }
  return n;
}
  const activeGroup = activeTool !== "cursor" ? groupOf(activeTool)?.id ?? null : null;

  return (
    <div ref={railRef} className="relative flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-slate-800 bg-[#0b1220] py-1">
      {/* cursor group — cross / dot / arrow pointer modes */}
      <div className="relative">
        <button
          title="Cursor — cross · dot · arrow (Esc resets)"
          onClick={() => setOpenGroup(openGroup === "cursor" ? null : "cursor")}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded transition-colors",
            activeTool === "cursor" ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
          )}
        >
          <CursorGlyph mode={cursorMode} className="h-5 w-5" />
        </button>
        {openGroup === "cursor" && (
          <div className="absolute left-full top-0 z-40 ml-1 flex flex-col gap-0.5 rounded-lg border border-slate-700/80 bg-[#0d1526] p-1 shadow-2xl" role="menu" aria-label="Cursor modes">
            {([
              { mode: "cross", label: "Cross cursor" },
              { mode: "dot", label: "Dot cursor" },
              { mode: "arrow", label: "Arrow cursor" },
            ] as { mode: CursorMode; label: string }[]).map((row) => (
              <button
                key={row.mode}
                role="menuitem"
                title={row.label}
                aria-label={row.label}
                onClick={() => { onCursorMode(row.mode); pick("", "cursor"); }}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded transition-colors",
                  cursorMode === row.mode && activeTool === "cursor" ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                )}
              >
                <CursorGlyph mode={row.mode} className="h-5 w-5" />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="my-0.5 h-px w-7 bg-slate-800" />
      {favs.length > 0 && (() => {
        const isOpen = openGroup === "fav";
        const favActive = activeTool !== "cursor" && favs.includes(activeTool);
        return (
          <div className="relative">
            <button
              title={`Favorites — ${favs.length} pinned tool${favs.length > 1 ? "s" : ""}`}
              aria-label="Favorite tools"
              onClick={() => setOpenGroup(isOpen ? null : "fav")}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded transition-colors",
                favActive ? "bg-sky-600 text-white" : isOpen ? "bg-slate-800 text-slate-200" : "text-amber-400/90 hover:bg-slate-800",
              )}
            >
              <Star className={cn("h-4 w-4", favActive && "fill-current")} />
            </button>
            {isOpen && (
              /* PHASE 62 (user request): TV-style flyout — icon + NAME rows,
                 no shortcut hints. Shared with the group flyouts below. */
              <div
                className="absolute left-full top-0 z-40 ml-1 max-h-[70vh] overflow-y-auto rounded-lg border border-slate-700/80 bg-[#0d1526] py-1 shadow-2xl"
                role="menu"
                aria-label="Favorite tools"
                style={{ minWidth: 198 }}
              >
                {favs.map((t) => (
                  <button
                    key={t}
                    role="menuitem"
                    title={cleanName(t as DrawingType)}
                    onClick={() => pick("fav", t as DrawingType)}
                    className={cn(
                      "group/tb relative flex h-8 w-full items-center gap-2.5 rounded px-2 transition-colors",
                      activeTool === t ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
                    )}
                  >
                    <ToolIcon id={t as DrawingType} className="h-4 w-4 shrink-0" />
                    <span className="truncate text-[12px] font-medium">{cleanName(t as DrawingType)}</span>
                    <Star
                      onClick={(e) => { e.stopPropagation(); toggleFav(t); }}
                      className="ml-auto h-3 w-3 shrink-0 fill-amber-400 text-amber-400"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {GROUPS.map((grp) => {
        // the group button shows the group's LAST-USED tool (TradingView
        // behavior), falls back to the first tool; open state adds a caret
        const shown = (activeGroup === grp.id && activeTool !== "cursor" ? activeTool : lastTool[grp.id]) ?? grp.tools[0].id;
        const isOpen = openGroup === grp.id;
        return (
          <div key={grp.id} className="relative">
            <button
              data-rail-group={grp.id}
              title={`${grp.title} — ${grp.tools.find((x) => x.id === shown)?.label ?? ""}`}
              aria-label={grp.title}
              onClick={() => setOpenGroup(isOpen ? null : grp.id)}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded transition-colors",
                activeGroup === grp.id ? "bg-sky-600 text-white" : isOpen ? "bg-slate-800 text-slate-200" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
              )}
            >
              <span className="relative">
                <ToolIcon id={shown} className="h-5 w-5" />
                <span className={cn("absolute -bottom-0.5 -right-1 h-1 w-1 rounded-full", isOpen ? "bg-sky-300" : "bg-slate-500")} />
              </span>
            </button>
            {isOpen && (
              <div
                // P78 — flip the flyout to the LEFT edge when the pane is too
                // narrow to fit it on the right (no more off-screen clipping)
                className={cn(
                  "absolute top-0 z-40 max-h-[70vh] overflow-y-auto rounded-lg border border-slate-700/80 bg-[#0d1526] py-1 shadow-2xl",
                  flyoutFlip ? "right-full mr-1" : "left-full ml-1",
                )}
                role="menu"
                aria-label={grp.title}
                style={{ minWidth: 198 }}
              >
                {/* group header — TradingView's flyout titles the section */}
                <p className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{grp.title}</p>
                {grp.tools.map((t) => (
                  <button
                    key={`${grp.id}-${t.id}`}
                    role="menuitem"
                    title={t.hint ? `${cleanName(t.id)} (${t.hint})` : cleanName(t.id)}
                    aria-label={cleanName(t.id)}
                    onClick={() => pick(grp.id, t.id)}
                    className={cn(
                      "group/tb relative flex h-8 w-full items-center gap-2.5 rounded px-2 transition-colors",
                      activeTool === t.id ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
                    )}
                  >
                    <ToolIcon id={t.id} className="h-4 w-4 shrink-0" />
                    <span className="truncate text-[12px] font-medium">{cleanName(t.id)}</span>
                    <Star
                      onClick={(e) => { e.stopPropagation(); toggleFav(t.id); }}
                      className={cn(
                        "ml-auto h-3 w-3 shrink-0 transition-opacity",
                        favs.includes(t.id) ? "fill-amber-400 text-amber-400" : "text-slate-500 opacity-0 group-hover/tb:opacity-100",
                      )}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="my-0.5 h-px w-6 bg-slate-800" />
      <RailButton
        title={stayDrawing ? "Stay in Drawing Mode ON — tool stays armed after each drawing (Shift also chains)" : "Stay in Drawing Mode OFF — back to Select after each drawing"}
        active={stayDrawing}
        onClick={onStayDrawingToggle}
      >
        <PencilLine className="h-5 w-5" />
      </RailButton>
      <RailButton
        title={magnetMode === 2 ? "Magnet STRONG — wide OHLC snap (click → normal)" : magnetMode === 1 ? "Magnet ON — cursor/anchors snap to OHLC (click → strong)" : "Magnet OFF (click → normal)"}
        active={magnetMode > 0}
        onClick={onMagnetCycle}
      >
        <Magnet className="h-5 w-5" />
        {magnetMode === 2 && <span title="Strong" className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-amber-400" />}
      </RailButton>
      <RailButton title={locked ? "All drawings LOCKED — cannot be moved or edited" : "Unlock drawings"} active={locked} onClick={onLockToggle}>
        {locked ? <Lock className="h-5 w-5" /> : <LockOpen className="h-5 w-5" />}
      </RailButton>
      <RailButton title={hiddenAll ? "Show all drawings" : "Hide all drawings"} active={hiddenAll} onClick={onHideAllToggle}>
        {hiddenAll ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </RailButton>
      <RailButton
        title={drawingsCount > 0 ? `Delete all drawings (${drawingsCount})` : "No drawings"}
        danger
        disabled={drawingsCount === 0 || locked}
        onClick={onDeleteAll}
      >
        <Eraser className="h-5 w-5" />
      </RailButton>
      <RailButton
        title={hasSelected ? "Delete selected drawing" : "Select a drawing, then click to delete it"}
        danger
        disabled={!hasSelected || locked}
        onClick={onDeleteSelected}
      >
        <Trash2 className="h-5 w-5" />
      </RailButton>
      <div className="my-0.5 h-px w-6 bg-slate-800" />
      <RailButton title="Object tree — drawings & indicators" active={objectsOpen} onClick={onObjectsToggle}>
        <Layers className="h-5 w-5" />
      </RailButton>
    </div>
  );
}

/** Cursor-mode glyphs — real SVGs instead of the old ➤ / · text placeholders. */
function CursorGlyph({ mode, className }: { mode: CursorMode; className?: string }) {
  if (mode === "arrow") {
    return (
      <svg viewBox="0 0 16 16" className={className} aria-hidden>
        <path d="M4 2.5L12.5 8.5L8.5 9.5L11 13.5L9 14.5L6.5 10.5L4 13Z" fill="currentColor" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" />
      </svg>
    );
  }
  if (mode === "dot") {
    return (
      <svg viewBox="0 0 16 16" className={className} aria-hidden>
        <circle cx={8} cy={8} r={2.2} fill="currentColor" />
        <circle cx={8} cy={8} r={5} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.45} />
      </svg>
    );
  }
  return <Crosshair className={className} />;
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
      aria-label={title}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded transition-colors",
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
