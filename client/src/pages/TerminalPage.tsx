/**
 * InspireTrade Terminal — the main trading workspace page.
 *
 * Toolbar (instrument / timeframes / chart type / indicators / volume /
 * layouts 1-2-4 / fullscreen) + drawing toolbar + chart grid + side panel
 * (demo trading, challenge dashboard, calendar, alerts, risk) + market watch.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Maximize, Minimize, BarChart2, LayoutGrid, Columns2, Square,
  Undo2, Redo2, Trash2, Lock, Eye, MousePointer2, Minus, MoveUp,
  MoveUpRight, SquareDashed, Ruler, TrendingUp, TrendingDown,
  Type, ArrowRight, Pencil, GitCompareArrows, Layers, Activity, LineChart,
  Spline, MoveDiagonal,
} from "lucide-react";
import { INSTRUMENTS, CHART_TYPES, TIMEFRAMES, type ChartType, type Timeframe } from "@shared/terminal";
import { useLanguage } from "@/lib/language-context";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useTerminalWorkspace, useDrawingsStore } from "@/hooks/use-terminal-workspace";
import { useTerminalTrading } from "@/hooks/use-terminal-trading";
import { TerminalChart, type ActiveIndicator } from "@/components/terminal/TerminalChart";
import { MarketWatch } from "@/components/terminal/MarketWatch";
import { TradingPanel } from "@/components/terminal/TradingPanel";
import { ChallengeDashboard } from "@/components/terminal/ChallengeDashboard";
import { CalendarPanel } from "@/components/terminal/CalendarPanel";
import { AlertsPanel, useTerminalAlerts, checkAlerts } from "@/components/terminal/AlertsPanel";
import { RiskCalculator } from "@/components/terminal/RiskCalculator";
import { IndicatorDialog } from "@/components/terminal/IndicatorDialog";
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

export default function TerminalPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const { settings, update } = useTerminalWorkspace();
  const { alerts } = useTerminalAlerts();
  const { account, positions } = useTerminalTrading();

  const [activeTool, setActiveTool] = useState<DrawingTool>("cursor");
  const [indDialog, setIndDialog] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>("trade");
  const [mobilePanel, setMobilePanel] = useState(false);
  const [mobileWatch, setMobileWatch] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const { drawings, save } = useDrawingsStore(user?.uid, settings.symbol);

  const onLastBar = useMemo(
    () => (bar: { time: number; close: number }) => setPrices((p) => ({ ...p, [settings.symbol]: bar.close })),
    [settings.symbol],
  );

  // alert engine — evaluates on every price tick
  useEffect(() => {
    checkAlerts(alerts, prices, (title, description) => toast({ title, description }), settings.sound).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices]);

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
      height={420}
    />
  );

  const sidePanel = (cls?: string) =>
    sideTab === "trade" ? <TradingPanel symbol={settings.symbol} price={price} className={cls} /> :
    sideTab === "challenge" ? <ChallengeDashboard prices={prices} className={cls} /> :
    sideTab === "calendar" ? <CalendarPanel symbol={settings.symbol} className={cls} /> :
    sideTab === "alerts" ? <AlertsPanel prices={prices} className={cls} /> :
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
      <div className="flex min-h-0 flex-1 gap-1.5" ref={gridRef}>
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

        {/* charts (desktop) — flex-col so the grid gets a DEFINITE height.
            (A plain `md:block` wrapper made the grid auto-height collapse the
            absolutely-positioned chart to 0px — the "blank chart" bug.) */}
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
      </div>

      {/* ===== market watch strip (desktop) ===== */}
      <div className="hidden h-40 shrink-0 overflow-hidden rounded-xl border border-border/50 bg-card/60 md:block">
        <MarketWatch active={settings.symbol} onSelect={(s) => update({ symbol: s })} className="h-full" />
      </div>

      <IndicatorDialog open={indDialog} onOpenChange={setIndDialog} active={settings.indicators} onChange={(list: ActiveIndicator[]) => update({ indicators: list })} />
    </div>
  );
}
