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
import { Check, ChevronDown, Copy, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PriceChart, type PriceMark } from "@/components/terminal/PriceChart";
import type { ServerOrder, ServerPosition } from "@/lib/trading-api";
import { LAYOUTS, LAYOUT_ORDER, dividers, gridStyle, normWeights, pointerPct, pointerPctY, resizePair, type DividerSeg, type LayoutId } from "@/lib/chart-layouts";
import {
  WORKSPACE_EVENT, deleteWorkspacePreset, duplicateWorkspacePreset, fetchWorkspaces, loadLastActive,
  renameWorkspacePreset, saveLastActive, saveWorkspacePreset, type WorkspacePreset,
} from "@/lib/workspace-presets";
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
  onClosePosition?: (positionId: string) => Promise<unknown>;
  accountBalance: number | null;
  /** toolbar alert bell → open the terminal right rail (per user action) */
  onOpenAlerts: () => void;
  /** toolbar replay button → switch the terminal to replay mode */
  onOpenReplay: () => void;
}) {
  const narrow = useIsNarrow();
  const [layout, setLayout] = useState<LayoutId>(() => {
    try { const v = localStorage.getItem(LS_LAYOUT) as LayoutId | null; if (v && LAYOUT_ORDER.includes(v)) return v; } catch { /* ignore */ }
    return "1";
  });
  const def = LAYOUTS[layout];
  // panels 1..N are workspace-owned; panel 0 mirrors the terminal's primary state
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [colW, setColW] = useState<number[]>([]);
  const [rowH, setRowH] = useState<number[]>([]);
  const [presets, setPresets] = useState<WorkspacePreset[]>([]);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [mobilePanel, setMobilePanel] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; axis: "c" | "r"; idx: number; base: number[] } | null>(null);

  // initialize extra panels + restore the last-active workspace (P48 §4)
  useEffect(() => {
    void (async () => {
      const last = await loadLastActive().catch(() => null);
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
      void saveLastActive({
        layout,
        panels: [{ symbol, timeframe }, ...panels],
        colW: colW.length ? colW : undefined,
        rowH: rowH.length ? rowH : undefined,
      }).catch(() => {});
    }, 900);
    return () => clearTimeout(t);
  }, [layout, symbol, timeframe, panels, colW, rowH]);

  // presets list (RTDB when signed in)
  useEffect(() => {
    const load = () => { void fetchWorkspaces().then(setPresets).catch(() => setPresets([])); };
    load();
    window.addEventListener(WORKSPACE_EVENT, load);
    return () => window.removeEventListener(WORKSPACE_EVENT, load);
  }, []);

  const setPanelSymbol = useCallback((i: number, s: string) => {
    if (i === 0) onSymbolChange(s);
    else setPanels((prev) => {
      const next = [...prev];
      if (next[i - 1]) next[i - 1] = { ...next[i - 1], symbol: s };
      return next;
    });
  }, [onSymbolChange]);

  const setPanelTimeframe = useCallback((i: number, tf: Timeframe) => {
    if (i === 0) { onTimeframeChange(tf); return; }
    setPanels((prev) => {
      const next = [...prev];
      if (next[i - 1]) next[i - 1] = { ...next[i - 1], timeframe: tf };
      return next;
    });
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

  // ---- presets -------------------------------------------------------------------
  const applyPreset = (p: WorkspacePreset) => {
    setLayout(p.layout);
    setPanels(p.panels.slice(1).map((x) => ({ symbol: x.symbol, timeframe: x.timeframe as Timeframe, chartType: x.chartType })));
    setColW(p.colW ?? []);
    setRowH(p.rowH ?? []);
    // the primary panel follows the preset through the terminal state
    if (p.panels[0]) { onSymbolChange(p.panels[0].symbol); onTimeframeChange(p.panels[0].timeframe as Timeframe); }
    toast({ title: "Workspace applied", description: `${p.name} · ${LAYOUTS[p.layout].label}` });
  };

  const saveCurrent = async () => {
    const name = (savingName ?? "").trim() || `${symbol} ${layout}`;
    const p: WorkspacePreset = {
      id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name, layout, panels: [{ symbol, timeframe }, ...panels], colW, rowH, updatedAt: Date.now(),
    };
    try {
      await saveWorkspacePreset(p);
      toast({ title: "Workspace saved", description: name });
      setSavingName(null);
    } catch (e: any) {
      toast({ title: "Could not save workspace", description: String(e?.message || e), variant: "destructive" });
    }
  };

  // ---- per-panel live data --------------------------------------------------------
  const marksFor = useCallback((sym: string): PriceMark[] => orders
    .filter((o) => o.symbol === sym)
    .map((o) => ({ id: `o-${o.id}`, price: o.price, color: "#f59e0b", title: `${o.kind.toUpperCase()} ${o.lots.toFixed(2)}`, dashed: true })),
  [orders]);

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
        <PriceChart
          symbol={p.symbol}
          timeframe={p.timeframe}
          marks={marksFor(p.symbol)}
          accountId={accountId}
          positions={positions.filter((pos) => pos.symbol === p.symbol) as ServerPosition[]}
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
        />
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* workspace bar — layout selector + sync toggles + presets (P48 §1/§3/§4) */}
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900/80 px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* layouts */}
        <div className="flex items-center gap-0.5 rounded-md border border-slate-700/70 bg-slate-950/60 p-0.5" role="group" aria-label="Chart layout">
          {LAYOUT_ORDER.map((id) => (
            <button
              key={id}
              onClick={() => setLayout(id)}
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

        {/* workspace presets (P48 §4) */}
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-semibold text-slate-300 transition-colors hover:bg-slate-800" title="Saved workspaces">
                Workspaces <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="glass-panel w-64 border-border/60">
              {presets.length === 0 && <p className="px-3 py-3 text-center text-[11px] text-muted-foreground">No saved workspaces yet.</p>}
              {presets.map((p) => (
                <div key={p.id} className="group flex items-center gap-1 px-1.5 py-1">
                  {renaming?.id === p.id ? (
                    <>
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { void renameWorkspacePreset(p.id, renaming.name).then(() => setRenaming(null)); } }}
                        className="h-6 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 text-[11px]"
                      />
                      <button title="Confirm rename" onClick={() => { void renameWorkspacePreset(p.id, renaming.name).then(() => setRenaming(null)); }} className="rounded p-1 text-emerald-400 hover:text-emerald-300"><Check className="h-3 w-3" /></button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => applyPreset(p)} className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[11px] text-slate-200 hover:bg-accent/50" title={`Apply ${p.name}`}>
                        {p.name} <span className="text-[9px] text-muted-foreground">· {p.layout}</span>
                      </button>
                      <button title="Rename" onClick={() => setRenaming({ id: p.id, name: p.name })} className="rounded p-1 text-slate-500 hover:text-slate-200"><Pencil className="h-3 w-3" /></button>
                      <button title="Duplicate" onClick={() => void duplicateWorkspacePreset(p)} className="rounded p-1 text-slate-500 hover:text-slate-200"><Copy className="h-3 w-3" /></button>
                      <button title="Delete" onClick={() => { void deleteWorkspacePreset(p.id); toast({ title: "Workspace deleted", description: p.name }); }} className="rounded p-1 text-slate-500 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                    </>
                  )}
                </div>
              ))}
              <DropdownMenuSeparator />
              <div className="flex items-center gap-1 px-1.5 py-1.5">
                <input
                  value={savingName ?? ""}
                  onChange={(e) => setSavingName(e.target.value)}
                  placeholder="Workspace name…"
                  className="h-6 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 text-[11px]"
                />
                <Button size="sm" className="h-6 bg-sky-600 px-2 hover:bg-sky-500" onClick={() => void saveCurrent()} title="Save the current grid as a workspace">
                  <Save className="h-3 w-3" />
                </Button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            onClick={() => setSavingName((v) => (v == null ? "" : null))}
            title="Save current grid as a workspace"
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {savingName != null && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950/70 px-2">
          <span className="text-[11px] text-slate-400">Name the workspace:</span>
          <input
            autoFocus
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveCurrent(); if (e.key === "Escape") setSavingName(null); }}
            placeholder={`${symbol} · ${LAYOUTS[layout].label}`}
            className="h-6 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-200"
          />
          <Button size="sm" className="h-6 bg-sky-600 px-2 hover:bg-sky-500" onClick={() => void saveCurrent()}>Save</Button>
        </div>
      )}

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

