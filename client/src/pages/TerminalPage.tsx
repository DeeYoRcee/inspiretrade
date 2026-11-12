/**
 * InspireTrade Terminal — the main trading workspace page.
 *
 * Existing: toolbar (instrument / timeframes / chart type / indicators /
 * volume / layouts / fullscreen), drawing toolbar, chart grid, side panel
 * (trade / challenge / calendar / alerts / risk), market watch.
 * Advanced tools (launched via the searchable Tools palette or toolbar):
 * bar replay, strategy tester, sessions, heatmap, screener, MTF, volume
 * analysis, workspace templates, chart comparison, prop-firm analytics,
 * calculators — all fed by REAL data through the terminal feed layer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Maximize, Minimize, BarChart2, LayoutGrid, Columns2, Square,
  Undo2, Redo2, Trash2, Lock, Eye, MousePointer2, Minus, MoveUp,
  MoveUpRight, SquareDashed, Ruler, TrendingUp, TrendingDown,
  Type, ArrowRight, Pencil, GitCompareArrows, Layers, Activity, LineChart,
  Spline, MoveDiagonal, Wrench, Calculator,
} from "lucide-react";
import { INSTRUMENTS, CHART_TYPES, TIMEFRAMES, type Bar, type ChartType, type Timeframe } from "@shared/terminal";
import { useLanguage } from "@/lib/language-context";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useTerminalWorkspace, useDrawingsStore, type TerminalSettings } from "@/hooks/use-terminal-workspace";
import { useTerminalTrading } from "@/hooks/use-terminal-trading";
import { TerminalChart, type ActiveIndicator } from "@/components/terminal/TerminalChart";
import { MarketWatch } from "@/components/terminal/MarketWatch";
import { TradingPanel } from "@/components/terminal/TradingPanel";
import { ChallengeDashboard } from "@/components/terminal/ChallengeDashboard";
import { CalendarPanel } from "@/components/terminal/CalendarPanel";
import { AlertsPanel, useTerminalAlerts } from "@/components/terminal/AlertsPanel";
import { RiskCalculator } from "@/components/terminal/RiskCalculator";
import { IndicatorDialog } from "@/components/terminal/IndicatorDialog";
import { ToolDrawer } from "@/components/terminal/ToolDrawer";
import { ToolsDialog, type ToolId } from "@/components/terminal/ToolsDialog";
import { ReplayPanel, type ReplayState } from "@/components/terminal/ReplayPanel";
import { StrategyTester } from "@/components/terminal/StrategyTester";
import { SessionsPanel } from "@/components/terminal/SessionsPanel";
import { HeatmapPanel } from "@/components/terminal/HeatmapPanel";
import { ScreenerPanel } from "@/components/terminal/ScreenerPanel";
import { MtfPanel } from "@/components/terminal/MtfPanel";
import { VolumePanel } from "@/components/terminal/VolumePanel";
import { TemplatesPanel } from "@/components/terminal/TemplatesPanel";
import { ComparisonPanel } from "@/components/terminal/ComparisonPanel";
import { PropAnalyticsPanel } from "@/components/terminal/PropAnalyticsPanel";
import { CalculatorsDialog } from "@/components/terminal/CalculatorsDialog";
import { evaluateAlert, type AlertContext } from "@/lib/terminal/alert-engine";
import { loadBarsCached } from "@/lib/terminal/data-feeds";
import { DEFAULT_OVERLAY, type OverlayConfig } from "@/lib/terminal/chart-overlay";
import { drawingsBus } from "@/lib/terminal/drawings-bus";
import type { DrawingTool } from "@/lib/terminal/drawings";
import { cn } from "@/lib/utils";

const TOOLS: { id: DrawingTool; icon: any; title: string }[] = [
  { id: "cursor", icon: MousePointer2, title: "Cursor" },
  { id: "trendline", icon: MoveUpRight, title: "Trend line" },
  { id: "hline", icon: Minus, title: "Horizontal line" },
  { id: "vline", icon: MoveUp, title: "Vertical line" },
  { id: "ray", icon: MoveUpRight, title: "Ray" },
  { id: "extline", icon: MoveUpRight, title: "Extended line" },
  { id: "rect", icon: SquareDashed, title: "Rectangle" },
  { id: "fib", icon: GitCompareArrows, title: "Fibonacci retracement" },
  { id: "fibext", icon: Spline, title: "Fibonacci extension" },
  { id: "channel", icon: MoveDiagonal, title: "Parallel channel" },
  { id: "brush", icon: Pencil, title: "Brush" },
  { id: "text", icon: Type, title: "Text" },
  { id: "arrow", icon: ArrowRight, title: "Arrow" },
  { id: "long", icon: TrendingUp, title: "Long position" },
  { id: "short", icon: TrendingDown, title: "Short position" },
  { id: "measure", icon: Ruler, title: "Measure" },
];

type SideTab = "trade" | "challenge" | "calendar" | "alerts" | "risk";

const DRAWER_TITLES: Partial<Record<ToolId, { title: string; subtitle: string }>> = {
  backtest: { title: "Strategy Tester", subtitle: "Backtest rules on real historical data — no look-ahead" },
  sessions: { title: "Session Analyzer", subtitle: "Sydney · Tokyo · London · New York — DST-correct" },
  heatmap: { title: "Market Heatmap", subtitle: "Daily performance + currency strength" },
  screener: { title: "Market Screener", subtitle: "Multi-filter scan across every instrument" },
  mtf: { title: "Multi-Timeframe Analysis", subtitle: "M1 → D1 trend classification" },
  volume: { title: "Volume Analysis", subtitle: "Profile · POC/VAH/VAL · anchored VWAP · delta" },
  templates: { title: "Workspace Templates", subtitle: "Save / restore complete chart setups" },
  analytics: { title: "Prop Firm Analytics", subtitle: "Your demo-account trade history" },
  compare: { title: "Chart Comparison", subtitle: "Normalized performance of two instruments" },
};

function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; gain.gain.value = 0.05;
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch { /* autoplay blocked */ }
}

