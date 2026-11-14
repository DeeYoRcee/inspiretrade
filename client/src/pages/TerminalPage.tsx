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
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Maximize, Minimize, BarChart2, LayoutGrid, Columns2, Square,
  Undo2, Redo2, Trash2, Lock, Eye, EyeOff, MousePointer2, Minus, MoveUp,
  MoveUpRight, SquareDashed, Ruler, TrendingUp, TrendingDown,
  Type, ArrowRight, Pencil, GitCompareArrows, Layers, Activity,
  Spline, MoveDiagonal, Wrench, Calculator, Camera, Magnet, Shapes, Palette,
  PanelRight, PanelRightClose, ChevronDown, ImagePlus, Check,
} from "lucide-react";
import { INSTRUMENTS, CHART_TYPES, TIMEFRAMES, type Bar, type ChartType, type Timeframe } from "@shared/terminal";
import { useLanguage } from "@/lib/language-context";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useTerminalWorkspace, useDrawingsStore, type TerminalSettings } from "@/hooks/use-terminal-workspace";
import { useTerminalTrading } from "@/hooks/use-terminal-trading";
import { TerminalChart, CHART_THEMES, type ActiveIndicator } from "@/components/terminal/TerminalChart";
import { TradingPanel } from "@/components/terminal/TradingPanel";
import { ChallengeDashboard } from "@/components/terminal/ChallengeDashboard";
import { CalendarPanel } from "@/components/terminal/CalendarPanel";
import { AlertsPanel, useTerminalAlerts } from "@/components/terminal/AlertsPanel";
import { RiskCalculator } from "@/components/terminal/RiskCalculator";
import { IndicatorDialog } from "@/components/terminal/IndicatorDialog";
import { ToolDrawer } from "@/components/terminal/ToolDrawer";
import { ToolsDialog, type ToolId } from "@/components/terminal/ToolsDialog";
import { useReplaySession } from "@/hooks/use-replay";
import { ReplayToolbar } from "@/components/terminal/ReplayToolbar";
import { ReplayTradingPanel } from "@/components/terminal/ReplayTradingPanel";
import { ReplayStatsPanel } from "@/components/terminal/ReplayStatsPanel";
import { ReplayChallengePanel } from "@/components/terminal/ReplayChallengePanel";
import { ReplayMissionsPanel } from "@/components/terminal/ReplayMissionsPanel";
import { ReplayJournalDialog, type JournalDraft } from "@/components/terminal/ReplayJournalDialog";
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

/** Drawing tools grouped TradingView-style: each section has its own label. */
const TOOL_GROUPS: { label: string; accent?: boolean; tools: { id: DrawingTool; icon: any; title: string }[] }[] = [
  { label: "CURSOR", tools: [{ id: "cursor", icon: MousePointer2, title: "Cursor" }] },
  { label: "LINES", tools: [
    { id: "trendline", icon: MoveUpRight, title: "Trend line" },
    { id: "hline", icon: Minus, title: "Horizontal line" },
    { id: "vline", icon: MoveUp, title: "Vertical line" },
    { id: "ray", icon: MoveUpRight, title: "Ray" },
    { id: "extline", icon: MoveUpRight, title: "Extended line" },
    { id: "channel", icon: MoveDiagonal, title: "Parallel channel" },
  ] },
  { label: "FIB", accent: true, tools: [
    { id: "fib", icon: GitCompareArrows, title: "Fibonacci retracement" },
    { id: "fibext", icon: Spline, title: "Fibonacci extension" },
  ] },
  { label: "SHAPES", tools: [
    { id: "rect", icon: SquareDashed, title: "Rectangle" },
    { id: "brush", icon: Pencil, title: "Brush" },
    { id: "arrow", icon: ArrowRight, title: "Arrow" },
  ] },
  { label: "TEXT", tools: [{ id: "text", icon: Type, title: "Text" }] },
  { label: "TRADE", tools: [
    { id: "long", icon: TrendingUp, title: "Long position" },
    { id: "short", icon: TrendingDown, title: "Short position" },
    { id: "measure", icon: Ruler, title: "Measure" },
  ] },
];

