/**
 * MultiChartWorkspace — PHASE 48: the professional multi-chart grid.
 *
 * · Layouts 1 / 2h / 2v / 3 / 4 / 6 with draggable boundaries (pure math from
 *   lib/chart-layouts).
 * · Every panel is a REAL PriceChart: own instrument, timeframe, chart type
 *   (panels 1+ are workspace-controlled; the primary panel keeps the legacy
 *   global behavior), indicators, drawings, watchlist-driven symbol, magnet
 *   and object manager — nothing is a mockup.
 * · Optional synchronization: crosshair, time range, interval, instrument —
 *   each independently toggleable (lib/chart-sync). Drawings are per
 *   (user, instrument): two panels on the same instrument naturally share
 *   them through RTDB; cross-INSTRUMENT drawing cloning stays off by design.
 * · Workspace presets: save / rename / duplicate / delete / switch, and the
 *   last-active grid is restored on open, refresh and re-login
 *   (lib/workspace-presets, RTDB per user).
 * · Mobile: one panel at a time with a tab bar — never tiny unreadable charts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PriceChart, ChartErrorBoundary, type PriceMark } from "@/components/terminal/PriceChart";
import type { ServerOrder, ServerPosition } from "@/lib/trading-api";
import { LAYOUTS, LAYOUT_ORDER, dividers, gridStyle, normWeights, pointerPct, pointerPctY, resizePair, type DividerSeg, type LayoutId } from "@/lib/chart-layouts";
import { loadLastActive, saveLastActive } from "@/lib/workspace-presets";
import { loadSyncSettings, saveSyncSettings, type SyncSettings } from "@/lib/chart-sync";
import { WorkspaceDialog } from "@/components/terminal/chart/WorkspaceDialog";
import type { WorkspacePreset } from "@/lib/workspace-presets";
import type { ChartType } from "@/lib/chart-types";
import type { Timeframe } from "@shared/terminal";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

const LS_LAYOUT = "it_mc_layout";

interface PanelState { symbol: string; timeframe: Timeframe; chartType?: ChartType }

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 700 : false));
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 699px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** tiny layout glyph for the selector */
function LayoutGlyph({ id }: { id: LayoutId }) {
  const def = LAYOUTS[id];
  const cols = def.cols;
  const rows = def.rows;
  const cells = def.cells;
  return (
    <span className="inline-grid gap-px" style={{ gridTemplateColumns: `repeat(${cols}, 8px)`, gridTemplateRows: `repeat(${rows}, 6px)` }}>
      {Array.from({ length: cols * rows }, (_, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const filled = cells.some((cc) => cc.c <= c && cc.c + (cc.cs ?? 1) > c && cc.r <= r && cc.r + (cc.rs ?? 1) > r);
        return <span key={i} className={cn("rounded-[1px]", filled ? "bg-current" : "bg-current/20")} />;
      })}
    </span>
  );
}

