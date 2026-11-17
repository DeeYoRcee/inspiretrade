/**
 * TerminalShell — the professional multi-panel terminal layout.
 *
 *  ┌────────────┬──────────────────────────────┬──────────┐
 *  │ watchlist  │  chart (flex)                │ order    │
 *  │ (resize,   │──────────────────────────────│ ticket   │
 *  │  collapse) │  blotter (resize, collapse)  │ (resize, │
 *  └────────────┴──────────────────────────────┴──────────┘
 *
 * Dividers are pointer-draggable; every size and visibility flag persists in
 * localStorage. On narrow viewports (< 1024px) the shell degrades to the
 * stacked layout (watchlist hidden, ticket + blotter below the chart) — the
 * desktop panels only exist when there is room for them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const KEY = "it_terminal_shell_v1";

export interface ShellState {
  /** watchlist width px */
  left: number;
  /** order ticket width px */
  right: number;
  /** blotter height px */
  bottom: number;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

const DEFAULTS: ShellState = { left: 210, right: 340, bottom: 250, leftOpen: true, rightOpen: true, bottomOpen: true };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function loadShell(): ShellState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      left: clamp(Number(raw.left) || DEFAULTS.left, 170, 360),
      right: clamp(Number(raw.right) || DEFAULTS.right, 280, 460),
      bottom: clamp(Number(raw.bottom) || DEFAULTS.bottom, 140, 480),
      leftOpen: raw.leftOpen !== false,
      rightOpen: raw.rightOpen !== false,
      bottomOpen: raw.bottomOpen !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

/** true when the viewport has room for the 3-column desktop layout */
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
  orientation, onDelta, onDoubleClick, children,
}: {
  orientation: "v" | "h";
  onDelta: (deltaPx: number) => void;
  onDoubleClick?: () => void;
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
      onDoubleClick={onDoubleClick}
      className={cn(
        "group relative z-10 flex shrink-0 touch-none items-center justify-center bg-slate-800/70 transition-colors hover:bg-sky-600/50",
        orientation === "v" ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
      )}
    >
      {children}
    </div>
  );
}

export function TerminalShell({
  watchlist, ticket, chart, blotter,
}: {
  watchlist: React.ReactNode;
  ticket: React.ReactNode;
  chart: React.ReactNode;
  blotter: React.ReactNode;
}) {
  const wide = useIsWide();
  const [shell, setShell] = useState<ShellState>(loadShell);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(shell)); } catch { /* private mode */ }
  }, [shell]);

  const patch = useCallback((p: Partial<ShellState>) => setShell((s) => ({ ...s, ...p })), []);

  if (!wide) {
    // stacked mobile/tablet layout — identical to the pre-shell order
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {chart}
        {ticket}
        {blotter}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* left — watchlist */}
      {shell.leftOpen ? (
        <>
          <div style={{ width: shell.left }} className="min-h-0 shrink-0 overflow-hidden rounded-lg border border-slate-800">
            {watchlist}
          </div>
          <Divider orientation="v" onDelta={(d) => patch({ left: clamp(shell.left + d, 170, 360) })}>
            <button
              title="Collapse watchlist"
              onClick={() => patch({ leftOpen: false })}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            >
              <PanelLeftClose className="h-3.5 w-3.5 text-slate-400 hover:text-sky-300" />
            </button>
          </Divider>
        </>
      ) : (
        <button
          title="Show watchlist"
          onClick={() => patch({ leftOpen: true })}
          className="flex w-6 shrink-0 items-start justify-center rounded-lg border border-slate-800 bg-slate-900/60 py-2 text-slate-500 hover:text-sky-300"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      {/* center — chart + bottom blotter */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">{chart}</div>
        {shell.bottomOpen ? (
          <>
            <Divider orientation="h" onDelta={(d) => patch({ bottom: clamp(shell.bottom - d, 140, 480) })}>
              <button
                title="Collapse bottom panel"
                onClick={() => patch({ bottomOpen: false })}
                className="opacity-0 transition-opacity group-hover:opacity-100"
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

      {/* right — order ticket */}
      {shell.rightOpen ? (
        <>
          <Divider orientation="v" onDelta={(d) => patch({ right: clamp(shell.right - d, 280, 460) })}>
            <button
              title="Collapse order ticket"
              onClick={() => patch({ rightOpen: false })}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            >
              <PanelRightClose className="h-3.5 w-3.5 text-slate-400 hover:text-sky-300" />
            </button>
          </Divider>
          <div style={{ width: shell.right }} className="min-h-0 shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
            {ticket}
          </div>
        </>
      ) : (
        <button
          title="Show order ticket"
          onClick={() => patch({ rightOpen: true })}
          className="flex w-6 shrink-0 items-start justify-center rounded-lg border border-slate-800 bg-slate-900/60 py-2 text-slate-500 hover:text-sky-300"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