type SideTab = "trade" | "challenge" | "calendar" | "alerts" | "risk" | "replay";

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
  replayStats: { title: "Replay Performance", subtitle: "Statistics of the simulated session — CSV export" },
  replayChallenge: { title: "Replay Challenge", subtitle: "Training mode — separate from real Prop Firm" },
  replayMissions: { title: "Replay Missions", subtitle: "Practice goals & achievements" },
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

/** Downscale any picked photo to a ≤1600px JPEG data URL for the chart bg. */
async function fileToChartBg(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode-failed"));
    image.src = dataUrl;
  });
  const scale = Math.min(1, 1600 / img.width, 1600 / img.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

export default function TerminalPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const { settings, update } = useTerminalWorkspace();
  const { alerts, patchAlert } = useTerminalAlerts();
  const { account, positions } = useTerminalTrading();

  const [activeTool, setActiveTool] = useState<DrawingTool>("cursor");
  // open tool-group flyout: viewport coords of the anchor button (fixed
  // positioning — MUST be outside the overflow-clipped toolbar container so
  // the menu always appears to the RIGHT of the group, never clipped)
  const [flyout, setFlyout] = useState<{ label: string; top: number; left: number } | null>(null);
  // last-picked tool PER GROUP — becomes that group button's icon, exactly
  // like TradingView: pick "Horizontal line" once and the LINES button keeps
  // showing the horizontal-line icon
  const [lastTool, setLastTool] = useState<Partial<Record<string, DrawingTool>>>({});
  const [indDialog, setIndDialog] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>("trade");
  const [mobilePanel, setMobilePanel] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // advanced tools
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  const [overlay, setOverlay] = useState<OverlayConfig>(() => {
    try { return { ...DEFAULT_OVERLAY, ...(JSON.parse(localStorage.getItem("terminalOverlay") ?? "null") ?? {}) }; } catch { return DEFAULT_OVERLAY; }
  });
  const [anchor, setAnchor] = useState<number | null>(() => {
    const v = localStorage.getItem("terminalAvwap"); return v ? Number(v) : null;
  });
  const [compare, setCompare] = useState<string | null>(() => localStorage.getItem("terminalCompare") || null);

  // ===== Replay 2.0 =====
  const rs = useReplaySession(settings.symbol, settings.timeframe);
  const [replayOpen, setReplayOpen] = useState(false);
  const [journalDraft, setJournalDraft] = useState<JournalDraft | null>(null);
  const [screenshotSignal, setScreenshotSignal] = useState(0);
  const replaySymbolRef = useRef(settings.symbol);
  useEffect(() => {
    if (replaySymbolRef.current !== settings.symbol) {
      replaySymbolRef.current = settings.symbol;
      if (rs.active) { rs.stop(); toast({ title: "Replay stopped — instrument changed" }); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.symbol]);
  // auto-evaluate the training challenge after every trade / equity move
  useEffect(() => { rs.evaluateChallenge(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rs.engine.closed.length, Math.round(rs.equity)]);
  // open the replay side tab automatically when a session starts
  useEffect(() => { if (rs.active) setSideTab((cur) => (cur === "replay" ? cur : "replay")); }, [rs.active]);

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
    if (!document.fullscreenElement) {
      // browser fullscreen (whole screen, site chrome hidden)
      el?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  // immersive = browser fullscreen OR in-page focus/maximize mode
  const immersive = fullscreen;
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [themesOpen, setThemesOpen] = useState(false);
  // chart background photo — rendered BEHIND the candles (chart only, never
  // site-wide); dim veil adjustable, persisted per device
  const [bgImage, setBgImage] = useState<string | null>(() => {
    try { return localStorage.getItem("terminalBg"); } catch { return null; }
  });
  const [bgDim, setBgDim] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("terminalBgDim");
      return raw == null ? 0.3 : Math.min(0.9, Math.max(0, Number(raw) || 0));
    } catch { return 0.3; }
  });
  const [bgOpen, setBgOpen] = useState(false);
  const bgFileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try { bgImage == null ? localStorage.removeItem("terminalBg") : localStorage.setItem("terminalBg", bgImage); } catch { /* quota */ }
  }, [bgImage]);
  useEffect(() => {
    try { localStorage.setItem("terminalBgDim", String(bgDim)); } catch { /* ignore */ }
  }, [bgDim]);
  // one-time migration: the OLD site-wide background (removed) moves behind the chart
  useEffect(() => {
    if (bgImage) return;
    try {
      const old = JSON.parse(localStorage.getItem("inspire_terminal_bg") || "null");
      if (old?.img) {
        setBgImage(old.img);
        if (typeof old.dim === "number") setBgDim(Math.min(0.9, Math.max(0, old.dim)));
      }
    } catch { /* no old background */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // instrument search combo (toolbar, top-left)
  const [symQuery, setSymQuery] = useState("");
  const [symOpen, setSymOpen] = useState(false);
  // side panel visibility — collapse to give the chart the full width
  const [panelOpen, setPanelOpen] = useState(true);

  const symMatches = useMemo(() => {
    const q = symQuery.trim().toLowerCase();
    if (!q) return INSTRUMENTS;
    return INSTRUMENTS.filter((i) => i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  }, [symQuery]);

  // "F" hotkey toggles focus/maximize mode (TradingView-style), ignored while typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      // "/" opens the searchable tools palette (replay, backtest, sessions…)
      if (e.key === "/") {
        e.preventDefault();
        setToolsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // keep the fullscreen button in sync (F11-style exit, ESC)
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const launchTool = (id: ToolId) => {
    if (id === "replay") { setReplayOpen(true); return; }
    setTool(id);
  };

  // keyboard shortcuts (§2) — only while replay is active and no field focused
  useEffect(() => {
    if (!rs.active) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case " ": e.preventDefault(); rs.setPlaying(!rs.playing); break;
        case "ArrowRight": e.preventDefault(); rs.stepForward(1); break;
        case "ArrowLeft": e.preventDefault(); rs.stepBack(1); break;
        case "ArrowUp": e.preventDefault(); rs.setSpeedIdx(Math.min(7, rs.speedIdx + 1)); break;
        case "ArrowDown": e.preventDefault(); rs.setSpeedIdx(Math.max(0, rs.speedIdx - 1)); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rs]);

  // chart screenshot for the journal (downscaled JPEG of the first chart canvas)
  const captureChart = useCallback((): string | null => {
    try {
      const canvas = gridRef.current?.querySelector("canvas");
      if (!canvas) return null;
      const scale = Math.min(1, 900 / canvas.width);
      const out = document.createElement("canvas");
      out.width = Math.round(canvas.width * scale);
      out.height = Math.round(canvas.height * scale);
      out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL("image/jpeg", 0.7);
    } catch { return null; }
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
      drawings={drawingsHidden ? [] : drawings}
      onDrawingsChange={save}
      activeTool={activeTool}
      onToolDone={() => setActiveTool("cursor")}
      onLastBar={i === 0 ? onLastBar : undefined}
      onToggleVolume={() => update({ showVolume: !settings.showVolume })}
      onRequestFullscreen={toggleFullscreen}
      priceScaleMode={settings.priceScale}
      magnet={settings.magnet}
      screenshotSignal={i === 0 ? screenshotSignal : 0}
      bgImage={bgImage}
      bgDim={bgDim}
      overlayCfg={overlay}
      anchoredVwapTime={anchor}
      compareSymbol={compare}
      onAnchorVwap={setAnchor}
      {...(rs.active ? rs.replayChartProps : {})}
      onReplayMenu={i === 0 && rs.active ? (price) => {
        const pos = rs.engine.positions.find((p) => p.symbol === settings.symbol);
        const items: { label: string; onClick: () => void }[] = [
          { label: "Buy limit here (0.10)", onClick: () => rs.pending({ symbol: settings.symbol, side: "buy", lots: 0.1, type: "limit", price, sl: null, tp: null }) },
          { label: "Sell limit here (0.10)", onClick: () => rs.pending({ symbol: settings.symbol, side: "sell", lots: 0.1, type: "limit", price, sl: null, tp: null }) },
          { label: "Buy stop here (0.10)", onClick: () => rs.pending({ symbol: settings.symbol, side: "buy", lots: 0.1, type: "stop", price, sl: null, tp: null }) },
          { label: "Sell stop here (0.10)", onClick: () => rs.pending({ symbol: settings.symbol, side: "sell", lots: 0.1, type: "stop", price, sl: null, tp: null }) },
        ];
        if (pos) {
          items.push(
            { label: `Set SL of #${pos.id} here`, onClick: () => rs.modify(pos.id, { sl: price }) },
            { label: `Set TP of #${pos.id} here`, onClick: () => rs.modify(pos.id, { tp: price }) },
            { label: `Close #${pos.id} at this price`, onClick: () => rs.close(pos.id) },
          );
        }
        return items;
      } : undefined}
      height={420}
    />
  );

  const sidePanel = (cls?: string) =>
    sideTab === "trade" ? <TradingPanel symbol={settings.symbol} price={price} className={cls} /> :
    sideTab === "challenge" ? <ChallengeDashboard prices={prices} className={cls} /> :
    sideTab === "calendar" ? <CalendarPanel symbol={settings.symbol} className={cls} /> :
    sideTab === "alerts" ? <AlertsPanel prices={prices} drawings={drawings} className={cls} /> :
    sideTab === "replay" ? <ReplayTradingPanel rs={rs} onJournal={(t) => setJournalDraft({ trade: t, sessionId: `${settings.symbol}-${settings.timeframe}`, symbol: settings.symbol, timeframe: settings.timeframe, captureChart })} /> :
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
    <div className="relative flex h-[calc(100dvh-7.5rem)] min-h-[520px] flex-col gap-1.5">
      {/* ===== toolbar (hidden in focus/maximize mode) ===== */}
      {!immersive && (
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/50 bg-card/60 p-1.5">
        {/* instrument — compact symbol box with built-in search (merged) */}
        <div className="relative">
          <button
            onClick={() => { setSymQuery(""); setSymOpen((v) => !v); }}
            className={cn("num-input flex h-8 w-24 items-center justify-between gap-1 px-2.5 font-bold", symOpen && "border-emerald-500/50")}
            aria-label="Instrument"
            title="Instrument — click to search"
          >
            <span className="truncate">{settings.symbol}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
          {symOpen && (
            <div className="absolute left-0 top-9 z-50 w-60 rounded-xl border border-border/60 bg-[#0d1117] p-1.5 shadow-2xl">
              <input
                autoFocus
                value={symQuery}
                onChange={(e) => setSymQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && symMatches.length > 0) { update({ symbol: symMatches[0].symbol }); setSymOpen(false); }
                  if (e.key === "Escape") setSymOpen(false);
                }}
                placeholder="Search instrument…"
                className="num-input h-7 w-full text-[11px]"
              />
              <div className="mt-1 max-h-56 overflow-y-auto">
                {(["index", "metal", "forex", "crypto"] as const).map((cls) => {
                  const rows = symMatches.filter((i) => i.assetClass === cls);
                  if (!rows.length) return null;
                  return (
                    <div key={cls}>
                      <div className="mt-1 select-none px-2 py-0.5 text-[8px] font-bold uppercase tracking-widest text-muted-foreground/70">
                        {cls === "index" ? "Indices" : cls === "metal" ? "Metals" : cls === "forex" ? "Forex" : "Crypto"}
                      </div>
                      {rows.map((i) => (
                        <button
                          key={i.symbol}
                          onClick={() => { update({ symbol: i.symbol }); setSymOpen(false); }}
                          className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-card/60", settings.symbol === i.symbol ? "text-emerald-400" : "text-muted-foreground")}
                        >
                          <span className="w-16 font-bold">{i.symbol}</span>
                          <span className="truncate">{i.name}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {symMatches.length === 0 && <div className="px-2 py-2 text-center text-[10px] text-muted-foreground">No instrument matches</div>}
              </div>
            </div>
          )}
        </div>

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
          className="num-input h-8 w-28 sm:w-32"
          aria-label="Chart type"
        >
          {CHART_TYPES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>

        <button onClick={() => setIndDialog(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground">
          <Layers className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t("indicators")}</span>
          {settings.indicators.length > 0 && <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-400">{settings.indicators.length}</span>}
        </button>

        <button
          onClick={() => update({ showVolume: !settings.showVolume })}
          className={cn("flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold", settings.showVolume ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground")}
          title="Volume"
        >
          <BarChart2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">Vol</span>
        </button>

        <button
          onClick={() => setToolsOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 text-[11px] font-bold text-sky-400 hover:bg-sky-500/20"
          title="Search tools (replay, backtest, sessions, heatmap…)"
        >
          <Wrench className="h-3.5 w-3.5" /><span className="hidden sm:inline">Tools</span>
        </button>
        <button
          onClick={() => setCalcOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground"
          title="Trading calculators"
        >
          <Calculator className="h-3.5 w-3.5" />
        </button>

        {/* TradingView-style view controls — scale, magnet, screenshot, objects */}
        <button
          onClick={() => update({ priceScale: settings.priceScale === "log" ? "normal" : "log" })}
          className={cn("h-8 rounded-lg border px-2 text-[11px] font-bold", settings.priceScale === "log" ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground")}
          title="Logarithmic price scale"
        >LOG</button>
        <button
          onClick={() => update({ priceScale: settings.priceScale === "percent" ? "normal" : "percent" })}
          className={cn("h-8 rounded-lg border px-2 text-[11px] font-bold", settings.priceScale === "percent" ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground")}
          title="Percent price scale"
        >%</button>
        <button
          onClick={() => update({ magnet: !settings.magnet })}
          className={cn("flex h-8 w-8 items-center justify-center rounded-lg border", settings.magnet ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground")}
          title="Magnet crosshair — snap to OHLC"
        ><Magnet className="h-3.5 w-3.5" /></button>
        <button onClick={() => setScreenshotSignal((n) => n + 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground" title="Export chart image (PNG)">
          <Camera className="h-3.5 w-3.5" />
        </button>
        <div className="relative">
          <button
            onClick={() => setObjectsOpen((v) => !v)}
            className={cn("flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold", objectsOpen ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}
            title="Objects — drawings on this chart"
          >
            <Shapes className="h-3.5 w-3.5" />{drawings.length > 0 ? drawings.length : ""}
          </button>
          {objectsOpen && (
            <div className="absolute right-0 top-9 z-50 w-60 rounded-xl border border-border/60 bg-[#0d1117] p-2 shadow-2xl">
              <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase text-muted-foreground">
                <span>Objects ({drawings.length})</span>
                <button onClick={() => setDrawingsHidden((v) => !v)} className={cn("flex items-center gap-1 rounded px-1.5 py-0.5", drawingsHidden ? "text-amber-400" : "text-muted-foreground hover:text-foreground")} title="Show/hide all drawings">
                  {drawingsHidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{drawingsHidden ? "Hidden" : "Visible"}
                </button>
              </div>
              <div className="max-h-44 space-y-0.5 overflow-y-auto">
                {!drawings.length && <div className="py-2 text-center text-[10px] text-muted-foreground">No drawings on {settings.symbol}</div>}
                {drawings.map((d) => (
                  <div key={d.id} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] hover:bg-card/60">
                    <span className="uppercase text-muted-foreground">{d.tool}</span>
                    <span className="ml-auto text-muted-foreground">{d.points?.[0] ? new Date(d.points[0].time * 1000).toLocaleDateString() : ""}</span>
                  </div>
                ))}
              </div>
              {drawings.length > 0 && (
                <button
                  onClick={() => { if (confirm("Remove all drawings on this symbol?")) { save([]); setObjectsOpen(false); } }}
                  className="mt-1.5 w-full rounded-lg border border-red-500/40 py-1 text-[10px] font-bold text-red-400 hover:bg-red-500/10"
                >
                  Remove all
                </button>
              )}
            </div>
          )}
        </div>

        {/* chart background photo — behind the CANDLES (chart only, never the site) */}
        <div className="relative">
          <button
            onClick={() => setBgOpen((v) => !v)}
            className={cn("relative flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold", bgOpen || bgImage ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}
            title="Chart background photo"
          >
            <ImagePlus className="h-3.5 w-3.5" /><span className="hidden sm:inline">BG</span>
            {bgImage && <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-emerald-400" />}
          </button>
          {bgOpen && (
            <div className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-border/60 bg-[#0d1117] p-2 shadow-2xl">
              <div className="mb-1 text-[10px] font-bold uppercase text-muted-foreground">Chart background</div>
              <button
                onClick={() => bgFileRef.current?.click()}
                className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 py-1.5 text-[11px] font-bold text-emerald-400 hover:bg-emerald-500/20"
              >
                Upload photo…
              </button>
              <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">Shown behind the candles inside the chart only.</p>
              {bgImage && <div className="mt-1.5 overflow-hidden rounded-lg border border-border/60"><img src={bgImage} alt="" className="h-14 w-full object-cover" /></div>}
              {bgImage && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Dim</span>
                  <input
                    type="range" min={0} max={90} value={Math.round(bgDim * 100)}
                    onChange={(e) => setBgDim(Number(e.target.value) / 100)}
                    className="h-1 flex-1 accent-emerald-400"
                    title="Darken the photo so candles stay readable"
                  />
                  <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{Math.round(bgDim * 100)}%</span>
                </div>
              )}
              {bgImage && (
                <button
                  onClick={() => { setBgImage(null); setBgOpen(false); }}
                  className="mt-1.5 w-full rounded-lg border border-red-500/40 py-1 text-[10px] font-bold text-red-400 hover:bg-red-500/10"
                >
                  Remove background
                </button>
              )}
            </div>
          )}
          <input
            ref={bgFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try { setBgImage(await fileToChartBg(file)); } catch { toast({ title: "Could not load that image" }); }
              setBgOpen(false);
            }}
          />
        </div>

        {/* chart theme picker — one-click presets, persisted per user */}
        <div className="relative">
          <button
            onClick={() => setThemesOpen((v) => !v)}
            className={cn("flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold", themesOpen ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}
            title="Chart theme"
          >
            <Palette className="h-3.5 w-3.5" /><span className="hidden sm:inline">{CHART_THEMES.find((th) => JSON.stringify(th.colors) === JSON.stringify(settings.colors))?.label ?? "Custom"}</span>
          </button>
          {themesOpen && (
            <div className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-border/60 bg-[#0d1117] p-2 shadow-2xl">
              <div className="mb-1 text-[10px] font-bold uppercase text-muted-foreground">Chart themes</div>
              <div className="space-y-0.5">
                {CHART_THEMES.map((th) => (
                  <button
                    key={th.id}
                    onClick={() => { update({ colors: th.colors }); setThemesOpen(false); }}
                    className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-semibold hover:bg-card/60", JSON.stringify(settings.colors) === JSON.stringify(th.colors) ? "text-emerald-400" : "text-muted-foreground")}
                  >
                    <span className="flex h-5 w-9 items-center justify-center gap-1 rounded border border-border/60" style={{ background: th.colors.bg }}>
                      <span className="h-2.5 w-1 rounded-sm" style={{ background: th.colors.up }} />
                      <span className="h-2.5 w-1 rounded-sm" style={{ background: th.colors.down }} />
                      <span className="h-2.5 w-1 rounded-sm" style={{ background: th.colors.accent }} />
                    </span>
                    {th.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">
                Theme colors candles, grid and text. Photo backgrounds live in the BG button.
              </p>
            </div>
          )}
        </div>

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
          <button onClick={toggleFullscreen} className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground" title="Fullscreen (whole screen)">
            {fullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>)}

      {/* ===== replay toolbar ===== */}
      {replayOpen && (
        <ReplayToolbar rs={rs} onOpenStats={() => setTool("replayStats")} />
      )}

      {/* ===== workspace ===== */}
      <div className="relative flex min-h-0 flex-1 gap-1.5" ref={gridRef}>
        {/* exit chip in focus / fullscreen mode */}
        {immersive && (
          <button
            onClick={() => document.exitFullscreen?.().catch(() => {})}
            className="absolute right-2 top-2 z-[70] flex items-center gap-1 rounded-lg border border-border/60 bg-[#0d1117]/90 px-2 py-1 text-[10px] font-bold text-muted-foreground hover:text-foreground"
            title="Exit full view"
          >
            <Minimize className="h-3 w-3" />Exit full view (Esc)
          </button>
        )}
        {/* click-away layer for the open tool-group flyout */}
        {flyout && <div className="fixed inset-0 z-40" onMouseDown={() => setFlyout(null)} />}
        {/* drawing toolbar — compact GROUP buttons, floats INSIDE the chart
            area (TradingView-style); the corner arrow opens that group's
            tool list to the RIGHT of the button */}
        <div className="absolute left-1.5 top-9 z-50 flex max-h-[calc(100%-2.75rem)] w-10 flex-col items-center gap-0.5 overflow-y-auto rounded-xl border border-white/10 bg-[#0d1117]/85 py-1.5 backdrop-blur">
          {TOOL_GROUPS.map((g) => {
            const active = g.tools.some((t) => t.id === activeTool);
            // the group's FACE is whatever the user last picked in this group
            const current = g.tools.find((t) => t.id === lastTool[g.label]) ?? g.tools[0];
            const GIcon = current.icon;
            const open = flyout?.label === g.label;
            return (
              <div key={g.label} className="relative w-full">
                {/* main part of the button — selects the group's current tool */}
                <button
                  onClick={() => { setActiveTool(current.id); setFlyout(null); }}
                  className={cn("mx-auto flex h-7 w-8 shrink-0 items-center justify-center rounded-md transition-colors", active || open ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40" : "text-muted-foreground hover:bg-white/5 hover:text-foreground")}
                  title={`${current.title} — click to select`}
                >
                  <GIcon className="h-3.5 w-3.5" />
                </button>
                {/* corner arrow — opens THIS group's tool list to the right */}
                <button
                  onClick={(e) => {
                    if (open) { setFlyout(null); return; }
                    const r = e.currentTarget.getBoundingClientRect();
                    setFlyout({
                      label: g.label,
                      top: Math.max(8, Math.min(r.top, window.innerHeight - 320)),
                      left: r.right + 6,
                    });
                  }}
                  className={cn("absolute bottom-0 right-0 flex h-3.5 w-3.5 items-center justify-center rounded transition-colors", open ? "bg-emerald-500/40 text-emerald-300" : "bg-white/10 text-muted-foreground hover:bg-white/25 hover:text-foreground")}
                  title={`${g.label} tools — open the list`}
                >
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
          <div className="my-1 h-px w-6 shrink-0 bg-white/10" />
          <button onClick={() => drawingsBus.emit({ cmd: "undo" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground" title="Undo"><Undo2 className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "redo" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground" title="Redo"><Redo2 className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "lock" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground" title="Lock selected"><Lock className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "hide" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground" title="Hide selected"><Eye className="h-3.5 w-3.5" /></button>
          <button onClick={() => drawingsBus.emit({ cmd: "delete" })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-red-400" title="Delete selected"><Trash2 className="h-3.5 w-3.5" /></button>
          <div className="my-1 h-px w-6 shrink-0 bg-white/10" />
          <input type="color" defaultValue={settings.colors.accent} onChange={(e) => drawingsBus.emit({ cmd: "style", arg: { color: e.target.value } })} className="h-6 w-7 shrink-0 cursor-pointer rounded" title="Color" />
          <select defaultValue="2" onChange={(e) => drawingsBus.emit({ cmd: "style", arg: { width: Number(e.target.value) } })} className="h-6 w-9 shrink-0 rounded border border-white/10 bg-transparent text-[10px] text-muted-foreground" title="Width">
            {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>

        {/* the flyout itself — FIXED to the viewport at the anchor button's
            right side, OUTSIDE the clipped toolbar container */}
        {flyout && (() => {
          const g = TOOL_GROUPS.find((x) => x.label === flyout.label);
          if (!g) return null;
          return (
            <div
              className="fixed z-50 max-h-[70vh] w-44 overflow-y-auto rounded-xl border border-white/10 bg-[#0d1117]/95 p-1 shadow-2xl backdrop-blur"
              style={{ left: flyout.left, top: flyout.top }}
            >
              <div className={cn("select-none px-2 py-1 text-[8px] font-bold uppercase tracking-widest", g.accent ? "text-amber-400/80" : "text-muted-foreground/70")}>{g.label}</div>
              {g.tools.map(({ id, icon: Icon, title }) => (
                <button
                  key={id}
                  onClick={() => { setActiveTool(id); setLastTool((p) => ({ ...p, [g.label]: id })); setFlyout(null); }}
                  className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-white/5", activeTool === id ? "text-emerald-400" : "text-muted-foreground")}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{title}</span>
                  {activeTool === id && <Check className="ml-auto h-3 w-3 shrink-0" />}
                </button>
              ))}
            </div>
          );
        })()}

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
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => setMobilePanel((v) => !v)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 py-2 text-xs font-bold text-emerald-400"
            >
              <Activity className="h-4 w-4" />
              {mobilePanel ? t("hidePanel") : t("showPanel")} ({openCount})
            </button>
          </div>
        </div>

        {/* side panel (desktop) — hidden in focus mode; collapsible to widen the chart */}
        {!immersive && !panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            className="hidden w-6 shrink-0 flex-col items-center rounded-xl border border-border/50 bg-card/60 py-2 text-muted-foreground hover:text-foreground md:flex"
            title="Show panel"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}
        {!immersive && panelOpen && (
        <div className="hidden w-80 shrink-0 md:block">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/50 bg-card/60">
            <div className="flex shrink-0 items-center gap-0.5 border-b border-border/40 p-1">
              <button
                onClick={() => setPanelOpen(false)}
                className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                title="Hide panel (more chart)"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
              {(["trade", "challenge", "calendar", "alerts", "risk", "replay"] as SideTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSideTab(tab)}
                  className={cn("flex-1 rounded-lg px-1 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors", sideTab === tab ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground hover:text-foreground", tab === "replay" && rs.active && "text-sky-400")}
                >
                  {tab === "replay" ? "REPLAY" : tab === "trade" ? t("tabTrade") : tab === "challenge" ? t("tabChallenge") : tab === "calendar" ? t("tabCalendar") : tab === "alerts" ? t("tabAlerts") : t("tabRisk")}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{sidePanel()}</div>
          </div>
        </div>)}

        {/* floating replay bar — replaced by the dedicated toolbar above the workspace */}

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
          {tool === "replayStats" && <ReplayStatsPanel rs={rs} />}
          {tool === "replayChallenge" && <ReplayChallengePanel rs={rs} />}
          {tool === "replayMissions" && <ReplayMissionsPanel rs={rs} />}
        </ToolDrawer>
      </div>

      <IndicatorDialog open={indDialog} onOpenChange={setIndDialog} active={settings.indicators} onChange={(list: ActiveIndicator[]) => update({ indicators: list })} />
      <ToolsDialog open={toolsOpen} onOpenChange={setToolsOpen} onLaunch={launchTool} />
      <CalculatorsDialog open={calcOpen} onOpenChange={setCalcOpen} symbol={settings.symbol} prices={prices} />
      <ReplayJournalDialog draft={journalDraft} onClose={() => setJournalDraft(null)} />
    </div>
  );
}