export function MultiChartWorkspace({
  symbol, timeframe, onSymbolChange, onTimeframeChange,
  orders, positions, accountId, onModifyPosition, onModifyOrder, onCancelOrder, onClosePosition, accountBalance,
  onOpenAlerts, onOpenReplay,
  /** P76 — bar-replay state flows ONLY into the primary panel (index 0):
   *  selection mode / session bars replace that panel's live feed while the
   *  other panels keep their own live subscriptions. */
  replaySelect = false, onReplaySelect = null, onReplaySelectCancel = null,
  replayBars = null, replayCursor = null, replayForming = null, replayStatus = null,
  replayPositions = null, replayMarks = null,
  /** P56 UX: the layout picker moved into the events strip — the parent owns
   *  the layout state; the internal fallback keeps the harness working */
  layout: layoutProp, onLayoutChange,
}: {
  symbol: string;
  timeframe: Timeframe;
  onSymbolChange: (s: string) => void;
  onTimeframeChange: (tf: Timeframe) => void;
  orders: ServerOrder[];
  positions: ServerPosition[];
  accountId: string | null;
  onModifyPosition: (positionId: string, patch: { sl?: number | null; tp?: number | null; tsPct?: number }) => Promise<unknown>;
  /** P54 §3 — chart-based pending-order management (drag + details panel) */
  onModifyOrder?: (orderId: string, patch: { price?: number; sl?: number | null; tp?: number | null }) => Promise<unknown>;
  onCancelOrder?: (orderId: string) => Promise<unknown>;
  onClosePosition?: (positionId: string, lots?: number) => Promise<unknown>;
  accountBalance: number | null;
  /** toolbar alert bell → open the terminal right rail (per user action) */
  onOpenAlerts: () => void;
  /** toolbar replay button → arm candle selection on the primary chart */
  onOpenReplay: () => void;
  layout?: LayoutId;
  onLayoutChange?: (id: LayoutId) => void;
  /* ---- P76 replay props (see above) ---- */
  replaySelect?: boolean;
  onReplaySelect?: ((timeSec: number) => void) | null;
  onReplaySelectCancel?: (() => void) | null;
  replayBars?: import("@shared/terminal").Bar[] | null;
  replayCursor?: number | null;
  replayForming?: import("@shared/terminal").Bar | null;
  replayStatus?: string | null;
  replayPositions?: ServerPosition[] | null;
  replayMarks?: PriceMark[] | null;
}) {
  const narrow = useIsNarrow();
  const [layoutInner, setLayoutInner] = useState<LayoutId>(() => {
    try { const v = localStorage.getItem(LS_LAYOUT) as LayoutId | null; if (v && LAYOUT_ORDER.includes(v)) return v; } catch { /* ignore */ }
    return "1";
  });
  const layout = layoutProp ?? layoutInner;
  const setLayout = useCallback((id: LayoutId) => {
    setLayoutInner(id);
    onLayoutChange?.(id);
  }, [onLayoutChange]);
  const def = LAYOUTS[layout];
  // panels 1..N are workspace-owned; panel 0 mirrors the terminal's primary state
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [colW, setColW] = useState<number[]>([]);
  const [rowH, setRowH] = useState<number[]>([]);
  const [mobilePanel, setMobilePanel] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; axis: "c" | "r"; idx: number; base: number[] } | null>(null);

  // ---- Phase 59: the P48 sync feature shipped WITHOUT any UI — the bus was
  // ---- PHASE 60: named workspace manager --------------------------------
  const [wsOpen, setWsOpen] = useState(false);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const applyWorkspace = useCallback((w: WorkspacePreset) => {
    // Phase 60: apply a saved grid — layout, per-panel instruments/TFs/types
    // and the captured sync toggles. Fresh market data loads through the
    // normal provider path (nothing stale is ever restored).
    setLayout(w.layout);
    const first = w.panels[0];
    if (first) {
      if (first.symbol !== symbol) onSymbolChange(first.symbol);
      if (first.timeframe !== timeframe) onTimeframeChange(first.timeframe as Timeframe);
    }
    setPanels(w.panels.slice(1).map((p) => ({
      symbol: p.symbol,
      timeframe: p.timeframe as Timeframe,
      chartType: p.chartType,
    })));
    if (w.colW?.length) setColW(w.colW);
    if (w.rowH?.length) setRowH(w.rowH);
    if (w.sync) {
      saveSyncSettings({ crosshair: w.sync.crosshair, time: w.sync.time, symbol: w.sync.symbol, interval: w.sync.interval });
    }
    setActiveWsId(w.id);
  }, [symbol, timeframe, onSymbolChange, onTimeframeChange]);

  // ---- PHASE 60 Part 7: honest autosave indicator ------------------------
  // PHASE 62 (user request): the "Saved" chip UI was removed with the top
  // strip — autosave still runs silently (RTDB last-active snapshot).


  // initialize extra panels + restore the last-active workspace (P48 §4)
  useEffect(() => {
    void (async () => {
      const last = await loadLastActive().catch(() => null);
      // Phase 60: fall back to the user's marked-DEFAULT workspace when no
      // last-active snapshot exists (fresh account / cleared storage)
      if (!last) {
        const { getDefaultWorkspace } = await import("@/lib/workspace-presets");
        const def = await getDefaultWorkspace().catch(() => null);
        if (def && LAYOUT_ORDER.includes(def.layout) && def.layout !== "1") {
          setLayout(def.layout);
          setPanels(def.panels.slice(1).map((p) => ({
            symbol: p.symbol,
            timeframe: p.timeframe as Timeframe,
            chartType: p.chartType,
          })));
          if (def.sync) {
            saveSyncSettings({ crosshair: def.sync.crosshair, time: def.sync.time, symbol: def.sync.symbol, interval: def.sync.interval });
          }
        }
      }
      if (last && LAYOUT_ORDER.includes(last.layout) && last.layout !== "1") {
        setLayout(last.layout);
        setPanels(last.panels.slice(1).map((p) => ({ symbol: p.symbol, timeframe: p.timeframe as Timeframe, chartType: p.chartType })));
        if (last.colW?.length) setColW(last.colW);
        if (last.rowH?.length) setRowH(last.rowH);
        try { localStorage.setItem(LS_LAYOUT, last.layout); } catch { /* ignore */ }
      }
    })();
  }, []);

  // keep extra panels in sync with the chosen layout count
  useEffect(() => {
    setPanels((prev) => {
      const want = Math.max(0, def.panels - 1);
      if (prev.length === want) return prev;
      if (prev.length > want) return prev.slice(0, want);
      const add: PanelState[] = [];
      for (let i = prev.length; i < want; i++) {
        add.push({ symbol: symbol, timeframe: timeframe, chartType: undefined });
      }
      return [...prev, ...add];
    });
  }, [def.panels, symbol, timeframe]);

  // persist layout choice + last-active snapshot (debounced)
  useEffect(() => {
    try { localStorage.setItem(LS_LAYOUT, layout); } catch { /* ignore */ }
    const t = setTimeout(() => {
      saveLastActive({
        layout,
        panels: [{ symbol, timeframe }, ...panels],
        colW: colW.length ? colW : undefined,
        rowH: rowH.length ? rowH : undefined,
      }).catch(() => { /* offline — the next debounce retries */ });
    }, 900);
    return () => clearTimeout(t);
  }, [layout, symbol, timeframe, panels, colW, rowH]);

  const setPanelSymbol = useCallback((i: number, s: string) => {
    if (i === 0) {
      onSymbolChange(s);
      // symbol sync: the primary change cascades to every workspace panel
      if (loadSyncSettings().symbol) setPanels((prev) => prev.map((p) => ({ ...p, symbol: s })));
      return;
    }
    setPanels((prev) => {
      const next = [...prev];
      if (next[i - 1]) next[i - 1] = { ...next[i - 1], symbol: s };
      return next;
    });
    if (loadSyncSettings().symbol) onSymbolChange(s); // panel change → primary too
  }, [onSymbolChange]);

  const setPanelTimeframe = useCallback((i: number, tf: Timeframe) => {
    if (i === 0) {
      onTimeframeChange(tf);
      if (loadSyncSettings().interval) setPanels((prev) => prev.map((p) => ({ ...p, timeframe: tf })));
      return;
    }
    setPanels((prev) => {
      const next = [...prev];
      if (next[i - 1]) next[i - 1] = { ...next[i - 1], timeframe: tf };
      return next;
    });
    if (loadSyncSettings().interval) onTimeframeChange(tf);
  }, [onTimeframeChange]);

  const setPanelType = useCallback((i: number, t: ChartType) => {
    if (i === 0) return; // primary keeps the legacy global chart-type store
    setPanels((prev) => {
      const next = [...prev];
      if (next[i - 1]) next[i - 1] = { ...next[i - 1], chartType: t };
      return next;
    });
  }, []);

  // ---- resize (P48 §1) ---------------------------------------------------------
  const onDividerDown = (seg: DividerSeg) => (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const axis = seg.id.startsWith("c") ? "c" : "r";
    const idx = Number(seg.id.slice(1).split("@")[0]);
    const isCol = axis === "c";
    dragRef.current = { id: seg.id, axis, idx, base: isCol ? normWeights(colW, def.cols) : normWeights(rowH, def.rows) };
  };

  const onDividerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const grid = gridRef.current;
    if (!drag || !grid) return;
    const rect = grid.getBoundingClientRect();
    if (drag.axis === "c") {
      const pct = pointerPct(rect, e.clientX);
      // full track span for this pair: from track start to track end
      const cols = normWeights(drag.base, drag.base.length);
      const tot = cols.reduce((a, b) => a + b, 0);
      const before = cols.slice(0, drag.idx).reduce((a, b) => a + b, 0) / tot * 100;
      const pairSpan = (cols[drag.idx] + cols[drag.idx + 1]) / tot * 100;
      setColW(resizePair(drag.base, drag.idx, before, pairSpan, pct));
    } else {
      const pct = pointerPctY(rect, e.clientY);
      const rows = normWeights(drag.base, drag.base.length);
      const tot = rows.reduce((a, b) => a + b, 0);
      const before = rows.slice(0, drag.idx).reduce((a, b) => a + b, 0) / tot * 100;
      const pairSpan = (rows[drag.idx] + rows[drag.idx + 1]) / tot * 100;
      setRowH(resizePair(drag.base, drag.idx, before, pairSpan, pct));
    }
  };

  const onDividerUp = () => { dragRef.current = null; };

  // ---- per-panel live data --------------------------------------------------------
  // PHASE 63 §5/§6 — pending orders are drawn ONCE, by the draggable
  // order-entry TradeLines (canvas chips); the duplicate amber PriceMark
  // line is retired (double rendering of the same order).
  const marksFor = useCallback((_sym: string): PriceMark[] => [], []);

  const allPanels: PanelState[] = useMemo(() => [{ symbol, timeframe }, ...panels], [symbol, timeframe, panels]);
  const gridCols = normWeights(colW, def.cols);
  const gridRows = normWeights(rowH, def.rows);
  const segs = useMemo(() => dividers(def, gridCols, gridRows), [def, gridCols, gridRows]);
  const style = useMemo(() => gridStyle(def, gridCols, gridRows), [def, gridCols, gridRows]);

  const renderPanel = (i: number, cellIndex: number) => {
    const p = allPanels[i] ?? { symbol, timeframe };
    const cell = def.cells[cellIndex];
    const isActive = !narrow || mobilePanel === i;
    return (
      <div
        key={`panel-${i}`}
        data-mc-panel={i}
        className={cn(
          "relative min-h-0 min-w-0 overflow-hidden rounded-md border border-slate-800 bg-[#0b1220]",
          !narrow && "hover:border-slate-600",
          narrow && !isActive && "hidden",
        )}
        style={{
          gridColumn: `${cell.c + 1} / span ${cell.cs ?? 1}`,
          gridRow: `${cell.r + 1} / span ${cell.rs ?? 1}`,
        }}
      >
        {/* P78 — a crashing chart must not take the whole site down through the
            app-level boundary: this isolates the crash to its own tile and
            offers a one-click restart that also re-applies the saved theme */}
        <ChartErrorBoundary className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
          <PriceChart
            symbol={p.symbol}
            timeframe={p.timeframe}
            marks={i === 0 && replayMarks ? replayMarks : marksFor(p.symbol)}
            accountId={i === 0 && replayBars ? null : accountId}
            positions={(i === 0 && replayPositions ? replayPositions : positions).filter((pos) => pos.symbol === p.symbol) as ServerPosition[]}
            orders={orders.filter((o) => o.symbol === p.symbol)}
            onModifyPosition={onModifyPosition}
            onModifyOrder={onModifyOrder}
            onCancelOrder={onCancelOrder}
            onClosePosition={onClosePosition}
            onSymbolChange={(s) => setPanelSymbol(i, s)}
            onTimeframeChange={(tf) => setPanelTimeframe(i, tf)}
            onOpenAlerts={onOpenAlerts}
            onOpenReplay={onOpenReplay}
            accountBalance={accountBalance}
            panelKey={`mc-${i}`}
            chartType={i === 0 ? null : p.chartType ?? null}
            onChartTypeChange={i === 0 ? null : (t) => setPanelType(i, t)}
            {...(i === 0 ? {
              replaySelect,
              onReplaySelect: onReplaySelect ?? undefined,
              onReplaySelectCancel: onReplaySelectCancel ?? undefined,
              replayBars,
              replayCursor,
              replayForming,
              replayStatus,
            } : {})}
          />
        </ChartErrorBoundary>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* PHASE 62 (user request): the labeled top strip (Saved / Workspaces /
          Sync / Crosshair / Time range / Symbol / Interval) is REMOVED — the
          terminal chrome must stay clean like a professional charting default.
          Workspaces stay reachable from the main toolbar; sync toggles live in
          Terminal settings → Sync. Autosave continues silently in the
          background and sync settings persist as configured. */}
      <WorkspaceDialog
        open={wsOpen}
        onClose={() => setWsOpen(false)}
        currentSymbol={symbol}
        currentTimeframe={timeframe}
        currentPanels={allPanels.map((p) => ({ symbol: p.symbol, timeframe: p.timeframe }))}
        onApply={applyWorkspace}
        activeId={activeWsId}
      />
      {/* mobile: tab bar + one panel (never tiny unreadable charts, P48 §7) */}
      {narrow && def.panels > 1 && (
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-950/60 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {allPanels.map((p, i) => (
            <button
              key={`tab-${i}`}
              onClick={() => setMobilePanel(i)}
              className={cn("shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold", mobilePanel === i ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200")}
            >
              {i + 1} · {p.symbol}
            </button>
          ))}
        </div>
      )}

      {/* grid + drag handles */}
      <div
        ref={gridRef}
        className="relative min-h-0 min-w-0 flex-1 gap-1 p-1"
        style={{ display: narrow ? "block" : "grid", ...style }}
      >
        {def.cells.map((_, cellIndex) => renderPanel(cellIndex, cellIndex))}
        {!narrow && segs.map((seg) => (
          seg.id.startsWith("c") ? (
            <div
              key={seg.id}
              onPointerDown={onDividerDown(seg)}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              title="Drag to resize panels"
              className="absolute z-20 -ml-1.5 w-3 cursor-col-resize touch-none"
              style={{ left: `${seg.left}%`, top: `${seg.top}%`, height: `${seg.height}%` }}
            >
              <div className="mx-auto h-full w-px rounded bg-slate-700/0 transition-colors hover:bg-sky-400/80" />
            </div>
          ) : (
            <div
              key={seg.id}
              onPointerDown={onDividerDown(seg)}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              title="Drag to resize panels"
              className="absolute z-20 -mt-1.5 h-3 cursor-row-resize touch-none"
              style={{ left: `${seg.left}%`, top: `${seg.top}%`, width: `${seg.width}%` }}
            >
              <div className="my-auto w-full h-px rounded bg-slate-700/0 transition-colors hover:bg-sky-400/80" />
            </div>
          )
        ))}
      </div>
    </div>
  );
}


/** P56 UX — the 6-layout split picker, rendered inside the events strip
 *  (the old workspace bar was removed to give the chart more height). */
export function LayoutPicker({ layout, onChange }: { layout: LayoutId; onChange: (id: LayoutId) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-slate-700/70 bg-slate-950/60 p-0.5" role="group" aria-label="Chart layout">
      {LAYOUT_ORDER.map((id) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          title={LAYOUTS[id].label}
          className={cn(
            "flex items-center justify-center rounded px-1.5 py-1 text-slate-400 transition-colors",
            layout === id ? "bg-sky-600 text-white" : "hover:bg-slate-800 hover:text-slate-200",
          )}
        >
          <LayoutGlyph id={id} />
        </button>
      ))}
    </div>
  );
}
