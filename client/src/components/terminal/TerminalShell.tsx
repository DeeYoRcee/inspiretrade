/**
 * TerminalShell — the professional multi-panel terminal layout (TradingView-style).
 *
 *  ┌──────────────────────────────────────┬─────────────┬──────┐
 *  │ chart (+ left drawing rail, top      │ active      │ icon │
 *  │ toolbar, bottom range bar)           │ right panel │ rail │
 *  │──────────────────────────────────────│ (resize,    │      │
 *  │ blotter (resize, collapse)           │  close)     │      │
 *  └──────────────────────────────────────┴─────────────┴──────┘
 *
 * The right icon rail toggles ONE panel at a time (watchlist / order ticket /
 * alerts / market info) — clicking the active button closes it and the chart
 * grows. Dividers are pointer-draggable; sizes persist in localStorage.
 * Below 1024px the shell degrades to the stacked mobile layout.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight, BellRing, ChevronLeft, Info, ListOrdered, PanelRightClose, PanelRightOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const KEY = "it_terminal_shell_v2";

export type ShellPanel = "watchlist" | "ticket" | "alerts" | "info" | null;

export interface ShellState {
  /** right panel width px */
  right: number;
  /** blotter height px */
  bottom: number;
  bottomOpen: boolean;
}

const DEFAULTS: ShellState = { right: 330, bottom: 250, bottomOpen: false };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function loadShell(): ShellState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      right: clamp(Number(raw.right) || DEFAULTS.right, 260, 460),
      bottom: clamp(Number(raw.bottom) || DEFAULTS.bottom, 140, 480),
      // PHASE 62 (user request): a fresh terminal starts CLEAN (TradingView
      // default) — the blotter is CLOSED unless the user explicitly opened it
      // (persisted). One click on the bottom tab brings it back.
      bottomOpen: raw.bottomOpen === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/** true when the viewport has room for the desktop layout */
function useIsWide(): boolean {
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.matchMedia("(min-width: 1024px)").matches));
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** one draggable divider; `onDelta` receives the px delta since drag start */
function Divider({
  orientation, onDelta, children,
}: {
  orientation: "v" | "h";
  onDelta: (deltaPx: number) => void;
  children?: React.ReactNode;
}) {
  const startRef = useRef<number | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startRef.current = orientation === "v" ? e.clientX : e.clientY;
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  }, [orientation]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (startRef.current == null) return;
    const cur = orientation === "v" ? e.clientX : e.clientY;
    onDelta(cur - startRef.current);
    startRef.current = cur;
  }, [orientation, onDelta]);
  const onPointerUp = useCallback(() => { startRef.current = null; }, []);
  return (
    <div
      role="separator"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "group relative z-10 flex shrink-0 touch-none items-center justify-center bg-slate-800/70 transition-colors hover:bg-sky-600/50",
        orientation === "v" ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
      )}
    >
      {children}
    </div>
  );
}

const RAIL_BUTTONS: { id: Exclude<ShellPanel, null>; icon: React.ReactNode; title: string }[] = [
  { id: "watchlist", icon: <ListOrdered className="h-4 w-4" />, title: "Watchlist" },
  { id: "ticket", icon: <ArrowLeftRight className="h-4 w-4" />, title: "Order ticket" },
  { id: "alerts", icon: <BellRing className="h-4 w-4" />, title: "Alerts" },
  { id: "info", icon: <Info className="h-4 w-4" />, title: "Instrument details" },
];

