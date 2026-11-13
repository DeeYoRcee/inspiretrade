/**
 * TerminalChart — one chart slot of the InspireTrade Terminal.
 *
 * Wraps TradingView Lightweight Charts (Apache-2.0, npm `lightweight-charts`)
 * — the open-source library, NOT TradingView's proprietary Advanced Charts —
 * with: 8 chart types (candles/hollow/bars/line/area/baseline/Heikin-Ashi/
 * Renko), overlay + pane indicators with user colors, a drawing-tools canvas
 * overlay, volume histogram, crosshair OHLC legend, cross-chart crosshair
 * sync, right-click context menu, double-click reset and REAL data feeds
 * only (live Binance WS for crypto, delayed Yahoo proxy for the rest).
 * Feed failures render a clear error state with a retry — never fake candles.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode, LineStyle, PriceScaleMode,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type MouseEventParams,
} from "lightweight-charts";
import { getInstrument, toHeikinAshi, toRenko, TF_SECONDS, type Bar, type ChartType, type Timeframe } from "@shared/terminal";
import { loadFeed, subscribeFeed, loadBarsCached, type FeedStatus } from "@/lib/terminal/data-feeds";
import { getIndicator, INDICATORS, type Line, type NamedLine } from "@/lib/terminal/indicators";
import { DrawingEngine, type Drawing, type DrawingTool, type DrawingPoint } from "@/lib/terminal/drawings";
import { drawingsBus } from "@/lib/terminal/drawings-bus";
import { crosshairBus } from "@/lib/terminal/crosshair-bus";
import { ChartOverlay, DEFAULT_OVERLAY, type OverlayConfig } from "@/lib/terminal/chart-overlay";
import { anchoredVwap } from "@/lib/terminal/volume-analysis";
import { Loader2, RefreshCw, WifiOff } from "lucide-react";

export interface ActiveIndicator { id: string; params: Record<string, number>; color?: string; }

export interface ChartColors {
  up: string; down: string; accent: string; grid: string; bg: string; text: string;
}

export const DEFAULT_COLORS: ChartColors = {
  up: "#22c55e", down: "#ef4444", accent: "#22c55e",
  grid: "rgba(42, 46, 54, 0.5)", bg: "#0b0e13", text: "#9aa4b2",
};

/** One-click chart themes (TradingView-style) — applies to candles, lines,
 *  grid, background and text of every chart in the workspace. */
export const CHART_THEMES: { id: string; label: string; colors: ChartColors }[] = [
  { id: "midnight", label: "Midnight", colors: DEFAULT_COLORS },
  { id: "tvdark", label: "TradingView Dark", colors: { up: "#26a69a", down: "#ef5350", accent: "#2962ff", grid: "rgba(42, 46, 54, 0.5)", bg: "#131722", text: "#b2b5be" } },
  { id: "paper", label: "Paper (light)", colors: { up: "#089981", down: "#f23645", accent: "#2962ff", grid: "rgba(150, 160, 175, 0.35)", bg: "#ffffff", text: "#131722" } },
  { id: "nord", label: "Nord", colors: { up: "#a3be8c", down: "#bf616a", accent: "#88c0d0", grid: "rgba(216, 222, 233, 0.08)", bg: "#2e3440", text: "#d8dee9" } },
  { id: "carbon", label: "Carbon", colors: { up: "#4ade80", down: "#f87171", accent: "#fbbf24", grid: "rgba(255, 255, 255, 0.06)", bg: "#16181d", text: "#9ca3af" } },
  { id: "ocean", label: "Ocean", colors: { up: "#22d3ee", down: "#fb7185", accent: "#818cf8", grid: "rgba(148, 163, 184, 0.10)", bg: "#0c1a2b", text: "#94a3b8" } },
  { id: "aurora", label: "Aurora", colors: { up: "#34d399", down: "#f472b6", accent: "#a78bfa", grid: "rgba(167, 139, 250, 0.10)", bg: "#0b1020", text: "#a5b4fc" } },
  { id: "cyber", label: "Cyber", colors: { up: "#00e5ff", down: "#ff2d78", accent: "#a855f7", grid: "rgba(0, 229, 255, 0.09)", bg: "#070b16", text: "#67e8f9" } },
  { id: "sunset", label: "Sunset", colors: { up: "#fbbf24", down: "#fb7185", accent: "#f97316", grid: "rgba(251, 146, 60, 0.10)", bg: "#190d09", text: "#fdba74" } },
  { id: "matrix", label: "Matrix", colors: { up: "#00e676", down: "#ff5252", accent: "#00c853", grid: "rgba(0, 230, 118, 0.10)", bg: "#050a06", text: "#69f0ae" } },
  { id: "gold", label: "Royal Gold", colors: { up: "#eab308", down: "#f87171", accent: "#facc15", grid: "rgba(250, 204, 21, 0.09)", bg: "#0d0b05", text: "#e7c66b" } },
  { id: "arctic", label: "Arctic (light)", colors: { up: "#059669", down: "#e11d48", accent: "#0284c7", grid: "rgba(148, 163, 184, 0.35)", bg: "#f1f5f9", text: "#0f172a" } },
];