export default function TerminalPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const { settings, update } = useTerminalWorkspace();
  const { alerts, patchAlert } = useTerminalAlerts();
  const { account, positions } = useTerminalTrading();

  const [activeTool, setActiveTool] = useState<DrawingTool>("cursor");
  const [indDialog, setIndDialog] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>("trade");
  const [mobilePanel, setMobilePanel] = useState(false);
  const [mobileWatch, setMobileWatch] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // advanced tools
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [replayBarOpen, setReplayBarOpen] = useState(false);
  const [overlay, setOverlay] = useState<OverlayConfig>(() => {
    try { return { ...DEFAULT_OVERLAY, ...(JSON.parse(localStorage.getItem("terminalOverlay") ?? "null") ?? {}) }; } catch { return DEFAULT_OVERLAY; }
  });
  const [anchor, setAnchor] = useState<number | null>(() => {
    const v = localStorage.getItem("terminalAvwap"); return v ? Number(v) : null;
  });
  const [compare, setCompare] = useState<string | null>(() => localStorage.getItem("terminalCompare") || null);

  useEffect(() => { localStorage.setItem("terminalOverlay", JSON.stringify(overlay)); }, [overlay]);
  useEffect(() => { anchor == null ? localStorage.removeItem("terminalAvwap") : localStorage.setItem("terminalAvwap", String(anchor)); }, [anchor]);
  useEffect(() => { compare == null ? localStorage.removeItem("terminalCompare") : localStorage.setItem("terminalCompare", compare); }, [compare]);

  const { drawings, save } = useDrawingsStore(user?.uid, settings.symbol);

  const onLastBar = useMemo(
    () => (bar: { time: number; close: number }) => setPrices((p) => ({ ...p, [settings.symbol]: bar.close })),
    [settings.symbol],
  );

  // ---- advanced alert engine (v2) — 30s loop + 60s bar cache ----------------
  const alertBarsRef = useRef<Map<string, Bar[]>>(new Map());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const needs = new Map<string, Timeframe>();
      for (const a of alerts) {
        if (a.paused) continue;
        const kind = a.kind ?? "price";
        if (["rsi", "macd", "emaCross", "bbBreakout", "trendline"].includes(kind) && a.timeframe) {
          needs.set(`${a.symbol}:${a.timeframe}`, a.timeframe);
        } else if (kind === "dailyHL") {
          needs.set(`${a.symbol}:1d`, "1d");
        }
      }
      for (const [key, tf] of needs) {
        const sym = key.slice(0, key.lastIndexOf(":"));
        try {
          const bars = await loadBarsCached(sym, tf, 500);
          if (alive) alertBarsRef.current.set(key, bars);
        } catch { /* feed unavailable — alert skipped this cycle */ }
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [alerts]);

  useEffect(() => {
    let busy = false;
    const evaluate = async () => {
      if (busy || !alerts.length) return;
      busy = true;
      const ctx: AlertContext = {
        prices,
        bars: (sym, tf) => alertBarsRef.current.get(`${sym}:${tf}`),
        drawings: (sym) => (sym === settings.symbol ? drawings : []),
      };
      for (const a of alerts) {
        const fire = evaluateAlert(a, ctx);
        if (!fire) continue;
        toast({ title: `🔔 ${fire.title}` });
        if (settings.sound) playBeep();
        try {
          await patchAlert(a.id, {
            lastTriggeredAt: Date.now(),
            history: [...(a.history ?? []).slice(-19), { at: Date.now(), price: fire.value }],
          });
        } catch { /* trigger state write failed — cooldown may repeat once */ }
      }
      busy = false;
    };
    evaluate();
    const id = setInterval(evaluate, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts, prices, drawings, settings.symbol]);

  const openCount = positions.filter((p) => p.status === "open").length;
  const price = prices[settings.symbol] ?? null;

  const toggleFullscreen = () => {
    const el = gridRef.current?.parentElement;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  // keep the fullscreen button in sync (F11-style exit, ESC)
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const launchTool = (id: ToolId) => {
    if (id === "replay") { setReplayBarOpen(true); return; }
    setTool(id);
  };

  const chartNode = (i: number) => (
    <TerminalChart
      key={`chart-${i}-${settings.symbol}-${settings.timeframe}`}
      symbol={settings.symbol}
      timeframe={settings.timeframe}
      chartType={settings.chartType}
      indicators={settings.indicators}
      showVolume={settings.showVolume}
      colors={settings.colors}
      drawings={drawings}
      onDrawingsChange={save}
      activeTool={activeTool}
      onLastBar={i === 0 ? onLastBar : undefined}
      onToggleVolume={() => update({ showVolume: !settings.showVolume })}
      onRequestFullscreen={toggleFullscreen}
      replay={replay}
      overlayCfg={overlay}
      anchoredVwapTime={anchor}
      compareSymbol={compare}
      onAnchorVwap={setAnchor}
      height={420}
    />
  );

  const sidePanel = (cls?: string) =>
    sideTab === "trade" ? <TradingPanel symbol={settings.symbol} price={price} className={cls} /> :
    sideTab === "challenge" ? <ChallengeDashboard prices={prices} className={cls} /> :
    sideTab === "calendar" ? <CalendarPanel symbol={settings.symbol} className={cls} /> :
    sideTab === "alerts" ? <AlertsPanel prices={prices} drawings={drawings} className={cls} /> :
    <RiskCalculator symbol={settings.symbol} price={price} balance={account?.balance ?? 0} className={cls} />;

  const chartGrid = (
    <div
      className={cn(
        "grid h-full min-h-0 w-full flex-1 gap-1.5",
        settings.layout === 1 && "grid-cols-1 grid-rows-1",
        settings.layout === 2 && "grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1",
        settings.layout === 4 && "grid-cols-1 grid-rows-2 sm:grid-cols-2",
      )}
    >
      {Array.from({ length: settings.layout }, (_, i) => chartNode(i))}
    </div>
  );

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[520px] flex-col gap-1.5">
      {/* ===== toolbar ===== */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/50 bg-card/60 p-1.5">
        <select
          value={settings.symbol}
          onChange={(e) => update({ symbol: e.target.value })}
          className="num-input h-8 w-28 font-bold"
          aria-label="Instrument"
        >
          {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
        </select>

        <div className="flex max-w-full overflow-x-auto rounded-lg border border-border/60">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => update({ timeframe: tf as Timeframe })}
              className={cn("shrink-0 px-2 py-1 text-[11px] font-semibold transition-colors", settings.timeframe === tf ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:text-foreground")}
            >
              {tf.toUpperCase()}
            </button>
          ))}
        </div>

        <select
          value={settings.chartType}
          onChange={(e) => update({ chartType: e.target.value as ChartType })}
          className="num-input h-8 w-32"
          aria-label="Chart type"
        >
          {CHART_TYPES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>

        <button onClick={() => setIndDialog(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground">
          <Layers className="h-3.5 w-3.5" />{t("indicators")}
          {settings.indicators.length > 0 && <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-400">{settings.indicators.length}</span>}
        </button>

        <button
          onClick={() => update({ showVolume: !settings.showVolume })}
          className={cn("flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold", settings.showVolume ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground")}
          title="Volume"
        >
          <BarChart2 className="h-3.5 w-3.5" />Vol
        </button>

        <button
          onClick={() => setToolsOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 text-[11px] font-bold text-sky-400 hover:bg-sky-500/20"
          title="Search tools (replay, backtest, sessions, heatmap…)"
        >
          <Wrench className="h-3.5 w-3.5" />Tools
        </button>
        <button
          onClick={() => setCalcOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground"
          title="Trading calculators"
        >
          <Calculator className="h-3.5 w-3.5" />
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          {([1, 2, 4] as const).map((l) => (
            <button
              key={l}
              onClick={() => update({ layout: l })}
              className={cn("flex h-8 w-8 items-center justify-center rounded-lg border", settings.layout === l ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}
              title={`${l} chart${l > 1 ? "s" : ""}`}
            >
              {l === 1 ? <Square className="h-3.5 w-3.5" /> : l === 2 ? <Columns2 className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
            </button>
          ))}
          <button onClick={toggleFullscreen} className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground" title="Fullscreen">
            {fullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* ===== workspace ===== */}
      <div className="relative flex min-h-0 flex-1 gap-1.5" ref={gridRef}>
        {/* drawing toolbar */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto rounded-xl border border-border/50 bg-card/60 py-1.5">
          {TOOLS.map(({ id, icon: Icon, title }) => (
            <button
              key={id}
              onClick={() => setActiveTool(id)}
              className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors", activeTool === id ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:text-foreground hover:bg-card")}
              title={title}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
          <div className="my-1 h-px w-6 shrink-0 bg-border/60" />
          <button onClick={() => drawingsBus.emit({ cmd: "undo" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" title="Undo"><Undo2 className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "redo" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" title="Redo"><Redo2 className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "lock" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" title="Lock selected"><Lock className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "hide" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" title="Hide selected"><Eye className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "delete" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-red-400" title="Delete selected"><Trash2 className="h-3.5 w-3.5" /></button>
          <div className="my-1 h-px w-6 shrink-0 bg-border/60" />
          <input type="color" defaultValue={settings.colors.accent} onChange={(e) => drawingsBus.emit({ cmd: "style", arg: { color: e.target.value } })} className="h-6 w-7 shrink-0 cursor-pointer rounded" title="Color" />
          <select defaultValue="2" onChange={(e) => drawingsBus.emit({ cmd: "style", arg: { width: Number(e.target.value) } })} className="h-6 w-9 shrink-0 rounded border border-border/60 bg-transparent text-[10px] text-muted-foreground" title="Width">
            {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>

        {/* charts (desktop) — flex-col so the grid gets a DEFINITE height. */}
        <div className="hidden min-h-0 min-w-0 flex-1 md:flex md:flex-col">{chartGrid}</div>

        {/* charts (mobile) */}
        <div className="flex min-h-0 w-full flex-col gap-1.5 md:hidden">
          <div className="min-h-0 flex-1">{chartNode(0)}</div>
          {mobilePanel && (
            <div className="h-72 overflow-hidden rounded-xl border border-border/50 bg-card">
              {sidePanel("h-full")}
            </div>
          )}
          {mobileWatch && (
            <div className="h-64 overflow-hidden rounded-xl border border-border/50 bg-card">
              <MarketWatch active={settings.symbol} onSelect={(s) => update({ symbol: s })} className="h-full" />
            </div>
          )}
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => { setMobilePanel((v) => !v); setMobileWatch(false); }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 py-2 text-xs font-bold text-emerald-400"
            >
              <Activity className="h-4 w-4" />
              {mobilePanel ? t("hidePanel") : t("showPanel")} ({openCount})
            </button>
            <button
              onClick={() => { setMobileWatch((v) => !v); setMobilePanel(false); }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/60 bg-card/60 py-2 text-xs font-bold text-muted-foreground"
            >
              <LineChart className="h-4 w-4" />{t("marketWatch")}
            </button>
          </div>
        </div>

        {/* side panel (desktop) */}
        <div className="hidden w-80 shrink-0 md:block">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/50 bg-card/60">
            <div className="flex shrink-0 gap-0.5 border-b border-border/40 p-1">
              {(["trade", "challenge", "calendar", "alerts", "risk"] as SideTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSideTab(tab)}
                  className={cn("flex-1 rounded-lg px-1 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors", sideTab === tab ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground hover:text-foreground")}
                >
                  {tab === "trade" ? t("tabTrade") : tab === "challenge" ? t("tabChallenge") : tab === "calendar" ? t("tabCalendar") : tab === "alerts" ? t("tabAlerts") : t("tabRisk")}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{sidePanel()}</div>
          </div>
        </div>

        {/* floating replay bar */}
        {replayBarOpen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-2">
            <div className="pointer-events-auto w-full max-w-2xl">
              <ReplayPanel
                symbol={settings.symbol}
                timeframe={settings.timeframe}
                replay={replay}
                setReplay={setReplay}
              />
            </div>
          </div>
        )}

        {/* advanced tool drawers */}
        <ToolDrawer open={tool != null} onClose={() => setTool(null)}
          title={tool ? DRAWER_TITLES[tool]?.title ?? tool : ""}
          subtitle={tool ? DRAWER_TITLES[tool]?.subtitle : undefined}>
          {tool === "backtest" && <StrategyTester symbol={settings.symbol} />}
          {tool === "sessions" && <SessionsPanel symbol={settings.symbol} timeframe={settings.timeframe} overlay={overlay} setOverlay={setOverlay} />}
          {tool === "heatmap" && <HeatmapPanel onSelect={(s) => { update({ symbol: s }); setTool(null); }} />}
          {tool === "screener" && <ScreenerPanel onSelect={(s) => { update({ symbol: s }); setTool(null); }} />}
          {tool === "mtf" && <MtfPanel symbol={settings.symbol} onSelect={(s) => update({ symbol: s })} />}
          {tool === "volume" && <VolumePanel symbol={settings.symbol} timeframe={settings.timeframe} overlay={overlay} setOverlay={setOverlay} anchor={anchor} setAnchor={setAnchor} />}
          {tool === "templates" && <TemplatesPanel settings={settings} currentDrawings={drawings} onApply={(s: TerminalSettings) => update(s)} />}
          {tool === "analytics" && <PropAnalyticsPanel />}
          {tool === "compare" && <ComparisonPanel symbol={settings.symbol} compare={compare} setCompare={setCompare} onSelect={(s) => { update({ symbol: s }); setTool(null); }} />}
        </ToolDrawer>
      </div>

      {/* ===== market watch strip (desktop) ===== */}
      <div className="hidden h-40 shrink-0 overflow-hidden rounded-xl border border-border/50 bg-card/60 md:block">
        <MarketWatch active={settings.symbol} onSelect={(s) => update({ symbol: s })} className="h-full" />
      </div>

      <IndicatorDialog open={indDialog} onOpenChange={setIndDialog} active={settings.indicators} onChange={(list: ActiveIndicator[]) => update({ indicators: list })} />
      <ToolsDialog open={toolsOpen} onOpenChange={setToolsOpen} onLaunch={launchTool} />
      <CalculatorsDialog open={calcOpen} onOpenChange={setCalcOpen} symbol={settings.symbol} prices={prices} />
    </div>
  );
}