export function TerminalShell({
  chart, blotter, panel, activePanel, onPanelSelect,
  hideRail = false, hideBlotter = false,
}: {
  chart: React.ReactNode;
  blotter: React.ReactNode;
  /** content of the currently open right panel (null when closed) */
  panel: React.ReactNode;
  activePanel: ShellPanel;
  onPanelSelect: (p: ShellPanel) => void;
  /** P55 §9 — interface visibility prefs (Terminal settings → Look & feel) */
  hideRail?: boolean;
  hideBlotter?: boolean;
}) {
  const wide = useIsWide();
  const [shell, setShell] = useState<ShellState>(loadShell);
  // Phase 59 PERF: shell state changes on EVERY pointermove while dragging a
  // divider — a synchronous JSON.stringify + localStorage write per mouse
  // move janks the drag. Persist debounced (150 ms trailing).
  const shellSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (shellSaveTimer.current) clearTimeout(shellSaveTimer.current);
    shellSaveTimer.current = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(shell)); } catch { /* private mode */ }
    }, 150);
    return () => { if (shellSaveTimer.current) { clearTimeout(shellSaveTimer.current); shellSaveTimer.current = null; } };
  }, [shell]);

  const patch = useCallback((p: Partial<ShellState>) => setShell((s) => ({ ...s, ...p })), []);

  // P43 — mobile: which docked panel is open below the chart (one at a time)
  const [mTab, setMTab] = useState<Exclude<ShellPanel, null> | "blotter" | null>("watchlist");
  useEffect(() => {
    // keep the parent's activePanel in sync with the mobile tab on layout switches
    if (!wide && mTab && mTab !== "blotter" && activePanel !== mTab) onPanelSelect(mTab);
  }, [wide]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wide) {
    // P43 — stacked mobile/tablet layout: the chart stays the primary
    // surface; panels dock into a touch-sized tab strip below it, one at a
    // time. No desktop pixel widths leak into this branch.
    const tabs: { id: Exclude<ShellPanel, null> | "blotter"; label: string }[] = [
      { id: "watchlist", label: "Watchlist" },
      { id: "ticket", label: "Trade" },
      { id: "alerts", label: "Alerts" },
      { id: "info", label: "Info" },
      { id: "blotter", label: "Positions" },
    ];
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-[220px] flex-1">{chart}</div>
        <div className="flex shrink-0 items-stretch gap-0.5 overflow-x-auto rounded-t-lg border border-b-0 border-slate-800 bg-slate-900/80 px-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => {
                setMTab((cur) => (cur === tb.id ? null : tb.id));
                if (tb.id !== "blotter") onPanelSelect(tb.id);
              }}
              className={cn(
                "relative flex h-11 min-w-[68px] flex-1 items-center justify-center whitespace-nowrap rounded-t-md px-2 text-xs font-semibold transition-colors",
                mTab === tb.id ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800",
              )}
            >
              {tb.label}
            </button>
          ))}
        </div>
        {mTab && (
          <div className="h-[min(45dvh,380px)] shrink-0 overflow-auto rounded-b-lg border border-t-0 border-slate-800 bg-[#0b1220]">
            {mTab === "blotter" ? blotter : panel}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* center — chart + bottom blotter */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">{chart}</div>
        {hideBlotter ? null : shell.bottomOpen ? (
          <>
            <Divider orientation="h" onDelta={(d) => patch({ bottom: clamp(shell.bottom - d, 140, 480) })}>
              <button
                title="Collapse bottom panel"
                onClick={() => patch({ bottomOpen: false })}
                className="opacity-60 transition-opacity md:opacity-0 md:group-hover:opacity-100"
              >
                <ChevronLeft className="h-3.5 w-3.5 rotate-90 text-slate-400 hover:text-sky-300" />
              </button>
            </Divider>
            <div style={{ height: shell.bottom }} className="min-h-0 shrink-0 overflow-hidden rounded-lg border border-slate-800">
              {blotter}
            </div>
          </>
        ) : (
          <button
            title="Show positions panel"
            onClick={() => patch({ bottomOpen: true })}
            className="mt-1 flex h-6 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 text-[10px] font-semibold text-slate-500 hover:text-sky-300"
          >
            <ChevronLeft className="h-3 w-3 -rotate-90" /> Positions & history
          </button>
        )}
      </div>

      {/* right panel (one at a time) */}
      {activePanel && panel && (
        <>
          <Divider orientation="v" onDelta={(d) => patch({ right: clamp(shell.right - d, 260, 460) })}>
            <button
              title="Collapse panel"
              onClick={() => onPanelSelect(null)}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            >
              <PanelRightClose className="h-3.5 w-3.5 text-slate-400 hover:text-sky-300" />
            </button>
          </Divider>
          <div style={{ width: shell.right }} className="min-h-0 shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-[#0b1220]">
            {panel}
          </div>
        </>
      )}

      {/* right icon rail — hideable via interface prefs (P55 §9) */}
      {hideRail ? null : (
      <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-l border-slate-800 bg-[#0b1220] py-1.5">
        {RAIL_BUTTONS.map((b) => (
          <button
            key={b.id}
            title={b.title}
            onClick={() => onPanelSelect(activePanel === b.id ? null : b.id)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded transition-colors",
              activePanel === b.id
                ? "bg-sky-600 text-white"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
            )}
          >
            {b.icon}
          </button>
        ))}
        {activePanel && (
          <button
            title="Close panel"
            onClick={() => onPanelSelect(null)}
            className="mt-1 flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        )}
      </div>
      )}
    </div>
  );
}