const PALETTE = ["#4ade80", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#f87171", "#34d399"];

/** hex/known-color → rgba with alpha (for indicator shade variants). */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4 ? color.split("").map((c) => (c === "#" ? c : c + c)).join("") : color;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

interface Props {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  indicators: ActiveIndicator[];
  showVolume: boolean;
  colors: ChartColors;
  drawings: Drawing[];
  onDrawingsChange: (d: Drawing[]) => void;
  activeTool: DrawingTool;
  onToolDone?: () => void;
  onStatus?: (s: FeedStatus, message?: string) => void;
  onLastBar?: (bar: Bar) => void;
  onToggleVolume?: () => void;
  onRequestFullscreen?: () => void;
  height?: number;
  compact?: boolean;
  /**
   * Bar-replay mode: display only bars with time ≤ `upToTime` (UTC sec).
   * The cursor time is the single source of truth — every chart (any
   * timeframe) stays synchronized to the same historical instant.
   */
  replay?: { active: boolean; upToTime: number } | null;
  /** fired with the current last visible bar during replay */
  onReplayBar?: (bar: Bar) => void;
  /** session boxes + prev day/week levels + volume profile overlay */
  overlayCfg?: OverlayConfig | null;
  /** anchored VWAP drawn from this bar time (null = off) */
  anchoredVwapTime?: number | null;
  /** normalized %-change comparison overlay of another instrument */
  compareSymbol?: string | null;
  /** set/clear the anchored VWAP anchor (right-click menu → Volume panel) */
  onAnchorVwap?: (time: number | null) => void;
  /** simulated-trade markers (entry/exit arrows) on the price series */
  tradeMarkers?: ReplayTradeMarker[];
  /** horizontal level lines for open positions / SL / TP / pending orders */
  priceLines?: ReplayPriceLine[];
  /** extra right-click menu items for replay trading (price/time context) */
  onReplayMenu?: (price: number, time: number) => { label: string; onClick: () => void }[];
  /** right price-scale mode — TradingView-style LOG / % toggles */
  priceScaleMode?: "normal" | "log" | "percent";
  /** magnet crosshair — snaps the crosshair to OHLC values */
  magnet?: boolean;
  /** increment to trigger a PNG download of the chart (screenshot) */
  screenshotSignal?: number;
  /** user photo rendered BEHIND the candles (transparent chart background) */
  bgImage?: string | null;
}

export interface ReplayTradeMarker {
  time: number; side: "buy" | "sell"; kind: "entry" | "exit"; profit?: number; reason?: string;
}

export interface ReplayPriceLine {
  id: string; price: number; color: string; title: string; dashed?: boolean; width?: 1 | 2;
}

interface OverlayGroup { series: ISeriesApi<"Line">[]; named: NamedLine[]; }
interface PaneEntry { chart: IChartApi; defId: string; series: (ISeriesApi<"Line" | "Histogram">)[]; named: NamedLine[]; }

let CHART_SEQ = 0;

export function TerminalChart({
  symbol, timeframe, chartType, indicators, showVolume, colors,
  drawings, onDrawingsChange, activeTool, onToolDone, onStatus, onLastBar,
  onToggleVolume, onRequestFullscreen, height, compact,
  replay, onReplayBar, overlayCfg, anchoredVwapTime, compareSymbol, onAnchorVwap,
  tradeMarkers, priceLines, onReplayMenu, priceScaleMode, magnet, screenshotSignal,
  bgImage,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<HTMLDivElement[]>([]);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayGroupsRef = useRef<OverlayGroup[]>([]);
  const paneChartsRef = useRef<PaneEntry[]>([]);
  const engineRef = useRef<DrawingEngine | null>(null);
  // latest onToolDone without re-creating the engine (mount-only effect)
  const onToolDoneRef = useRef(onToolDone);
  onToolDoneRef.current = onToolDone;
  const barsRef = useRef<Bar[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);
  const syncingRef = useRef(false);
  const lastEmittedRef = useRef<string>("[]");
  const chartIdRef = useRef<string>(`chart-${++CHART_SEQ}`);
  const lastFullRenderRef = useRef(0);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<ChartOverlay | null>(null);
  const avwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const compareRef = useRef<ISeriesApi<"Line"> | null>(null);
  const replayRef = useRef<{ active: boolean; upToTime: number } | null>(null);
  const priceLineRefs = useRef<Map<string, IPriceLine>>(new Map());
  const countdownRef = useRef<HTMLSpanElement>(null);
  const overlayCfgRef = useRef<OverlayConfig | null>(overlayCfg ?? null);
  overlayCfgRef.current = overlayCfg ?? null;
  const onReplayBarRef = useRef(onReplayBar);
  onReplayBarRef.current = onReplayBar;
  const bgImageRef = useRef<string | null>(bgImage ?? null);
  bgImageRef.current = bgImage ?? null;
  const [dataVersion, setDataVersion] = useState(0);

  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const [feedMsg, setFeedMsg] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; price: number; time: number } | null>(null);
  const [gridOn, setGridOn] = useState(true);

  const inst = getInstrument(symbol);

  // indicator pane definitions (order/count changes → rebuild sub-charts)
  const paneDefs = useMemo(
    () => indicators.map((a) => getIndicator(a.id)).filter((d): d is NonNullable<typeof d> => !!d && d.placement === "pane"),
    [indicators],
  );

  // ---- create/destroy chart -------------------------------------------------

  useEffect(() => {
    if (!mainRef.current) return;
    const chart = createChart(mainRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: bgImage ? "transparent" : colors.bg },
        textColor: colors.text,
        fontSize: compact ? 10 : 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid, visible: true, style: LineStyle.Solid },
        horzLines: { color: colors.grid, visible: true, style: LineStyle.Solid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(154,164,178,0.4)", labelBackgroundColor: "#1f2937" },
        horzLine: { color: "rgba(154,164,178,0.4)", labelBackgroundColor: "#1f2937" },
      },
      // wheel zoom, drag scroll, price/time axis zoom + axis double-click reset
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        mouseWheel: true, pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      rightPriceScale: { borderColor: "rgba(42,46,54,0.8)", scaleMargins: { top: 0.08, bottom: 0.12 } },
      timeScale: {
        borderColor: "rgba(42,46,54,0.8)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: compact ? 4 : 8,
      },
    });
    chartRef.current = chart;

    // crosshair: local legend + broadcast to sibling charts
    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (!seriesRef.current) return;
      if (param.time == null || !param.point) {
        engineRef.current!.syncTime = null;
        engineRef.current?.render();
        crosshairBus.emit({ sourceId: chartIdRef.current, time: null });
        return;
      }
      const bar = param.seriesData.get(seriesRef.current) as any;
      const t = Number(param.time);
      if (bar && bar.close != null) {
        setLegend({ o: bar.open, h: bar.high, l: bar.low, c: bar.close });
      } else {
        const b = barsRef.current.find((x) => x.time === t);
        if (b) setLegend({ o: b.open, h: b.high, l: b.low, c: b.close });
      }
      crosshairBus.emit({ sourceId: chartIdRef.current, time: t });
    });

    // sibling charts → sync line + legend
    const unsubCross = crosshairBus.subscribe(({ sourceId, time }) => {
      if (sourceId === chartIdRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;
      engine.syncTime = time;
      engine.render();
      if (time == null) return;
      const b = barsRef.current.find((x) => x.time === time);
      if (b) setLegend({ o: b.open, h: b.high, l: b.low, c: b.close });
    });

    // drawing engine
    if (drawCanvasRef.current) {
      const engine = new DrawingEngine(
        drawCanvasRef.current,
        () => chartRef.current,
        () => seriesRef.current,
        () => {
          const json = JSON.stringify(engineRef.current?.serialize() ?? []);
          lastEmittedRef.current = json;
          onDrawingsChange(JSON.parse(json));
        },
      );
      engineRef.current = engine;
      engine.onToolDone = () => onToolDoneRef.current?.();
      engine.load(drawings);
      lastEmittedRef.current = JSON.stringify(drawings ?? []);
    }

    // toolbar → engine command bus (broadcast to all chart engines)
    const unsubBus = drawingsBus.subscribe(({ cmd, arg }) => {
      const e = engineRef.current;
      if (!e) return;
      if (cmd === "undo") e.undo();
      else if (cmd === "redo") e.redo();
      else if (cmd === "lock") e.toggleLockSelected();
      else if (cmd === "hide") e.toggleHideSelected();
      else if (cmd === "delete") e.deleteSelected();
      else if (cmd === "style") e.setStyle(arg ?? {});
    });

    // analysis overlay renderer (session boxes / prev levels / volume profile)
    if (overlayCanvasRef.current) {
      const ov = new ChartOverlay(overlayCanvasRef.current, () => chartRef.current, () => seriesRef.current, () => barsRef.current, () => displayBars());
      ov.cfg = overlayCfgRef.current ?? DEFAULT_OVERLAY;
      overlayRef.current = ov;
    }

    // keep drawing overlay + analysis overlay in sync with visible range changes
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      engineRef.current?.redraw();
      overlayRef.current?.render();
    });

    return () => {
      unsubCross();
      unsubBus();
      unsubRef.current?.();
      unsubRef.current = null;
      engineRef.current?.destroy();
      engineRef.current = null;
      overlayRef.current?.destroy();
      overlayRef.current = null;
      paneChartsRef.current.forEach((p) => { try { p.chart.remove(); } catch { /* already gone */ } });
      paneChartsRef.current = [];
      overlayGroupsRef.current = [];
      avwapRef.current = null;
      compareRef.current = null;
      volSeriesRef.current = null;
      seriesRef.current = null;
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- theme updates ---------------------------------------------------------
  // Repaints EVERYTHING on theme change: chart bg/grid/text, the price series
  // (candles/bars/line/area/baseline), volume bars, pane charts and overlay
  // indicator lines — no rebuild needed.
  useEffect(() => {
    const bg = bgImageRef.current ? "transparent" : colors.bg;
    const opts = {
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid, visible: gridOn }, horzLines: { color: colors.grid, visible: gridOn } },
    };
    chartRef.current?.applyOptions(opts as any);

    // price series colors (created once in renderData — repaint in place)
    const s = seriesRef.current as any;
    try {
      if (s?.applyOptions) {
        if (chartType === "line") s.applyOptions({ color: colors.accent });
        else if (chartType === "area") s.applyOptions({ lineColor: colors.accent, topColor: withAlpha(colors.accent, 0.28), bottomColor: withAlpha(colors.accent, 0.02) });
        else if (chartType === "baseline") s.applyOptions({
          topLineColor: colors.up, topFillColor1: withAlpha(colors.up, 0.28), topFillColor2: withAlpha(colors.up, 0.05),
          bottomLineColor: colors.down, bottomFillColor1: withAlpha(colors.down, 0.05), bottomFillColor2: withAlpha(colors.down, 0.28),
        });
        else if (chartType === "bars") s.applyOptions({ upColor: colors.up, downColor: colors.down });
        else if (chartType === "hollow") s.applyOptions({
          upColor: "rgba(0,0,0,0)", downColor: colors.down,
          borderUpColor: colors.up, borderDownColor: colors.down,
          wickUpColor: colors.up, wickDownColor: colors.down,
        });
        else s.applyOptions({
          upColor: colors.up, downColor: colors.down,
          borderUpColor: colors.up, borderDownColor: colors.down,
          wickUpColor: colors.up, wickDownColor: colors.down,
        });
      }
    } catch { /* series not created yet */ }

    // volume bars (per-point colors → re-set data with the new palette)
    try {
      volSeriesRef.current?.setData(barsRef.current
        .filter((b) => b.volume != null)
        .map((b) => ({
          time: b.time as UTCTimestamp,
          value: b.volume!,
          color: b.close >= b.open ? withAlpha(colors.up, 0.45) : withAlpha(colors.down, 0.45),
        })));
    } catch { /* series not created yet */ }

    // pane indicator charts — bg/text/grid + line colors
    for (const p of paneChartsRef.current) {
      try { p.chart.applyOptions(opts as any); } catch { /* gone */ }
      p.series.forEach((ps, psi) => {
        try { ps.applyOptions({ color: indicatorColor(indicators.findIndex((a) => a.id === p.defId), psi) }); } catch { /* gone */ }
      });
    }

    // overlay indicator lines
    overlayGroupsRef.current.forEach((g, gi) => g.series.forEach((ls, li) => {
      try { ls.applyOptions({ color: indicatorColor(gi, li) }); } catch { /* gone */ }
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, gridOn, chartType, bgImage]);

  // ---- tool binding -----------------------------------------------------------

  useEffect(() => {
    engineRef.current?.setTool(activeTool);
  }, [activeTool]);

  useEffect(() => {
    engineRef.current?.setStyle({ color: colors.accent });
  }, [colors.accent]);

  // external drawings update (loaded from Firebase after mount)
  useEffect(() => {
    const json = JSON.stringify(drawings ?? []);
    if (json !== lastEmittedRef.current) {
      lastEmittedRef.current = json;
      engineRef.current?.load(drawings);
    }
  }, [drawings]);

  // ---- data loading (REAL data only) --------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    setFeedStatus("connecting");
    setFeedMsg(undefined);
    barsRef.current = [];

    (async () => {
      try {
        const res = await loadFeed(symbol, timeframe);
        if (cancelled) return;
        barsRef.current = res.bars;
        setFeedStatus(res.status);
        setFeedMsg(res.message);
        onStatus?.(res.status, res.message);
        setErrorMsg(null);
        setLoading(false);
        renderData();
        chartRef.current?.timeScale().scrollToRealTime();
        setDataVersion((v) => v + 1);
        if (replayRef.current?.active) {
          const bars = displayBars();
          const lastBar = bars[bars.length - 1];
          if (lastBar) onReplayBarRef.current?.(lastBar);
        } else {
          startLive();
        }
      } catch (e: any) {
        if (cancelled) return;
        barsRef.current = [];
        setLoading(false);
        setFeedStatus("error");
        setErrorMsg(String(e?.message || e));
        onStatus?.("error", String(e?.message || e));
        renderData(); // clears series
      }
    })();

    function startLive() {
      unsubRef.current?.();
      unsubRef.current = subscribeFeed(symbol, timeframe, (u) => {
        barsRef.current = u.bars;
        updateLive(u.lastBar);
        onLastBar?.(u.lastBar);
      });
    }

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, reloadKey]);

  // ---- series build / live update ------------------------------------------------

  function displayBars(): Bar[] {
    const full = barsRef.current;
    // replay mode hides everything after the cursor time (binary scan from end)
    const rp = replayRef.current;
    let bars = full;
    if (rp?.active) {
      let hi = full.length; // first index with time > upToTime
      let lo = 0;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (full[mid].time <= rp.upToTime) lo = mid + 1; else hi = mid; }
      bars = full.slice(0, Math.max(1, lo));
    }
    if (chartType === "heikin") return toHeikinAshi(bars);
    if (chartType === "renko") return toRenko(bars);
    return bars;
  }

  function indicatorColor(i: number, lineIdx: number): string {
    const user = indicators[i]?.color;
    if (user) return lineIdx === 0 ? user : withAlpha(user, 0.55);
    return PALETTE[(i + lineIdx) % PALETTE.length];
  }

  function renderData() {
    const chart = chartRef.current;
    if (!chart) return;
    lastFullRenderRef.current = Date.now();

    // remove old series
    try { if (seriesRef.current) chart.removeSeries(seriesRef.current); } catch { /* not yet created */ }
    seriesRef.current = null;
    // price lines died with the old series — drop the stale references so the
    // priceLines effect re-creates them on the fresh series
    priceLineRefs.current = new Map();
    if (volSeriesRef.current) { try { chart.removeSeries(volSeriesRef.current); } catch { /* gone */ } volSeriesRef.current = null; }
    for (const g of overlayGroupsRef.current) for (const s of g.series) { try { chart.removeSeries(s); } catch { /* gone */ } }
    overlayGroupsRef.current = [];

    const bars = displayBars();
    const t = (b: Bar) => b.time as UTCTimestamp;
    const precision = inst?.digits ?? 2;
    const minMove = Number((1 / Math.pow(10, precision)).toFixed(precision));
    const priceFormat = { type: "price" as const, precision, minMove };
    let s: ISeriesApi<"Candlestick">;

    switch (chartType) {
      case "line":
        s = chart.addLineSeries({ color: colors.accent, lineWidth: 2, priceFormat }) as unknown as ISeriesApi<"Candlestick">;
        (s as unknown as ISeriesApi<"Line">).setData(bars.map((b) => ({ time: t(b), value: b.close })));
        break;
      case "area":
        s = chart.addAreaSeries({
          lineColor: colors.accent, topColor: withAlpha(colors.accent, 0.28), bottomColor: withAlpha(colors.accent, 0.02),
          lineWidth: 2, priceFormat,
        }) as unknown as ISeriesApi<"Candlestick">;
        (s as unknown as ISeriesApi<"Area">).setData(bars.map((b) => ({ time: t(b), value: b.close })));
        break;
      case "baseline":
        s = chart.addBaselineSeries({
          baseValue: { type: "price", price: bars.length ? bars[Math.floor(bars.length / 2)].close : 0 },
          topLineColor: colors.up, topFillColor1: withAlpha(colors.up, 0.28), topFillColor2: withAlpha(colors.up, 0.05),
          bottomLineColor: colors.down, bottomFillColor1: withAlpha(colors.down, 0.05), bottomFillColor2: withAlpha(colors.down, 0.28),
          lineWidth: 2, priceFormat,
        }) as unknown as ISeriesApi<"Candlestick">;
        (s as unknown as ISeriesApi<"Baseline">).setData(bars.map((b) => ({ time: t(b), value: b.close })));
        break;
      case "bars":
        s = chart.addBarSeries({ upColor: colors.up, downColor: colors.down, thinBars: false, priceFormat }) as unknown as ISeriesApi<"Candlestick">;
        (s as unknown as ISeriesApi<"Bar">).setData(bars.map((b) => ({ time: t(b), open: b.open, high: b.high, low: b.low, close: b.close })));
        break;
      case "hollow":
        s = chart.addCandlestickSeries({
          upColor: "rgba(0,0,0,0)", downColor: colors.down,
          borderUpColor: colors.up, borderDownColor: colors.down,
          wickUpColor: colors.up, wickDownColor: colors.down, priceFormat,
        });
        s.setData(bars.map((b) => ({ time: t(b), open: b.open, high: b.high, low: b.low, close: b.close })));
        break;
      default: // candles / heikin / renko
        s = chart.addCandlestickSeries({
          upColor: colors.up, downColor: colors.down,
          borderUpColor: colors.up, borderDownColor: colors.down,
          wickUpColor: colors.up, wickDownColor: colors.down, priceFormat,
        });
        s.setData(bars.map((b) => ({ time: t(b), open: b.open, high: b.high, low: b.low, close: b.close })));
    }
    seriesRef.current = s;

    // volume overlay (bottom band)
    if (showVolume) {
      const v = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      v.setData(bars.filter((b) => b.volume != null).map((b) => ({
        time: t(b), value: b.volume!,
        color: b.close >= b.open ? withAlpha(colors.up, 0.45) : withAlpha(colors.down, 0.45),
      })));
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeriesRef.current = v;
    }

    // overlay indicators (drawn on the price series)
    for (let i = 0; i < indicators.length; i++) {
      const def = getIndicator(indicators[i].id);
      if (!def || def.placement !== "overlay") continue;
      const named = def.compute(bars, { ...def.defaults, ...indicators[i].params });
      const group: OverlayGroup = { series: [], named };
      for (let li = 0; li < named.length; li++) {
        const ls = chart.addLineSeries({
          color: indicatorColor(i, li), lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        ls.setData(named[li].data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
        group.series.push(ls);
      }
      overlayGroupsRef.current.push(group);
    }

    recomputePaneIndicators();
    engineRef.current?.redraw();
  }

  /**
   * Cheap live-tick path: updates the last candle / indicator point in place.
   * Heikin-Ashi and Renko re-shape history on every tick, so they get a
   * throttled full rebuild instead (max once per 2s).
   */
  function updateLive(bar: Bar) {
    const chart = chartRef.current;
    const s = seriesRef.current;
    if (!chart || !s) return;
    const t = bar.time as UTCTimestamp;

    if (chartType === "heikin" || chartType === "renko") {
      if (Date.now() - lastFullRenderRef.current > 2000) renderData();
      engineRef.current?.redraw();
      return;
    }

    if (chartType === "line" || chartType === "area" || chartType === "baseline") {
      (s as unknown as ISeriesApi<"Line">).update({ time: t, value: bar.close });
    } else {
      (s as ISeriesApi<"Candlestick">).update({ time: t, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    }
    if (volSeriesRef.current && bar.volume != null) {
      volSeriesRef.current.update({ time: t, value: bar.volume, color: bar.close >= bar.open ? withAlpha(colors.up, 0.45) : withAlpha(colors.down, 0.45) });
    }

    // indicators: recompute and update their last points
    const bars = barsRef.current;
    for (let i = 0; i < indicators.length; i++) {
      const def = getIndicator(indicators[i].id);
      if (!def) continue;
      const named = def.compute(bars, { ...def.defaults, ...indicators[i].params });
      if (def.placement === "overlay") {
        const group = overlayGroupsRef.current.find((g) => g.series.length === named.length) ?? overlayGroupsRef.current[0];
        if (!group) continue;
        for (let li = 0; li < named.length && li < group.series.length; li++) {
          const pts = named[li].data;
          const last = pts[pts.length - 1];
          if (last) group.series[li].update({ time: last.time as UTCTimestamp, value: last.value });
        }
      }
    }
    updatePanesLive(bars);
    engineRef.current?.redraw();
  }

  function updatePanesLive(bars: Bar[]) {
    for (const entry of paneChartsRef.current) {
      const def = getIndicator(entry.defId);
      const act = indicators.find((a) => a.id === entry.defId);
      if (!def || !act) continue;
      const named = def.compute(bars, { ...def.defaults, ...act.params });
      for (let li = 0; li < named.length && li < entry.series.length; li++) {
        const pts = named[li].data;
        const last = pts[pts.length - 1];
        const ser = entry.series[li];
        if (last) {
          try {
            (ser as ISeriesApi<"Line">).update({ time: last.time as UTCTimestamp, value: last.value });
          } catch { /* histogram color variant — next full render fixes */ }
        }
      }
    }
  }

  useEffect(() => {
    renderData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType, indicators, showVolume]);

  // ---- pane indicators (separate synced sub-charts) ------------------------------

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const mains = chart.timeScale();
    const unsubs: (() => void)[] = [];
    for (const p of paneChartsRef.current) {
      const ps = p.chart.timeScale();
      const mainToPane = (r: any) => { if (r && !syncingRef.current) { syncingRef.current = true; ps.setVisibleLogicalRange(r); syncingRef.current = false; } };
      const paneToMain = (r: any) => { if (r && !syncingRef.current) { syncingRef.current = true; mains.setVisibleLogicalRange(r); syncingRef.current = false; } };
      mains.subscribeVisibleLogicalRangeChange(mainToPane);
      ps.subscribeVisibleLogicalRangeChange(paneToMain);
      unsubs.push(() => mains.unsubscribeVisibleLogicalRangeChange(mainToPane));
      unsubs.push(() => ps.unsubscribeVisibleLogicalRangeChange(paneToMain));
    }
    return () => unsubs.forEach((u) => u());
  }, [paneDefs.length]);

  function recomputePaneIndicators() {
    const bars = barsRef.current;
    for (const p of paneChartsRef.current) { try { p.chart.remove(); } catch { /* gone */ } }
    paneChartsRef.current = [];
    if (!paneRefs.current.length || !bars.length) return;

    let idx = 0;
    for (const def of paneDefs) {
      const container = paneRefs.current[idx];
      idx++;
      if (!container) continue;
      const h = Math.max(90, Math.min(160, (height ?? 420) * 0.24));
      const sub = createChart(container, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: bgImageRef.current ? "transparent" : colors.bg }, textColor: colors.text, fontSize: 10, attributionLogo: false },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: "rgba(42,46,54,0.8)" },
        timeScale: { borderColor: "rgba(42,46,54,0.8)", timeVisible: true, secondsVisible: false, visible: true },
        crosshair: { mode: CrosshairMode.Normal },
        handleScroll: { mouseWheel: false, pressedMouseMove: false },
        handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: false },
      });
      const act = indicators.find((a) => a.id === def.id)!;
      const named = def.compute(bars, { ...def.defaults, ...act.params });
      const series: (ISeriesApi<"Line" | "Histogram">)[] = [];
      for (let i = 0; i < named.length; i++) {
        const nl = named[i];
        const color = indicatorColor(indicators.findIndex((a) => a.id === def.id), i);
        if (nl.kind === "histogram") {
          const hs = sub.addHistogramSeries({ priceFormat: { type: "volume" } });
          hs.setData(nl.data.map((p) => ({
            time: p.time as UTCTimestamp, value: p.value,
            color: p.value >= 0 ? withAlpha(colors.up, 0.6) : withAlpha(colors.down, 0.6),
          })));
          series.push(hs);
        } else {
          const ls = sub.addLineSeries({ color, lineWidth: 1 });
          ls.setData(nl.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
          series.push(ls);
        }
      }
      paneChartsRef.current.push({ chart: sub, defId: def.id, series, named });
    }
  }

  const setPaneRef = (el: HTMLDivElement | null, i: number) => {
    if (el) paneRefs.current[i] = el;
  };

  useEffect(() => {
    renderData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDefs]);

  // ---- replay / overlay / anchored VWAP / comparison ------------------------------

  // replay cursor moved or toggled → re-render sliced data
  useEffect(() => {
    replayRef.current = replay ?? null;
    if (!chartRef.current) return;
    renderData();
    if (replay?.active) {
      const bars = displayBars();
      const lastBar = bars[bars.length - 1];
      if (lastBar) onReplayBarRef.current?.(lastBar);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.active, replay?.upToTime]);

  // simulated-trade markers on the price series
  useEffect(() => {
    const s = seriesRef.current as unknown as { setMarkers?: (m: unknown[]) => void } | null;
    if (!s?.setMarkers) return;
    if (!tradeMarkers?.length) { s.setMarkers([]); return; }
    s.setMarkers(tradeMarkers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.kind === "entry"
        ? (m.side === "buy" ? "belowBar" : "aboveBar")
        : (m.side === "buy" ? "aboveBar" : "belowBar"),
      color: m.kind === "entry" ? (m.side === "buy" ? "#22c55e" : "#ef4444") : "#e2e8f0",
      shape: m.kind === "entry" ? (m.side === "buy" ? "arrowUp" : "arrowDown") : "circle",
      text: m.kind === "entry" ? (m.side === "buy" ? "B" : "S") : (m.profit != null ? `${m.profit >= 0 ? "+" : ""}${m.profit.toFixed(0)}` : "×"),
    })) as any);
  }, [tradeMarkers, dataVersion]);

  // position / SL / TP / pending level lines (diffed — cheap on every change)
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const next = new Map((priceLines ?? []).map((l) => [l.id, l]));
    for (const [id, line] of priceLineRefs.current) {
      if (!next.has(id)) {
        try { s.removePriceLine(line); } catch { /* gone */ }
        priceLineRefs.current.delete(id);
      }
    }
    for (const [id, l] of next) {
      const existing = priceLineRefs.current.get(id);
      if (existing) {
        existing.applyOptions({ price: l.price, color: l.color, title: l.title, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, lineWidth: l.width ?? 1 });
      } else {
        try {
          const created = s.createPriceLine({
            price: l.price, color: l.color, lineWidth: l.width ?? 1,
            lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
            axisLabelVisible: true, title: l.title,
          });
          priceLineRefs.current.set(id, created);
        } catch { /* series replaced mid-flight — next cycle fixes */ }
      }
    }
  }, [priceLines, dataVersion]);

  // clear level lines when the chart unmounts
  useEffect(() => () => {
    const s = seriesRef.current;
    for (const [, line] of priceLineRefs.current) { if (s) try { s.removePriceLine(line); } catch { /* gone */ } }
    priceLineRefs.current = new Map();
  }, []);

  // LOG / % price scale (TradingView-style)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const mode = priceScaleMode === "log" ? PriceScaleMode.Logarithmic : priceScaleMode === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal;
    try { chart.priceScale("right").applyOptions({ mode }); } catch { /* scale not ready */ }
  }, [priceScaleMode, dataVersion]);

  // magnet crosshair
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({ crosshair: { mode: magnet ? CrosshairMode.Magnet : CrosshairMode.Normal } });
  }, [magnet, dataVersion]);

  // screenshot → PNG download
  useEffect(() => {
    if (!screenshotSignal) return;
    const chart = chartRef.current;
    if (!chart) return;
    try {
      const canvas = chart.takeScreenshot();
      const a = document.createElement("a");
      a.download = `inspiretrade-${symbol}-${timeframe}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    } catch { /* chart not ready */ }
  }, [screenshotSignal, symbol, timeframe]);

  // bar-close countdown (live mode only — hidden during replay and for stale feeds)
  useEffect(() => {
    const tick = () => {
      const el = countdownRef.current;
      if (!el) return;
      if (replayRef.current?.active) { el.style.display = "none"; return; }
      const bars = barsRef.current;
      const last = bars[bars.length - 1];
      if (!last) { el.style.display = "none"; return; }
      const tf = TF_SECONDS[timeframe];
      const remain = tf - (Math.floor(Date.now() / 1000) - last.time);
      if (remain <= 0 || remain > tf) { el.style.display = "none"; return; }
      el.style.display = "";
      // h:mm:ss for daily+ timeframes, mm:ss otherwise
      el.textContent = remain >= 3600
        ? `${Math.floor(remain / 3600)}:${String(Math.floor((remain % 3600) / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")}`
        : `${String(Math.floor(remain / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")}`;
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timeframe, dataVersion]);

  // analysis overlay config
  useEffect(() => {
    if (!overlayRef.current) return;
    overlayRef.current.cfg = overlayCfg ?? DEFAULT_OVERLAY;
    overlayRef.current.render();
  }, [overlayCfg, dataVersion]);

  // anchored VWAP (amber line from the anchor bar)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try { if (avwapRef.current) chart.removeSeries(avwapRef.current); } catch { /* gone */ }
    avwapRef.current = null;
    if (anchoredVwapTime == null) return;
    const line = anchoredVwap(barsRef.current, anchoredVwapTime);
    if (!line.length) return;
    const s = chart.addLineSeries({
      color: "#fbbf24", lineWidth: 2, priceLineVisible: false,
      lastValueVisible: true, title: "AVWAP", crosshairMarkerVisible: false,
    });
    s.setData(line.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    avwapRef.current = s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchoredVwapTime, dataVersion]);

  // normalized % comparison overlay of another instrument
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const chart = chartRef.current;
      if (!chart) return;
      try { if (compareRef.current) chart.removeSeries(compareRef.current); } catch { /* gone */ }
      compareRef.current = null;
      if (!compareSymbol) { overlayRef.current?.render(); return; }
      try {
        const bars = await loadBarsCached(compareSymbol, timeframe, 1000);
        if (cancelled || !chartRef.current || !bars.length || !barsRef.current.length) return;
        const base = bars[0].close;
        const s = chartRef.current.addLineSeries({
          color: "#38bdf8", lineWidth: 1, priceScaleId: "compare",
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: compareSymbol,
        });
        s.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: ((b.close / base) - 1) * 100 })));
        chartRef.current.priceScale("compare").applyOptions({ visible: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
        compareRef.current = s;
      } catch { /* comparison data unavailable — main chart unaffected */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareSymbol, timeframe, dataVersion]);

  // ---- interactions: dblclick reset, context menu ---------------------------------

  const resetView = () => {
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const chart = chartRef.current;
    const price = Number(seriesRef.current?.coordinateToPrice(y) ?? 0);
    const time = Number(chart?.timeScale()?.coordinateToTime?.(x) ?? 0);
    setMenu({ x: Math.min(x, rect.width - 190), y: Math.min(y, rect.height - 250), price, time });
  };

  const addLineAt = (tool: "hline" | "vline", price: number, time: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const p: DrawingPoint = { time: Number.isFinite(time) ? time : Math.floor(Date.now() / 1000), price: Number.isFinite(price) ? price : 0 };
    engine.addDrawing(tool, [p]);
    engine.setTool("cursor");
    setMenu(null);
  };

  // ---- legend / labels -----------------------------------------------------------

  const feedLabel =
    feedStatus === "live" ? "LIVE" :
    feedStatus === "polling" ? "DELAYED" :
    feedStatus === "error" ? "ERROR" : "…";

  const feedColor =
    feedStatus === "live" ? "text-emerald-400" :
    feedStatus === "polling" ? "text-amber-400" :
    feedStatus === "error" ? "text-red-400" : "text-muted-foreground";

  const replaying = !!replay?.active;

  const last = barsRef.current[barsRef.current.length - 1];
  const prev = barsRef.current[barsRef.current.length - 2] ?? last;
  const dayChange = last && prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const shown = legend ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close } : null);
  const legChange = shown && prev ? ((shown.c - prev.close) / prev.close) * 100 : 0;
  const d = inst?.digits ?? 2;

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full min-h-[300px] flex-col overflow-hidden rounded-xl border border-border/50"
      style={{ background: colors.bg }}
      onContextMenu={onContextMenu}
      onDoubleClick={resetView}
      onMouseDown={() => menu && setMenu(null)}
    >
      {/* user photo BEHIND the chart — candles/grid draw on a transparent bg */}
      {bgImage && (
        <>
          <img src={bgImage} alt="" className="pointer-events-none absolute inset-0 z-0 h-full w-full object-cover" />
          <div className="pointer-events-none absolute inset-0 z-0 bg-black/30" />
        </>
      )}

      {/* legend bar — text follows the chart theme (visible on light backgrounds too) */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] leading-none" style={{ color: colors.text }}>
        <span className="font-bold">{symbol}</span>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: withAlpha(colors.text, 0.12) }}>{timeframe}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${feedColor}`} title={feedMsg}>{feedLabel}</span>
        {replaying && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-400">REPLAY {new Date(replay!.upToTime * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
        {compareSymbol && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">vs {compareSymbol}</span>}
        {shown && feedStatus !== "error" && (
          <span className="font-number hidden items-center gap-1.5 sm:flex">
            <span>O <b>{shown.o?.toFixed(d)}</b></span>
            <span>H <b>{shown.h?.toFixed(d)}</b></span>
            <span>L <b>{shown.l?.toFixed(d)}</b></span>
            <span>C <b className={legChange >= 0 ? "text-emerald-400" : "text-red-400"}>{shown.c?.toFixed(d)}</b></span>
            <b className={legChange >= 0 ? "text-emerald-400" : "text-red-400"}>{legChange >= 0 ? "+" : ""}{legChange.toFixed(2)}%</b>
          </span>
        )}
        {last && feedStatus !== "error" && <span className={`ml-auto font-number font-bold ${dayChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>{last.close.toFixed(d)} <span className="text-[10px] font-normal">({dayChange >= 0 ? "+" : ""}{dayChange.toFixed(2)}%)</span></span>}
        {feedStatus === "polling" && <span className="ml-auto text-[9px] text-amber-400/80" title={feedMsg}>delayed ≤15m</span>}
      </div>

      {/* chart + panes + drawing layer */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={mainRef} className="absolute inset-0" />
          <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0 z-[9]" />
          <canvas ref={drawCanvasRef} className="absolute inset-0 z-10" style={{ touchAction: "none" }} />
          {/* bar-close countdown (bottom-right, above the time axis) */}
          <span ref={countdownRef} style={{ display: "none" }}
            className="pointer-events-none absolute bottom-[34px] right-[74px] z-[12] rounded bg-[#131a24]/90 px-1.5 py-0.5 font-number text-[11px] font-bold text-emerald-400 shadow"
            title="Time until this candle closes" />

          {/* loading state */}
          {loading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#0b0e13]/80">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
              <div className="text-xs text-muted-foreground">Loading {symbol} · {timeframe}…</div>
            </div>
          )}

          {/* error state — no fake data fallback */}
          {!loading && feedStatus === "error" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2.5 bg-[#0b0e13]/90 px-6 text-center">
              <WifiOff className="h-7 w-7 text-red-400" />
              <div className="text-sm font-semibold text-foreground">Market data unavailable</div>
              <div className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">{errorMsg}</div>
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="mt-1 flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/20"
              >
                <RefreshCw className="h-3.5 w-3.5" />Retry
              </button>
            </div>
          )}
        </div>

        {paneDefs.map((def, i) => (
          <div key={def.id + i} className="relative border-t border-border/40" style={{ height: Math.max(90, Math.min(160, (height ?? 420) * 0.24)) }}>
            <div className="absolute left-2 top-1 z-10 text-[10px] font-semibold text-muted-foreground">
              {INDICATORS.find((x) => x.id === def.id)?.label}
            </div>
            <div ref={(el) => setPaneRef(el, i)} className="absolute inset-0" />
          </div>
        ))}
      </div>

      {/* right-click context menu */}
      {menu && (
        <div
          className="absolute z-30 w-44 overflow-hidden rounded-lg border border-border/60 bg-[#11151c] py-1 text-[11px] shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem onClick={resetView}>Reset view</MenuItem>
          <MenuItem onClick={() => { chartRef.current?.timeScale().scrollToRealTime(); setMenu(null); }}>Scroll to real-time</MenuItem>
          <div className="my-1 h-px bg-border/50" />
          <MenuItem onClick={() => addLineAt("hline", menu.price, menu.time)}>Horizontal line @ {menu.price.toFixed(d)}</MenuItem>
          <MenuItem onClick={() => addLineAt("vline", menu.price, menu.time)}>Vertical line here</MenuItem>
          {(onReplayMenu ? onReplayMenu(menu.price, menu.time) : []).map((item) => (
            <MenuItem key={item.label} onClick={() => { item.onClick(); setMenu(null); }}>{item.label}</MenuItem>
          ))}
          {onAnchorVwap && <MenuItem onClick={() => { onAnchorVwap(Number.isFinite(menu.time) ? menu.time : null); setMenu(null); }}>{anchoredVwapTime != null ? "Clear anchored VWAP" : "Anchor VWAP here"}</MenuItem>}
          <div className="my-1 h-px bg-border/50" />
          <MenuItem onClick={() => { engineRef.current?.clearAll(); setMenu(null); }}>Clear drawings</MenuItem>
          <MenuItem onClick={() => { setGridOn((v) => !v); setMenu(null); }}>{gridOn ? "Hide" : "Show"} grid</MenuItem>
          {onToggleVolume && <MenuItem onClick={() => { onToggleVolume(); setMenu(null); }}>{showVolume ? "Hide" : "Show"} volume</MenuItem>}
          {onRequestFullscreen && <MenuItem onClick={() => { onRequestFullscreen(); setMenu(null); }}>Fullscreen</MenuItem>}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="block w-full px-3 py-1.5 text-left text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-400">
      {children}
    </button>
  );
}
