/**
 * PriceChart — professional TradingView-style chart (Lightweight Charts v4).
 *
 *  - main pane: candles + volume + overlay indicators (SMA/EMA/BB/VWAP)
 *  - sub-panes: RSI / MACD / Stochastic / ATR with synced time scale + crosshair
 *  - drawing tools overlay (DrawingCanvas): trend/ray/hline/vline/rect/channel/
 *    fib retracement/extension/text, move/edit/delete, persisted per user
 *  - trading integration: draggable SL/TP + entry lines, pending-order price
 *    lines, buy/sell markers from the fills ledger
 *  - crosshair OHLC legend, candle-close countdown, progressive history
 *    (Binance paging), fullscreen, reset, symbol search, layouts
 *
 * All chart mutation is imperative (refs + series.update) — the 10s account
 * heartbeat and every live tick cause ZERO React re-renders here.
 * Real feeds only: on failure an error state with retry is shown, never fake data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createChart, ColorType, CrosshairMode, LineStyle, PriceScaleMode,
  type IChartApi, type IPriceLine, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import {
  loadFeed, subscribeFeed, binanceProvider, getConnectionState, subscribeConnection, getFeedStats, markChartUpdate,
  type FeedStatus,
} from "@/lib/market-data";
import { getInstrument, TF_SECONDS, type Bar, type Timeframe } from "@shared/terminal";
import { SPREAD_PIPS } from "@shared/trading-engine";
import { loadChartType, saveChartType, type ChartType } from "@/lib/chart-types";
import { priceBusUpdate } from "@/lib/price-store";
import { tradingApi, type ServerPosition, type ServerTrade } from "@/lib/trading-api";
import { useAuth } from "@/hooks/use-auth";
import {
  atr, bollinger, ema, macd as macdCalc, rsi as rsiCalc, sma, stochastic, vwap as vwapCalc,
  type Point,
} from "@/lib/indicators";
import {
  INDICATOR_CATALOG, newIndicatorConfig, type IndicatorConfig, type IndicatorType,
} from "@/lib/indicators-config";
import { effectiveName, isVisibleOnTf, type Drawing, type DrawingType } from "@/lib/drawings";
import {
  subscribeDrawings, saveDrawings, clearDrawings as clearDrawingsRemote,
  subscribeIndicators, saveIndicators,
  type LayoutSnapshot,
} from "@/lib/chart-persistence";
import {
  DrawingCanvas, type ChartConverter, type DrawingCanvasHandle, type TradeLine,
} from "@/components/terminal/chart/DrawingCanvas";
import { ChartToolbar } from "@/components/terminal/chart/ChartToolbar";
import { LeftRail } from "@/components/terminal/chart/LeftRail";
import { DrawingPropsBar } from "@/components/terminal/chart/DrawingPropsBar";
import { cursorCss, type CursorMode } from "@/components/terminal/chart/cursor-mode";
import { loadDrawingTemplates, saveDrawingTemplate, deleteDrawingTemplate, type DrawingTemplate } from "@/lib/chart-persistence";
import {
  ChartContextMenu, ChartSettings, DEFAULT_SETTINGS, DrawingPropsDialog, IndicatorParamsDialog,
  LayoutsDialog, SettingsDialog, SymbolSearchDialog, type ContextMenuState,
} from "@/components/terminal/chart/dialogs";
import { Eye, EyeOff, X, Activity } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-admin";
import { cn } from "@/lib/utils";

export interface PriceMark {
  id: string;
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

const COLORS = {
  bg: "#0b1220",
  text: "#94a3b8",
  grid: "#16213a",
  up: "#22c55e",
  down: "#ef4444",
  accent: "#3b82f6",
};

const SUB_PANE_HEIGHT = 110;
const PANE_BG = "#0a101f";

// ---- main-series abstraction: candlestick / hollow / line / area -------------
type MainKind = "candle" | "hollow" | "line" | "area";
type MainSeriesApi = ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;

function hexAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function createMainSeries(chart: IChartApi, type: ChartType, s: { upColor: string; downColor: string }): { series: MainSeriesApi; kind: MainKind } {
  if (type === "line") {
    return { kind: "line", series: chart.addLineSeries({ color: s.upColor, lineWidth: 2, priceLineVisible: true, lastValueVisible: true }) as MainSeriesApi };
  }
  if (type === "area") {
    return {
      kind: "area",
      series: chart.addAreaSeries({
        lineColor: s.upColor, topColor: hexAlpha(s.upColor, 0.26), bottomColor: "rgba(0,0,0,0)",
        lineWidth: 2, priceLineVisible: true, lastValueVisible: true,
      }) as MainSeriesApi,
    };
  }
  const hollow = type === "hollow";
  return {
    kind: hollow ? "hollow" : "candle",
    series: chart.addCandlestickSeries({
      // hollow: rising candles transparent with a colored border, falling filled
      upColor: hollow ? "rgba(0,0,0,0)" : s.upColor,
      downColor: s.downColor,
      borderUpColor: s.upColor, borderDownColor: s.downColor,
      wickUpColor: s.upColor, wickDownColor: s.downColor,
      priceLineVisible: true, priceLineWidth: 1, lastValueVisible: true,
    }) as MainSeriesApi,
  };
}

/** Theme the main series from user settings (per kind). */
function applyMainTheme(series: MainSeriesApi, kind: MainKind, s: { upColor: string; downColor: string }): void {
  if (kind === "candle") {
    (series as ISeriesApi<"Candlestick">).applyOptions({
      upColor: s.upColor, downColor: s.downColor,
      borderUpColor: s.upColor, borderDownColor: s.downColor,
      wickUpColor: s.upColor, wickDownColor: s.downColor,
    });
  } else if (kind === "hollow") {
    (series as ISeriesApi<"Candlestick">).applyOptions({
      upColor: "rgba(0,0,0,0)",
      borderUpColor: s.upColor, wickUpColor: s.upColor,
      downColor: s.downColor, borderDownColor: s.downColor, wickDownColor: s.downColor,
    });
  } else if (kind === "line") {
    (series as ISeriesApi<"Line">).applyOptions({ color: s.upColor, lineWidth: 2 });
  } else {
    (series as ISeriesApi<"Area">).applyOptions({ lineColor: s.upColor, topColor: hexAlpha(s.upColor, 0.26), bottomColor: "rgba(0,0,0,0)", lineWidth: 2 });
  }
}

function setMainData(series: MainSeriesApi, kind: MainKind, data: Bar[]): void {
  if (kind === "line" || kind === "area") {
    (series as ISeriesApi<"Line">).setData(data.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })));
  } else {
    (series as ISeriesApi<"Candlestick">).setData(data.map(toCandle));
  }
}

function updateMain(series: MainSeriesApi, kind: MainKind, b: Bar): void {
  if (kind === "line" || kind === "area") {
    (series as ISeriesApi<"Line">).update({ time: b.time as UTCTimestamp, value: b.close });
  } else {
    (series as ISeriesApi<"Candlestick">).update(toCandle(b));
  }
}

interface LoadedState { status: FeedStatus; message?: string; error?: string }

interface PaneHandle {
  chart: IChartApi;
  container: HTMLElement;
  series: ISeriesApi<"Line" | "Histogram">[];
  syncHandler: (range: { from: number; to: number } | null) => void;
  crossHandler: (param: MouseEventParamsLite) => void;
}

/** minimal shape we rely on from crosshair params */
interface MouseEventParamsLite { time?: Time; point?: { x: number; y: number } }

export function PriceChart({
  symbol,
  timeframe,
  marks,
  accountId,
  positions,
  onModifyPosition,
  onSymbolChange,
  onTimeframeChange,
  onOpenAlerts,
  onOpenReplay,
  className,
  height,
  replayBars = null,
  replayCursor = null,
  replayForming = null,
  replayStatus = null,
}: {
  symbol: string;
  timeframe: Timeframe;
  /** pending-order price lines (positions render as draggable trade lines) */
  marks: PriceMark[];
  accountId: string | null;
  positions: ServerPosition[];
  onModifyPosition: (positionId: string, patch: { sl?: number | null; tp?: number | null }) => Promise<unknown>;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (tf: Timeframe) => void;
  /** toolbar alert button → open the alerts panel (right rail) */
  onOpenAlerts?: () => void;
  /** toolbar replay button → switch to replay mode */
  onOpenReplay?: () => void;
  className?: string;
  /** Fixed pixel height; omit to fill the parent box. */
  height?: number;
  /** REPLAY MODE: external historical bars — the chart never loads a feed and
   *  renders only bars[0..cursor] (+ the forming bar), hiding the future. */
  replayBars?: Bar[] | null;
  replayCursor?: number | null;
  /** the currently forming candle (real OHLC sub-point path, parent-computed) */
  replayForming?: Bar | null;
  /** replay status line, e.g. "REPLAY · 5m · paused" */
  replayStatus?: string | null;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mainHostRef = useRef<HTMLDivElement | null>(null);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<MainSeriesApi | null>(null);
  const mainKindRef = useRef<MainKind>("candle");
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // bid/ask price lines (engine-consistent spread around the mid)
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const lastMidRef = useRef<number | null>(null);
  const overlayRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const paneRef = useRef<Map<string, PaneHandle>>(new Map());
  const lineHandlesRef = useRef<IPriceLine[]>([]);
  const barsRef = useRef<Bar[]>([]);
  const tfSecRef = useRef(300);
  const timeIdxRef = useRef<Map<number, number>>(new Map());
  const indValuesRef = useRef<Map<string, Map<string, Point[]>>>(new Map()); // indId → seriesKey → values
  const olderLoadingRef = useRef(false);
  const tradesRef = useRef<ServerTrade[]>([]);
  const syncingRef = useRef(false);
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const countdownRef = useRef<HTMLDivElement | null>(null);

  const [loaded, setLoaded] = useState<LoadedState>({ status: "connecting" });
  const [reloadKey, setReloadKey] = useState(0);
  const [chartType, setChartTypeState] = useState<ChartType>(() => loadChartType());
  const chartTypeRef = useRef(chartType);
  chartTypeRef.current = chartType;
  // TradingView object-state controls (persisted)
  const [locked, setLocked] = useState(() => { try { return localStorage.getItem("it_chart_lock") === "1"; } catch { return false; } });
  const [hiddenAll, setHiddenAll] = useState(() => { try { return localStorage.getItem("it_chart_hideall") === "1"; } catch { return false; } });
  const [scaleMode, setScaleMode] = useState<"normal" | "log" | "percent">(() => {
    try { const v = localStorage.getItem("it_chart_scale"); return v === "log" || v === "percent" ? v : "normal"; } catch { return "normal"; }
  });
  // honest connection state (transitions only — never per tick)
  const conn = useSyncExternalStore(subscribeConnection, getConnectionState);
  const lastTickRef = useRef<HTMLSpanElement | null>(null);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const isAdmin = useIsAdmin();
  const [diagOpen, setDiagOpen] = useState(false);
  // drawing undo/redo (past/future snapshots of the committed list)
  const historyRef = useRef<Drawing[][]>([]);
  const futureRef = useRef<Drawing[][]>([]);
  const [histLens, setHistLens] = useState({ u: 0, r: 0 });
  const [activeTool, setActiveTool] = useState<DrawingType | "cursor">("cursor");
  const [cursorMode, setCursorMode] = useState<CursorMode>(() => {
    try { return (localStorage.getItem("it_cursor_mode") as CursorMode) || "cross"; } catch { return "cross"; }
  });
  const [templates, setTemplates] = useState<DrawingTemplate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const copyRef = useRef<Drawing[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [editingDrawing, setEditingDrawing] = useState<Drawing | null>(null);
  const [editingIndicator, setEditingIndicator] = useState<IndicatorConfig | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [openDialog, setOpenDialog] = useState<"settings" | "layouts" | "search" | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(() => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("it_chart_settings") || "{}") }; }
    catch { return DEFAULT_SETTINGS; }
  });

  // ---- bid/ask price lines (server-consistent spread: SPREAD_PIPS × pipSize) --
  const updateBidAsk = useCallback((mid: number | null) => {
    const candle = candleRef.current;
    if (!candle) return;
    const s = settingsRef.current;
    const inst = getInstrument(symbolRef.current);
    if (!s.bidAsk || mid == null || !Number.isFinite(mid) || mid <= 0 || !inst) {
      try { if (bidLineRef.current) candle.removePriceLine(bidLineRef.current); } catch { /* gone */ }
      try { if (askLineRef.current) candle.removePriceLine(askLineRef.current); } catch { /* gone */ }
      bidLineRef.current = null;
      askLineRef.current = null;
      return;
    }
    lastMidRef.current = mid;
    const spread = (SPREAD_PIPS[symbolRef.current] ?? 2) * inst.pipSize;
    const bid = mid - spread / 2;
    const ask = mid + spread / 2;
    const hang = (title: string, price: number, color: string, prev: IPriceLine | null): IPriceLine => {
      if (prev) { prev.applyOptions({ price, title }); return prev; }
      return candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title });
    };
    bidLineRef.current = hang("BID", bid, "rgba(239,68,68,0.8)", bidLineRef.current);
    askLineRef.current = hang("ASK", ask, "rgba(34,197,94,0.8)", askLineRef.current);
  }, []);

  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const inst = useMemo(() => getInstrument(symbol), [symbol]);
  const digits = inst?.digits ?? 2;
  const priceFormat = useMemo(
    () => ({ type: "price" as const, precision: digits, minMove: Math.pow(10, -digits) }),
    [digits],
  );

  // Defensive normalization: a stale/hybrid deploy or an RTDB-shaped payload can
  // hand us non-array marks/positions — a broken iterable must never black-screen
  // the terminal, so degrade to "no lines" instead of crashing.
  const safeMarks = Array.isArray(marks) ? marks : [];
  const safePositions = Array.isArray(positions) ? positions : [];

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const marksRef = useRef(safeMarks);
  marksRef.current = safeMarks;
  const positionsRef = useRef(safePositions);
  positionsRef.current = safePositions;
  const onModifyRef = useRef(onModifyPosition);
  onModifyRef.current = onModifyPosition;

  // ---- replay mode: external bars, no feed subscription ----------------------
  const replayBarsRef = useRef<Bar[] | null>(replayBars);
  replayBarsRef.current = replayBars;
  const replayFormingRef = useRef<Bar | null>(replayForming);
  replayFormingRef.current = replayForming;
  const replayCursorRef = useRef<number | null>(replayCursor);
  replayCursorRef.current = replayCursor;
  const replayStatusRef = useRef<string | null>(replayStatus);
  replayStatusRef.current = replayStatus;
  const replayModeRef = useRef(false);
  replayModeRef.current = replayBars != null;

  /** the visible replay series: bars[0..cursor] (+ forming bar) — the future stays hidden */
  const replayVisible = useCallback((cursor: number): Bar[] => {
    const bars = replayBarsRef.current;
    if (!bars) return [];
    const closed = bars.slice(0, Math.max(0, Math.min(cursor, bars.length)));
    const forming = replayFormingRef.current;
    if (forming && forming.time === (bars[cursor]?.time ?? -1)) return [...closed, forming];
    return closed;
  }, []);

  // cursor mode → host element style (arrow / dot bitmap / crosshair)
  useEffect(() => {
    try { localStorage.setItem("it_cursor_mode", cursorMode); } catch { /* private mode */ }
    const el = chartAreaRef.current;
    if (el) el.style.cursor = cursorCss(cursorMode);
  }, [cursorMode]);

  // drawing templates (per user, RTDB + LS)
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    loadDrawingTemplates(uid).then((t) => { if (alive) setTemplates(t); }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [uid]);

  // ---- settings + indicator appearance → chart options ----------------------
  useEffect(() => {
    localStorage.setItem("it_chart_settings", JSON.stringify(settings));
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;
    chart.applyOptions({
      grid: settings.grid
        ? { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } }
        : { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: {
        mode: settings.magnet ? CrosshairMode.Magnet : CrosshairMode.Normal,
        vertLine: { visible: true, labelVisible: true, color: "rgba(224,229,237,0.35)", labelBackgroundColor: "#2a2e39" },
        horzLine: { visible: true, labelVisible: true, color: "rgba(224,229,237,0.35)", labelBackgroundColor: "#2a2e39" },
      },
    });
    candle.applyOptions({
      upColor: settings.upColor, downColor: settings.downColor,
      borderUpColor: settings.upColor, borderDownColor: settings.downColor,
      wickUpColor: settings.upColor, wickDownColor: settings.downColor,
    });
    volumeRef.current?.applyOptions({ visible: settings.volume });
    canvasRef.current?.redraw();
  }, [settings]);

  // ---- chart type switch: rebuild the main series in place (no flicker) -------
  useEffect(() => {
    saveChartType(chartType);
    const chart = chartRef.current;
    const old = candleRef.current;
    if (!chart || !old) return;
    const volume = volumeRef.current;
    try { if (volume) chart.removeSeries(volume); } catch { /* gone */ }
    try { chart.removeSeries(old); } catch { /* gone */ }
    const main = createMainSeries(chart, chartType, { upColor: settingsRef.current.upColor, downColor: settingsRef.current.downColor });
    candleRef.current = main.series;
    mainKindRef.current = main.kind;
    const volume2 = chart.addHistogramSeries({
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    volumeRef.current = volume2;
    volume2.applyOptions({ visible: settingsRef.current.volume });
    if (barsRef.current.length) applyBarsToSeries("set");
    applyMarkers();
    setSeriesEpoch((e) => e + 1); // re-hang pending lines on the new series
    updateBidAsk(lastMidRef.current);
    updateLegend(null);
    canvasRef.current?.redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  // ---- create main chart once ------------------------------------------------
  useEffect(() => {
    const el = mainHostRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: COLORS.bg }, textColor: COLORS.text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, visible: true, rightOffset: 8 },
      // TradingView-style crosshair: labels on BOTH axes snap to the hovered
      // candle, axis labels match the dark theme
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(224,229,237,0.35)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#2a2e39", labelVisible: true, visible: true },
        horzLine: { color: "rgba(224,229,237,0.35)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#2a2e39", labelVisible: true, visible: true },
      },
    });
    chartRef.current = chart;
    const main = createMainSeries(chart, chartTypeRef.current, { upColor: settingsRef.current.upColor, downColor: settingsRef.current.downColor });
    candleRef.current = main.series;
    mainKindRef.current = main.kind;
    const volume = chart.addHistogramSeries({
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    volumeRef.current = volume;

    // double-click → reset the scale (drawing hits are consumed upstream)
    const onDbl = (e: MouseEvent) => {
      e.preventDefault();
      const ts = chartRef.current?.timeScale();
      if (!ts) return;
      ts.fitContent();
      ts.scrollToRealTime();
    };
    el.addEventListener("dblclick", onDbl);

    // progressive history: near the left edge → prepend older Binance candles
    const onRangeChange = () => {
      if (chartRef.current !== chart) return; // teardown race — chart already removed
      canvasRef.current?.redraw();
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const data = barsRef.current;
      const instNow = getInstrument(symbol);
      if (
        range.from < 60 && data.length && instNow?.feed === "binance" &&
        !olderLoadingRef.current && tfSecRef.current > 0
      ) {
        olderLoadingRef.current = true;
        const oldest = data[0].time;
        binanceProvider.loadOlder(symbol, timeframe, oldest, 1000)
          .then((older) => {
            if (!older.length) return;
            const map = new Map<number, Bar>();
            for (const b of older) map.set(b.time, b);
            for (const b of data) map.set(b.time, b);
            barsRef.current = [...map.values()].sort((a, b) => a.time - b.time);
            applyBarsToSeries("set");
            const newFrom = barsRef.current[0].time as UTCTimestamp;
            const oldTo = data[data.length - 1].time as UTCTimestamp;
            try { ts.setVisibleRange({ from: newFrom, to: oldTo }); } catch { /* race — ignore */ }
          })
          .catch(() => { /* transient — the next scroll tries again */ })
          .finally(() => { olderLoadingRef.current = false; });
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    // crosshair → legend + sub-panes
    const onCross = (param: any) => {
      if (chartRef.current !== chart) return; // teardown race — chart already removed
      updateLegend(param?.time ?? null);
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        for (const pane of paneRef.current.values()) pane.crossHandler(param ?? {});
      } finally { syncingRef.current = false; }
      canvasRef.current?.redraw();
    };
    chart.subscribeCrosshairMove(onCross as any);

    const ro = new ResizeObserver(() => { canvasRef.current?.redraw(); });
    ro.observe(el);
    return () => {
      // order matters: kill every handle that could touch the chart AFTER remove()
      converterRef.current = null;
      ro.disconnect();
      el.removeEventListener("dblclick", onDbl);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onCross as any);
      for (const p of paneRef.current.values()) p.chart.remove();
      paneRef.current.clear();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      overlayRef.current.clear();
      lineHandlesRef.current = [];
    };
    // symbol/timeframe are handled by the feed effect — the chart instance persists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- converter (market coords ↔ pane pixels) --------------------------------
  const converterRef = useRef<ChartConverter | null>(null);
  const updateConverter = useCallback(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    const el = mainHostRef.current;
    if (!chart || !candle || !el) { return; }
    const conv: ChartConverter = {
      get paneW() { return Math.max(1, el.clientWidth - chart.priceScale("right").width()); },
      get paneH() { return el.clientHeight; },
      x(time: number): number | null {
        const ts = chart.timeScale();
        const direct = ts.timeToCoordinate(time as UTCTimestamp);
        if (direct != null) return direct;
        const logical = timeToLogical(barsRef.current, tfSecRef.current, time);
        if (logical == null) return null;
        return ts.logicalToCoordinate(logical as any);
      },
      y(price: number): number | null {
        return candle.priceToCoordinate(price);
      },
      time(x: number): number | null {
        const logical = chart.timeScale().coordinateToLogical(x) as number | null;
        if (logical == null) return null;
        return logicalToTime(barsRef.current, tfSecRef.current, logical);
      },
      price(y: number): number | null {
        return candle.coordinateToPrice(y) as number | null;
      },
    };
    converterRef.current = conv;
  }, []);
  useEffect(() => { updateConverter(); }, [updateConverter]);

  // ---- indicator computation + application -----------------------------------
  const computeIndicator = useCallback((cfg: IndicatorConfig, bars: Bar[]): Map<string, Point[]> => {
    const meta = INDICATOR_CATALOG[cfg.type];
    const out = new Map<string, Point[]>();
    const closes = bars.map((b) => b.close);
    const p = (k: string) => Number(cfg.params[k]);
    switch (cfg.type) {
      case "sma": out.set("sma", sma(closes, p("period"))); break;
      case "ema": out.set("ema", ema(closes, p("period"))); break;
      case "bb": {
        const r = bollinger(closes, p("period"), p("mult"));
        out.set("basis", r.basis); out.set("upper", r.upper); out.set("lower", r.lower);
        break;
      }
      case "vwap": out.set("vwap", vwapCalc(bars).vwap); break;
      case "volume": out.set("volume", bars.map((b) => (b.volume ?? 0) || null)); break; // pane use only
      case "rsi": out.set("rsi", rsiCalc(closes, p("period"))); break;
      case "macd": {
        const r = macdCalc(closes, p("fast"), p("slow"), p("signal"));
        out.set("macd", r.macd); out.set("signal", r.signal); out.set("hist", r.hist);
        break;
      }
      case "stoch": {
        const r = stochastic(bars, p("kPeriod"), p("dPeriod"));
        out.set("k", r.k); out.set("d", r.d);
        break;
      }
      case "atr": out.set("atr", atr(bars, p("period"))); break;
      default: void meta; break;
    }
    return out;
  }, []);

  const applyBarsToSeries = useCallback((mode: "set" | "update") => {
    const candle = candleRef.current;
    const volume = volumeRef.current;
    const data = barsRef.current;
    if (!candle || !volume || !data.length) return;
    if (mode === "set") {
      (candle as ISeriesApi<"Candlestick">).applyOptions({ priceFormat: priceFormatRef.current } as any);
      applyMainTheme(candle, mainKindRef.current, settingsRef.current);
      setMainData(candle, mainKindRef.current, data);
      volume.setData(data.map(toVolume));
      // rebuild the time→index map (indicators + crosshair lookups)
      const idx = new Map<number, number>();
      for (let i = 0; i < data.length; i++) idx.set(data[i].time, i);
      timeIdxRef.current = idx;
    } else {
      const last = data[data.length - 1];
      updateMain(candle, mainKindRef.current, last);
      volume.update(toVolume(last));
    }

    // indicators: overlays on the main series + sub-pane series
    for (const cfg of indicatorsRef.current) {
      if (!cfg.visible) continue;
      const values = computeIndicator(cfg, data);
      indValuesRef.current.set(cfg.id, values);
      const color = String(cfg.params.color || INDICATOR_CATALOG[cfg.type].colors[0] || COLORS.accent);
      if (INDICATOR_CATALOG[cfg.type].pane === "main" && cfg.type !== "volume") {
        const seriesMap = overlayRef.current;
        const keys = [...values.keys()];
        // ensure series exist for each key
        for (const key of keys) {
          const id = `${cfg.id}:${key}`;
          if (!seriesMap.has(id)) {
            const s = chartRef.current!.addLineSeries({
              color, lineWidth: 1, priceLineVisible: false, lastValueVisible: key !== "upper" && key !== "lower",
              crosshairMarkerVisible: false,
            });
            seriesMap.set(id, s);
          }
        }
        for (const [key, arr] of values) {
          const s = seriesMap.get(`${cfg.id}:${key}`);
          if (!s) continue;
          const points = seriesToLineData(data, arr);
          if (mode === "set") s.setData(points);
          else if (points.length) s.update(points[points.length - 1]);
        }
      }
      const pane = paneRef.current.get(cfg.id);
      if (pane) {
        for (const [key, arr] of values) {
          const s = pane.series.find((x) => x && (x as any).__key === key);
          if (!s) continue;
          const points = seriesToLineData(data, arr, key === "hist");
          if (mode === "set") s.setData(points);
          else if (points.length) s.update(points[points.length - 1]);
        }
      }
    }
  }, [computeIndicator]);

  const priceFormatRef = useRef(priceFormat);
  priceFormatRef.current = priceFormat;
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  // ---- feed load + live subscribe ---------------------------------------------
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    setLoaded({ status: "connecting" });
    tfSecRef.current = TF_SECONDS[timeframe];
    barsRef.current = [];
    // remove leftover overlay series from the previous symbol/timeframe
    for (const [, s] of overlayRef.current) {
      try { chartRef.current?.removeSeries(s); } catch { /* already gone */ }
    }
    overlayRef.current.clear();
    timeIdxRef.current = new Map();

    // REPLAY MODE — the session supplies the bars; never touch the live feed
    if (replayModeRef.current) {
      barsRef.current = replayVisible(replayCursorRef.current ?? 0);
      applyBarsToSeries("set");
      applyMarkers();
      updateLegend(null);
      canvasRef.current?.redraw();
      setLoaded({ status: "polling", message: replayStatusRef.current ?? "Replay · historical data" });
      return;
    }

    (async () => {
      try {
        const { bars, status, message } = await loadFeed(symbol, timeframe);
        if (disposed) return;
        barsRef.current = bars;
        applyBarsToSeries("set");
        applyMarkers();
        updateLegend(null);
        updateBidAsk(bars.length ? bars[bars.length - 1].close : null);
        canvasRef.current?.redraw();
        chartRef.current?.timeScale().scrollToRealTime();
        setLoaded({ status, message });

        unsub = subscribeFeed(symbol, timeframe, ({ lastBar }) => {
          barsRef.current = upsertLocal(barsRef.current, lastBar);
          applyBarsToSeries("update");
          markChartUpdate();
          updateLegend(null);
          updateBidAsk(lastBar.close);
          canvasRef.current?.redraw();
          priceBusUpdate(symbol, lastBar.close); // panels read live prices from the store
        });
      } catch (e: any) {
        if (disposed) return;
        setLoaded({ status: "error", error: String(e?.message || e) });
      }
    })();

    return () => {
      disposed = true;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, reloadKey]);

  // ---- replay cursor/forming-candle updates -----------------------------------
  useEffect(() => {
    if (!replayModeRef.current) return;
    const chart = chartRef.current;
    if (!chart) return;
    const next = replayVisible(replayCursor ?? 0);
    const prev = barsRef.current;
    // append/update path: same-or-growing series → cheap series.update on the
    // tail; shrinking (jump backwards, new session) → full setData
    const grows = next.length >= prev.length &&
      (prev.length === 0 || next[next.length - 1].time >= prev[prev.length - 1].time);
    if (grows && prev.length > 0 && next.length > 0 &&
        next[next.length - 1].time === prev[prev.length - 1].time && next.length === prev.length) {
      barsRef.current = next;
      applyBarsToSeries("update");
    } else if (grows && next.length === prev.length + 1 &&
               next[next.length - 2]?.time === prev[prev.length - 1]?.time) {
      barsRef.current = next;
      candleRef.current?.update(toCandle(next[next.length - 1]));
      volumeRef.current?.update(toVolume(next[next.length - 1]));
      const idx = timeIdxRef.current;
      if (idx.size) idx.set(next[next.length - 1].time, next.length - 1);
    } else {
      barsRef.current = next;
      applyBarsToSeries("set");
      applyMarkers();
    }
    updateLegend(null);
    canvasRef.current?.redraw();
    const last = next[next.length - 1];
    if (last) priceBusUpdate(symbol, last.close); // ticket/blotter read live prices
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayCursor, replayForming]);

  // ---- indicator list change → full recompute + pane lifecycle ----------------
  const subKey = indicators
    .filter((i) => i.visible && INDICATOR_CATALOG[i.type].pane === "sub")
    .map((i) => `${i.id}:${i.type}:${JSON.stringify(i.params)}`)
    .join("|");
  const overlayKey = indicators
    .filter((i) => i.visible && INDICATOR_CATALOG[i.type].pane === "main" && i.type !== "volume")
    .map((i) => `${i.id}:${JSON.stringify(i.params)}`)
    .join("|");

  useEffect(() => {
    if (!chartRef.current || !barsRef.current.length) return;
    applyBarsToSeries("set");
  }, [overlayKey, applyBarsToSeries]);

  const subList = indicators.filter((i) => i.visible && INDICATOR_CATALOG[i.type].pane === "sub");

  // create/destroy pane charts when the visible sub-indicator set changes
  useEffect(() => {
    const mainChart = chartRef.current;
    if (!mainChart) return;
    const wanted = new Set(subList.map((i) => i.id));
    for (const [id, pane] of [...paneRef.current]) {
      if (!wanted.has(id)) {
        pane.chart.remove();
        paneRef.current.delete(id);
      }
    }
    for (const cfg of subList) {
      if (paneRef.current.has(cfg.id)) continue;
      const host = paneHostRefs.current.get(cfg.id);
      if (!host) continue;
      const chart = createChart(host, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: PANE_BG }, textColor: COLORS.text, fontSize: 10, attributionLogo: false },
        grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, visible: cfg.id === subList[subList.length - 1]?.id },
      });
      const series: ISeriesApi<"Line" | "Histogram">[] = [];
      const addLine = (key: string, color: string, lineWidth: 1 | 2, opts: Record<string, unknown> = {}) => {
        const s = chart.addLineSeries({
          color, lineWidth, priceLineVisible: false, lastValueVisible: false, ...opts,
        } as any);
        (s as any).__key = key;
        series.push(s);
        return s;
      };
      if (cfg.type === "rsi") addLine("rsi", "#38bdf8", 2, { priceScaleId: "right" });
      if (cfg.type === "macd") {
        addLine("macd", "#38bdf8", 1);
        addLine("signal", "#f59e0b", 1);
        const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        (hist as any).__key = "hist";
        series.push(hist);
      }
      if (cfg.type === "stoch") { addLine("k", "#38bdf8", 1); addLine("d", "#f59e0b", 1); }
      if (cfg.type === "atr") addLine("atr", "#e879f9", 2);

      // time-scale sync: pane follows main; main follows pane (guarded)
      const syncHandler = (range: { from: number; to: number } | null) => {
        if (syncingRef.current || !range) return;
        if (chartRef.current !== mainChart || !paneRef.current.has(cfg.id)) return; // teardown race
        syncingRef.current = true;
        try { mainChart.timeScale().setVisibleLogicalRange(range as any); } catch { /* race */ } finally { syncingRef.current = false; }
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange((r) => syncHandler(r ? { from: r.from, to: r.to } : null));
      const crossHandler = (param: MouseEventParamsLite) => {
        if (syncingRef.current || !paneRef.current.has(cfg.id)) return; // teardown race
        const t = param?.time;
        if (t == null) { try { chart.clearCrosshairPosition(); } catch { /* noop */ } return; }
        const idx = timeIdxRef.current.get(t as number);
        if (idx == null) return;
        syncingRef.current = true;
        try {
          const s = series[0];
          const v = s && indValuesRef.current.get(cfg.id);
          const val = v?.get((s as any).__key)?.[idx] ?? null;
          if (val != null) chart.setCrosshairPosition(val, t as UTCTimestamp, s as any);
        } catch { /* chart removed mid-sync */ } finally { syncingRef.current = false; }
      };
      chart.subscribeCrosshairMove((param: any) => {
        if (syncingRef.current || !paneRef.current.has(cfg.id)) return; // teardown race
        syncingRef.current = true;
        try {
          const t = param?.time;
          if (t == null) { try { mainChart.clearCrosshairPosition(); } catch { /* noop */ } updateLegend(null); }
          else {
            const idx = timeIdxRef.current.get(t as number);
            const close = idx != null ? barsRef.current[idx]?.close : undefined;
            if (close != null) mainChart.setCrosshairPosition(close, t as UTCTimestamp, candleRef.current as any);
            updateLegend(t as number);
          }
          for (const other of paneRef.current.values()) {
            if (other.chart === chart) continue;
            other.crossHandler(param ?? {});
          }
        } catch { /* main chart removed mid-sync */ } finally { syncingRef.current = false; }
      });
      paneRef.current.set(cfg.id, { chart, container: host, series, syncHandler, crossHandler });
      if (barsRef.current.length) applyBarsToSeries("set");
      // panes follow the main range
      const r = mainChart.timeScale().getVisibleLogicalRange();
      if (r) { try { chart.timeScale().setVisibleLogicalRange(r); } catch { /* race */ } }
    }
    // exactly ONE time axis: the bottom-most pane when sub-panes are open,
    // otherwise the main chart (TradingView behaviour)
    const lastId = subList[subList.length - 1]?.id;
    for (const [id, pane] of paneRef.current) {
      pane.chart.applyOptions({ timeScale: { visible: id === lastId } });
    }
    chartRef.current?.applyOptions({ timeScale: { visible: subList.length === 0 } });
    return () => { /* cleanup handled by the unmount teardown + wanted-set diff */ };
  }, [subKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const paneHostRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // ---- markers from the fills ledger ------------------------------------------
  const applyMarkers = useCallback(() => {
    const candle = candleRef.current;
    if (!candle) return;
    const sym = symbolRef.current;
    const data = barsRef.current;
    if (!data.length) { candle.setMarkers([]); return; }
    const markers: SeriesMarker<Time>[] = [];
    for (const tr of tradesRef.current) {
      if (tr.symbol !== sym) continue;
      const idx = findBarIndex(data, tr.openedAt);
      if (idx == null) continue;
      markers.push({
        time: data[idx].time as UTCTimestamp,
        position: tr.side === "buy" ? "belowBar" : "aboveBar",
        color: tr.side === "buy" ? "#22c55e" : "#ef4444",
        shape: tr.side === "buy" ? "arrowUp" : "arrowDown",
        text: `${tr.side === "buy" ? "B" : "S"} ${tr.lots}`,
      });
      const exitIdx = findBarIndex(data, tr.closedAt);
      if (exitIdx != null && exitIdx !== idx) {
        markers.push({
          time: data[exitIdx].time as UTCTimestamp,
          position: tr.side === "buy" ? "aboveBar" : "belowBar",
          color: tr.pnl >= 0 ? "rgba(34,197,94,0.85)" : "rgba(239,68,68,0.85)",
          shape: "circle",
          text: `${tr.pnl >= 0 ? "+" : "−"}$${Math.abs(tr.pnl).toFixed(0)}`,
        });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candle.setMarkers(markers);
  }, []);

  useEffect(() => {
    if (!accountId) { tradesRef.current = []; applyMarkers(); return; }
    let disposed = false;
    const fetchTrades = () => {
      void tradingApi.getHistory(accountId, 200)
        .then((trades) => { if (!disposed) { tradesRef.current = trades; applyMarkers(); } })
        .catch(() => { /* transient — the interval retries */ });
    };
    fetchTrades();
    const timer = setInterval(fetchTrades, 30_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [accountId, applyMarkers]);
  useEffect(() => { applyMarkers(); }, [symbol, applyMarkers]);

  // ---- price scale mode: auto / log / percent (persisted) ----------------------
  useEffect(() => {
    try { localStorage.setItem("it_chart_scale", scaleMode); } catch { /* private mode */ }
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale("right").applyOptions({
      mode: scaleMode === "log" ? PriceScaleMode.Logarithmic : scaleMode === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
    });
  }, [scaleMode]);

  // ---- historical range shortcuts ---------------------------------------------
  const applyRange = useCallback((key: string) => {
    const ts = chartRef.current?.timeScale();
    const data = barsRef.current;
    if (!ts || !data.length) return;
    if (key === "all") { ts.fitContent(); ts.scrollToRealTime(); return; }
    const now = Math.floor(Date.now() / 1000);
    let cutoff: number;
    if (key === "ytd") {
      const d = new Date();
      cutoff = Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / 1000);
    } else {
      const days: Record<string, number> = { "1d": 1, "5d": 5, "1mo": 30, "3mo": 91, "6mo": 182, "1y": 365, "5y": 1825 };
      cutoff = now - (days[key] ?? 30) * 86400;
    }
    if (data[0].time > cutoff) { ts.fitContent(); ts.scrollToRealTime(); return; } // history doesn't reach that far — show everything we have
    let lo = 0;
    let hi = data.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].time >= cutoff) hi = mid; else lo = mid + 1; }
    ts.setVisibleLogicalRange({ from: Math.max(0, lo - 2), to: data.length + 5 });
  }, []);

  // ---- pending-order price lines (re-hung after every main-series swap) --------
  const [seriesEpoch, setSeriesEpoch] = useState(0);
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    for (const line of lineHandlesRef.current) {
      try { candle.removePriceLine(line); } catch { /* series gone */ }
    }
    lineHandlesRef.current = [];
    for (const m of safeMarks) {
      if (!Number.isFinite(m.price) || m.price <= 0) continue;
      lineHandlesRef.current.push(
        candle.createPriceLine({
          price: m.price,
          color: m.color,
          lineWidth: 1,
          lineStyle: m.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: m.title,
        }),
      );
    }
  }, [safeMarks, seriesEpoch]);

  // ---- trade lines (positions) ---------------------------------------------------
  const tradeLines = useMemo<TradeLine[]>(() => {
    const out: TradeLine[] = [];
    for (const p of safePositions) {
      const color = p.side === "buy" ? "#3b82f6" : "#f97316";
      out.push({ positionId: p.id, kind: "entry", price: p.entry, color, label: `${p.side === "buy" ? "BUY" : "SELL"} ${p.lots}`, digits });
      if (p.sl) out.push({ positionId: p.id, kind: "sl", price: p.sl, color: "#ef4444", label: "SL", digits });
      if (p.tp) out.push({ positionId: p.id, kind: "tp", price: p.tp, color: "#22c55e", label: "TP", digits });
    }
    return out;
  }, [safePositions, digits]);

  const handleTradeLineMove = useCallback((positionId: string, kind: TradeLine["kind"], price: number) => {
    if (kind === "entry") return;
    const patch = kind === "sl" ? { sl: price } : { tp: price };
    void onModifyRef.current(positionId, patch);
  }, []);

  // ---- drawings persistence -------------------------------------------------------
  useEffect(() => {
    if (!uid || !symbol) return;
    const offD = subscribeDrawings(uid, symbol, (list) => setDrawings(list));
    const offI = subscribeIndicators(uid, symbol, (list) => setIndicators(list));
    return () => { offD(); offI(); };
  }, [uid, symbol]);

  const commitDrawings = useCallback((next: Drawing[]) => {
    historyRef.current.push(drawingsRef.current);
    if (historyRef.current.length > 100) historyRef.current.shift();
    futureRef.current = [];
    setDrawings(next);
    drawingsRef.current = next;
    if (uid) saveDrawings(uid, symbolRef.current, next);
    setHistLens({ u: historyRef.current.length, r: futureRef.current.length });
  }, [uid]);

  const undoDrawings = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    futureRef.current.push(drawingsRef.current);
    setDrawings(prev);
    drawingsRef.current = prev;
    if (uid) saveDrawings(uid, symbolRef.current, prev);
    setHistLens({ u: historyRef.current.length, r: futureRef.current.length });
  }, [uid]);

  const redoDrawings = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(drawingsRef.current);
    setDrawings(next);
    drawingsRef.current = next;
    if (uid) saveDrawings(uid, symbolRef.current, next);
    setHistLens({ u: historyRef.current.length, r: futureRef.current.length });
  }, [uid]);

  const toggleDrawingHidden = useCallback((id: string) => {
    commitDrawings(drawingsRef.current.map((d) => (d.id === id ? { ...d, hidden: !d.hidden } : d)));
  }, [commitDrawings]);

  // ---- screenshot: the real rendered chart canvas → PNG download -------------
  const screenshot = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const canvas = chart.takeScreenshot();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `inspiretrade_${symbolRef.current}_${timeframeRef.current}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  }, []);

  const commitIndicators = useCallback((next: IndicatorConfig[]) => {
    setIndicators(next);
    if (uid) saveIndicators(uid, symbolRef.current, next);
  }, [uid]);

  // ---- legend + countdown ----------------------------------------------------------
  const updateLegend = useCallback((hoverTime: number | null) => {
    const el = legendRef.current;
    if (!el) return;
    const data = barsRef.current;
    if (!data.length) { el.innerHTML = ""; return; }
    const idx = hoverTime != null ? (timeIdxRef.current.get(hoverTime) ?? data.length - 1) : data.length - 1;
    const b = data[idx];
    const prev = data[Math.max(0, idx - 1)];
    const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : 0;
    const fmt = (v: number) => v.toFixed(priceFormatRef.current.precision);
    const cls = chg >= 0 ? "text-emerald-400" : "text-red-400";
    // TradingView-style: the exact bar under the crosshair, with its own timestamp
    const ts2 = new Date(b.time * 1000);
    const hh = (n: number) => String(n).padStart(2, "0");
    const stamp = `${hh(ts2.getUTCDate())} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][ts2.getUTCMonth()]} ${hh(ts2.getUTCHours())}:${hh(ts2.getUTCMinutes())}`;
    const instL2 = getInstrument(symbolRef.current);
    let html = `<span class="font-bold text-slate-200">${symbolRef.current}</span> <span class="text-slate-400">— ${instL2?.name ?? ""}</span> · ${timeframeRef.current.toUpperCase()} <span class="text-slate-500">O</span> <span class="font-number ${cls}">${fmt(b.open)}</span> <span class="text-slate-500">H</span> <span class="font-number ${cls}">${fmt(b.high)}</span> <span class="text-slate-500">L</span> <span class="font-number ${cls}">${fmt(b.low)}</span> <span class="text-slate-500">C</span> <span class="font-number ${cls}">${fmt(b.close)}</span> <span class="font-number ${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span> <span class="text-slate-500 font-number">${stamp}</span>`;
    if (b.volume) html += ` <span class="text-slate-500">Vol</span> <span class="font-number text-slate-400">${compactNum(b.volume)}</span>`;
    if (settingsRef.current.bidAsk && lastMidRef.current != null) {
      const instL = getInstrument(symbolRef.current);
      if (instL) {
        const spreadL = (SPREAD_PIPS[symbolRef.current] ?? 2) * instL.pipSize;
        html += ` <span class="text-red-400 font-number">BID ${(lastMidRef.current - spreadL / 2).toFixed(priceFormatRef.current.precision)}</span> <span class="text-emerald-400 font-number">ASK ${(lastMidRef.current + spreadL / 2).toFixed(priceFormatRef.current.precision)}</span>`;
      }
    }
    // indicator values at the hovered/last index
    for (const cfg of indicatorsRef.current) {
      const vals = indValuesRef.current.get(cfg.id);
      if (!vals || !cfg.visible) continue;
      const color = String(cfg.params.color || INDICATOR_CATALOG[cfg.type].colors[0] || COLORS.accent);
      for (const [key, arr] of vals) {
        if (cfg.type === "volume") continue;
        const v = arr[idx];
        if (v == null) continue;
        const short = key === "basis" ? "BB" : key === "upper" ? "BB↑" : key === "lower" ? "BB↓" : key.toUpperCase();
        html += ` <span style="color:${color}">${short} ${fmt(v)}</span>`;
      }
    }
    el.innerHTML = html;
  }, []);

  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;

  useEffect(() => {
    const timer = setInterval(() => {
      const el = countdownRef.current;
      if (!el) return;
      if (!settingsRef.current.countdown) { el.style.display = "none"; return; }
      const data = barsRef.current;
      const candle = candleRef.current;
      const chart = chartRef.current;
      if (!data.length || !candle || !chart) { el.style.display = "none"; return; }
      const last = data[data.length - 1];
      const remain = last.time + tfSecRef.current - Math.floor(Date.now() / 1000);
      if (remain <= 0) { el.style.display = "none"; return; }
      const h = Math.floor(remain / 3600);
      const m = Math.floor((remain % 3600) / 60);
      const s = remain % 60;
      const text = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
      const y = candle.priceToCoordinate(last.close);
      if (y == null) { el.style.display = "none"; return; }
      const scaleW = chart.priceScale("right").width();
      el.style.display = "block";
      el.style.top = `${Math.max(2, Math.min(el.parentElement!.clientHeight - 20, y - 9))}px`;
      el.style.right = `${scaleW + 4}px`;
      el.textContent = text;
      // last real data update stamp (badge) — imperative, no re-renders
      const tickEl = lastTickRef.current;
      if (tickEl) {
        const at = getConnectionState().lastTickAt;
        tickEl.textContent = at ? `· upd ${new Date(at).toLocaleTimeString([], { hour12: false })}` : "";
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // ---- keyboard tool shortcuts --------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — drawing undo & redo
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.preventDefault();
          if (e.shiftKey) redoDrawings(); else undoDrawings();
          return;
        }
        if (k === "y") { e.preventDefault(); redoDrawings(); return; }
      }
      if (e.key === "Escape") { setActiveTool("cursor"); return; }
      // Ctrl+C / Ctrl+V / Ctrl+D — copy · paste · duplicate drawings
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const ids = selectedIds.length ? selectedIds : (selectedDrawingId ? [selectedDrawingId] : []);
        const k = e.key.toLowerCase();
        if (k === "c" && ids.length) {
          copyRef.current = drawingsRef.current.filter((d) => ids.includes(d.id)).map((d) => JSON.parse(JSON.stringify(d)));
          return;
        }
        if (k === "v" && copyRef.current.length) {
          const dt = (TF_SECONDS[timeframe] || 3600) * 4;
          const pasted = copyRef.current.map((d) => ({ ...d, id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${d.id}`, locked: false, points: d.points.map((q) => ({ time: q.time + dt, price: q.price })) }));
          commitDrawings([...drawingsRef.current, ...pasted]);
          return;
        }
        if (k === "d" && ids.length) {
          const dt = (TF_SECONDS[timeframe] || 3600) * 4;
          const copies = drawingsRef.current.filter((d) => ids.includes(d.id)).map((d) => ({ ...d, id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${d.id}`, locked: false, points: d.points.map((q) => ({ time: q.time + dt, price: q.price })) }));
          commitDrawings([...drawingsRef.current, ...copies]);
          return;
        }
      }
      const map: Record<string, DrawingType> = { t: "trend", h: "hline", v: "vline", r: "rect", f: "fib-retracement", x: "text", p: "channel", e: "fib-extension", i: "extended", m: "measure" };
      const k = map[e.key.toLowerCase()];
      if (k) { setActiveTool(k); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoDrawings, redoDrawings, selectedIds, selectedDrawingId, timeframe, commitDrawings]);

  // ---- fullscreen ---------------------------------------------------------------------
  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => { /* denied — ignore */ });
  }, []);

  const resetView = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    ts.fitContent();
    ts.scrollToRealTime();
  }, []);

  // ---- context menu actions -------------------------------------------------------------
  const addHLineAt = useCallback((price: number) => {
    const d: Drawing = { id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, type: "hline", points: [{ time: 0, price }], style: { color: "#38bdf8", width: 1, dash: "solid", fontSize: 12 } };
    commitDrawings([...drawingsRef.current, d]);
    setSelectedDrawingId(d.id);
  }, [commitDrawings]);

  const addTextAt = useCallback((time: number, price: number) => {
    const d: Drawing = { id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, type: "text", points: [{ time, price }], style: { color: "#e2e8f0", width: 1, dash: "solid", fontSize: 12 }, text: "Note" };
    commitDrawings([...drawingsRef.current, d]);
    setSelectedDrawingId(d.id);
    setEditingDrawing(d);
  }, [commitDrawings]);

  const applyLayout = useCallback((snap: LayoutSnapshot) => {
    onSymbolChange(snap.symbol);
    onTimeframeChange(snap.timeframe as Timeframe);
    setIndicators(snap.indicators ?? []);
    if (uid) saveIndicators(uid, snap.symbol, snap.indicators ?? []);
    if (snap.settings) setSettings({ ...DEFAULT_SETTINGS, ...(snap.settings as unknown as Partial<ChartSettings>) });
  }, [onSymbolChange, onTimeframeChange, uid]);

  // honest connection badge: crypto reflects the REAL ws/rest state machine,
  // quotes feeds are labelled delayed with the provider source — never "LIVE"
  const isCryptoFeed = getInstrument(symbol)?.feed === "binance";
  const statusChip = loaded.status !== "error" && (() => {
    const c = conn.binance;
    let dot = "bg-emerald-400";
    let label = "LIVE";
    if (isCryptoFeed) {
      const provider = getInstrument(symbolRef.current)?.feedLabel || "Binance";
      if (c === "connected") { dot = "bg-emerald-400"; label = `Live · ${provider}`; }
      else if (c === "connecting") { dot = "bg-sky-400 animate-pulse"; label = "Connecting…"; }
      else if (c === "reconnecting") { dot = "bg-amber-400 animate-pulse"; label = "RECONNECTING…"; }
      else { dot = "bg-slate-500"; label = "OFFLINE"; }
    } else {
      dot = "bg-amber-400";
      label = loaded.message || "DELAYED";
    }
    return (
      <div className="absolute left-2 top-8 z-10 flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300 backdrop-blur">
        <span className={cn("inline-block h-2 w-2 rounded-full", dot)} />
        <span>{label}</span>
        <span ref={lastTickRef} className="font-number text-[10px] text-slate-500" title="Last real data update" />
      </div>
    );
  })();

  return (
    <div ref={wrapperRef} className={cn("relative flex h-full w-full min-h-0 flex-col bg-[#0b1220]", className)} style={height ? { height } : undefined}>
      <ChartToolbar
        symbol={symbol}
        indicators={indicators}
        onAddIndicator={(type) => commitIndicators([...indicatorsRef.current, newIndicatorConfig(type)])}
        onIndicatorToggle={(id) => commitIndicators(indicatorsRef.current.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)))}
        onIndicatorRemove={(id) => {
          commitIndicators(indicatorsRef.current.filter((i) => i.id !== id));
          // drop orphan series + pane immediately
          for (const [key, s] of [...overlayRef.current]) {
            if (key.startsWith(`${id}:`)) { try { chartRef.current?.removeSeries(s); } catch { /* gone */ } overlayRef.current.delete(key); }
          }
        }}
        onIndicatorConfigure={(id) => setEditingIndicator(indicatorsRef.current.find((i) => i.id === id) ?? null)}
        onOpenSettings={() => setOpenDialog("settings")}
        onOpenLayouts={() => setOpenDialog("layouts")}
        onOpenSearch={() => setOpenDialog("search")}
        onReset={resetView}
        onFullscreen={toggleFullscreen}
        onOpenAlerts={() => onOpenAlerts?.()}
        onOpenReplay={() => onOpenReplay?.()}
        chartType={chartType}
        onChartTypeChange={setChartTypeState}
        canUndo={histLens.u > 0}
        canRedo={histLens.r > 0}
        onUndo={undoDrawings}
        onRedo={redoDrawings}
        onScreenshot={screenshot}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <LeftRail
          activeTool={activeTool}
          onToolSelect={(t) => setActiveTool((cur) => (cur === t ? "cursor" : t))}
          magnet={settings.magnet}
          onMagnetToggle={() => setSettings((s) => ({ ...s, magnet: !s.magnet }))}
          locked={locked}
          onLockToggle={() => setLocked((v) => { try { localStorage.setItem("it_chart_lock", v ? "0" : "1"); } catch { /* private mode */ } return !v; })}
          hiddenAll={hiddenAll}
          onHideAllToggle={() => setHiddenAll((v) => { try { localStorage.setItem("it_chart_hideall", v ? "0" : "1"); } catch { /* private mode */ } return !v; })}
          drawingsCount={drawings.length}
          onDeleteAll={() => {
            if (!drawingsRef.current.length) return;
            if (!window.confirm(`Delete all ${drawingsRef.current.length} drawings on ${symbolRef.current}?`)) return;
            commitDrawings([]);
            setSelectedDrawingId(null);
            if (uid) clearDrawingsRemote(uid, symbolRef.current);
          }}
          objectsOpen={objectsOpen}
          onObjectsToggle={() => setObjectsOpen((v) => !v)}
          cursorMode={cursorMode}
          onCursorMode={setCursorMode}
        />
        <div ref={chartAreaRef} className="relative min-h-0 min-w-0 flex-1">
        {/* main pane */}
        <div ref={mainHostRef} className="absolute inset-x-0 top-0" style={{ bottom: subList.length * SUB_PANE_HEIGHT }} />
        {/* sub-panes */}
        {subList.map((cfg) => (
          <div
            key={cfg.id}
            ref={(el) => { if (el) paneHostRefs.current.set(cfg.id, el); else paneHostRefs.current.delete(cfg.id); }}
            className="absolute inset-x-0 border-t border-slate-800"
            style={{ height: SUB_PANE_HEIGHT, bottom: (subList.length - 1 - subList.indexOf(cfg)) * SUB_PANE_HEIGHT }}
          >
            <div className="pointer-events-none absolute left-2 top-1 z-10 text-[10px] font-semibold text-slate-400">{INDICATOR_CATALOG[cfg.type].label}</div>
          </div>
        ))}

        <DrawingCanvas
          ref={canvasRef}
          converterRef={converterRef}
          attachRef={chartAreaRef}
          drawings={drawings.filter((d) => isVisibleOnTf(d, timeframe))}
          onChange={(next) => {
            // the canvas sees only the TF-visible subset — merge back so
            // hidden-on-this-timeframe drawings are never lost
            const byId = new Map(next.map((d) => [d.id, d]));
            const kept = drawingsRef.current.map((d) => byId.get(d.id) ?? d);
            const added = next.filter((d) => !drawingsRef.current.some((x) => x.id === d.id));
            commitDrawings([...kept, ...added]);
          }}
          selectedIds={selectedIds}
          onSelectIds={(ids) => { setSelectedIds(ids); setSelectedDrawingId(ids[ids.length - 1] ?? null); }}
          onDeleteMany={(ids) => {
            const drop = new Set(ids);
            commitDrawings(drawingsRef.current.filter((d) => !drop.has(d.id)));
            setSelectedIds([]);
          }}
          activeTool={activeTool === "cursor" ? null : activeTool}
          onToolCommitted={() => { if (settingsRef.current.oneShot) setActiveTool("cursor"); }}
          toolDefaults={{
            color: settingsRef.current.drawColor,
            width: settingsRef.current.drawWidth,
            dash: settingsRef.current.drawDash,
            fontSize: settingsRef.current.drawFontSize,
          }}
          selectedId={selectedDrawingId}
          onSelect={setSelectedDrawingId}
          onDelete={(id) => commitDrawings(drawingsRef.current.filter((d) => d.id !== id))}
          onEdit={(id) => setEditingDrawing(drawingsRef.current.find((d) => d.id === id) ?? null)}
          onContextMenu={(clientX, clientY, hitId) => {
            const conv = converterRef.current;
            const el = mainHostRef.current;
            if (!conv || !el) return;
            const rect = el.getBoundingClientRect();
            const time = conv.time(clientX - rect.left);
            const price = conv.price(clientY - rect.top);
            const hitHidden = hitId ? (drawingsRef.current.find((d) => d.id === hitId)?.hidden ?? false) : false;
            setContextMenu({ clientX, clientY, x: clientX, y: clientY, hitDrawingId: hitId, hitHidden, time, price });
          }}
          tradeLines={tradeLines}
          onTradeLineMove={handleTradeLineMove}
          tfSeconds={TF_SECONDS[timeframe] ?? 0}
          digits={digits}
          locked={locked}
          hiddenAll={hiddenAll}
          getBars={() => barsRef.current}
          cursorFallback={cursorCss(cursorMode)}
        />

        {/* floating properties bar for the selected drawing */}
        {(() => {
          const sel = drawings.find((d) => d.id === selectedDrawingId);
          if (!sel || locked) return null;
          return (
            <DrawingPropsBar
              drawing={sel}
              onChange={(patch) => commitDrawings(drawingsRef.current.map((d) => (d.id === sel.id ? { ...d, ...patch } : d)))}
              onDuplicate={() => {
                const dt = (TF_SECONDS[timeframe] || 3600) * 4;
                const copy: Drawing = {
                  ...sel,
                  id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
                  points: sel.points.map((q) => ({ time: q.time + dt, price: q.price * 1.001 })),
                  locked: false,
                };
                commitDrawings([...drawingsRef.current, copy]);
                setSelectedDrawingId(copy.id);
              }}
              onDelete={() => { commitDrawings(drawingsRef.current.filter((d) => d.id !== sel.id)); setSelectedDrawingId(null); }}
              onEditText={() => {
                const text = window.prompt("Text", sel.text || "") ?? "";
                if (!text.trim()) return;
                commitDrawings(drawingsRef.current.map((d) => (d.id === sel.id ? { ...d, text: text.trim().slice(0, 200) } : d)));
              }}
            />
          );
        })()}

        {/* OHLC legend */}
        {settings.legend && (
          <div
            ref={legendRef}
            className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap gap-x-2 text-[11px] text-slate-300"
          />
        )}
        {/* countdown */}
        <div
          ref={countdownRef}
          className="pointer-events-none absolute z-10 rounded bg-slate-800/90 px-1.5 py-0.5 font-number text-[10px] text-sky-300"
          style={{ display: "none" }}
        />
        {statusChip}
        {/* Phase 10 — admin-only feed diagnostics (temporary debugging tool) */}
        {isAdmin && (
          <button
            onClick={() => setDiagOpen((v) => !v)}
            title="Feed diagnostics (admin)"
            className={cn(
              "absolute left-2 top-[4.4rem] z-10 flex h-6 w-6 items-center justify-center rounded border border-slate-700/60 bg-slate-900/80 backdrop-blur transition-colors",
              diagOpen ? "text-sky-300" : "text-slate-500 hover:text-slate-300",
            )}
          >
            <Activity className="h-3.5 w-3.5" />
          </button>
        )}
        {isAdmin && diagOpen && <FeedDiagnostics symbol={symbol} conn={conn.binance} getBars={() => barsRef.current} />}

        {/* object tree — drawings & indicators (real objects, real actions) */}
        {objectsOpen && (
          <div className="absolute right-10 top-8 z-30 w-60 rounded-lg border border-slate-700 bg-slate-900/95 p-2 text-[11px] shadow-2xl backdrop-blur">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Objects · {drawings.length}</p>
            <div className="max-h-40 overflow-y-auto">
              {drawings.length === 0 && <p className="py-1 text-slate-600">No drawings yet</p>}
              {/* drawing templates — save the current set, apply on any symbol */}
              <div className="mb-2 flex flex-wrap items-center gap-1 border-b border-slate-800 pb-2">
                <button
                  title="Save the current drawings as a reusable template"
                  disabled={!drawings.length || !uid}
                  onClick={async () => {
                    const name = window.prompt("Template name", `${symbolRef.current} set`)?.trim();
                    if (!name || !uid) return;
                    saveDrawingTemplate(uid, name, drawingsRef.current);
                    setTemplates(await loadDrawingTemplates(uid));
                  }}
                  className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                >
                  Save template
                </button>
                <select
                  title="Apply a saved template"
                  value=""
                  disabled={!templates.length}
                  onChange={async (e) => {
                    const tpl = templates.find((t) => t.name === e.target.value);
                    if (!tpl) return;
                    commitDrawings(tpl.drawings.map((d) => ({ ...d, id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${d.id}` })));
                    e.currentTarget.value = "";
                  }}
                  className="rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-[10px] text-slate-300 disabled:opacity-40"
                >
                  <option value="">Apply template…</option>
                  {templates.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.drawings.length})</option>)}
                </select>
                {templates.length > 0 && (
                  <button
                    title="Delete the selected template — choose via prompt"
                    onClick={async () => {
                      const name = window.prompt("Template to delete", templates[0]?.name || "")?.trim();
                      if (!name || !uid) return;
                      deleteDrawingTemplate(uid, name);
                      setTemplates(await loadDrawingTemplates(uid));
                    }}
                    className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                  >
                    Del
                  </button>
                )}
              </div>
              {drawings.map((d) => (
                <div key={d.id} className={cn("flex items-center gap-1 rounded px-1 py-0.5", selectedDrawingId === d.id && "bg-sky-500/15")}>
                  <button
                    className="min-w-0 flex-1 truncate text-left text-slate-300 hover:text-sky-300"
                    onClick={() => {
                      setSelectedDrawingId(d.id);
                      // navigate: scroll the time scale to the drawing's first anchor
                      const t0 = d.points[0]?.time;
                      if (t0) {
                        const data = barsRef.current;
                        let idx = timeIdxRef.current.get(t0);
                        if (idx == null && data.length) {
                          idx = data.findIndex((b) => b.time >= t0);
                          if (idx < 0) idx = data.length - 1;
                        }
                        if (idx != null && chartRef.current) {
                          try { chartRef.current.timeScale().setVisibleLogicalRange({ from: idx - 30, to: idx + 30 }); } catch { /* race */ }
                        }
                      }
                    }}
                    onDoubleClick={() => {
                      const name = window.prompt("Rename object", effectiveName(d));
                      if (name != null) commitDrawings(drawingsRef.current.map((x) => (x.id === d.id ? { ...x, name: name.trim().slice(0, 60) || undefined } : x)));
                    }}
                    title="Click to select + jump to position · double-click to rename"
                  >
                    {effectiveName(d)}
                    {d.hidden ? " (hidden)" : ""}
                    {d.tfs?.length ? <span className="ml-1 text-[9px] text-sky-400">{d.tfs.map((x) => x.toUpperCase()).join(",")}</span> : null}
                  </button>
                  <button title={d.hidden ? "Show" : "Hide"} onClick={() => toggleDrawingHidden(d.id)} className="text-slate-500 hover:text-slate-200">
                    {d.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                  <button
                    title="Delete"
                    disabled={locked}
                    onClick={() => commitDrawings(drawingsRef.current.filter((x) => x.id !== d.id))}
                    className="text-slate-500 hover:text-red-400 disabled:opacity-30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            <p className="mb-1 mt-2 border-t border-slate-800 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">Indicators · {indicators.length}</p>
            <div className="max-h-32 overflow-y-auto">
              {indicators.length === 0 && <p className="py-1 text-slate-600">No indicators</p>}
              {indicators.map((cfg) => (
                <div key={cfg.id} className="flex items-center gap-1 rounded px-1 py-0.5">
                  <button className="min-w-0 flex-1 truncate text-left text-slate-300 hover:text-sky-300" onClick={() => setEditingIndicator(cfg)}>
                    {INDICATOR_CATALOG[cfg.type].label}
                  </button>
                  <button title={cfg.visible ? "Hide" : "Show"} onClick={() => commitIndicators(indicatorsRef.current.map((i) => (i.id === cfg.id ? { ...i, visible: !i.visible } : i)))} className="text-slate-500 hover:text-slate-200">
                    {cfg.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  </button>
                  <button
                    title="Remove"
                    onClick={() => {
                      commitIndicators(indicatorsRef.current.filter((i) => i.id !== cfg.id));
                      for (const [key, s] of [...overlayRef.current]) {
                        if (key.startsWith(`${cfg.id}:`)) { try { chartRef.current?.removeSeries(s); } catch { /* gone */ } overlayRef.current.delete(key); }
                      }
                    }}
                    className="text-slate-500 hover:text-red-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {loaded.status === "error" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-slate-950/80 text-center">
            <p className="max-w-md text-sm text-slate-300">
              Market data unavailable{loaded.error ? `: ${loaded.error}` : ""}. No fake prices are ever shown — retry instead.
            </p>
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
            >
              Retry
            </button>
          </div>
        )}
        </div>
      </div>

      {/* bottom bar: historical range shortcuts + scale mode (TV-style) */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-t border-slate-800 bg-slate-900/80 px-2">
        {[["1d", "1D"], ["5d", "5D"], ["1mo", "1M"], ["3mo", "3M"], ["6mo", "6M"], ["ytd", "YTD"], ["1y", "1Y"], ["5y", "5Y"], ["all", "All"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => applyRange(key)}
            title={`Show last ${label === "All" ? "history" : label === "YTD" ? "year to date" : label} on the chart`}
            className="rounded px-2 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
            title="Jump to the latest candle"
            className="rounded px-2 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            ⇥ Now
          </button>
          <div className="mx-1 h-4 w-px bg-slate-800" />
          {[["normal", "Auto"], ["log", "Log"], ["percent", "%"]].map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setScaleMode(mode as "normal" | "log" | "percent")}
              title={mode === "log" ? "Logarithmic price scale" : mode === "percent" ? "Percent price scale" : "Automatic (linear) scale"}
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-semibold transition-colors",
                scaleMode === mode ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* dialogs + context menu */}
      <SettingsDialog open={openDialog === "settings"} settings={settings} onClose={() => setOpenDialog(null)} onSave={setSettings} />
      <SymbolSearchDialog
        open={openDialog === "search"}
        current={symbol}
        onClose={() => setOpenDialog(null)}
        onSelect={onSymbolChange}
      />
      {uid && (
        <LayoutsDialog
          open={openDialog === "layouts"}
          uid={uid}
          onClose={() => setOpenDialog(null)}
          onApply={applyLayout}
          currentSnapshot={{
            symbol, timeframe, indicators, settings: { ...settings } as Record<string, unknown>,
          }}
        />
      )}
      <IndicatorParamsDialog
        config={editingIndicator}
        onClose={() => setEditingIndicator(null)}
        onSave={(id, params) => commitIndicators(indicatorsRef.current.map((i) => (i.id === id ? { ...i, params } : i)))}
      />
      <DrawingPropsDialog
        drawing={editingDrawing}
        onClose={() => setEditingDrawing(null)}
        onSave={(id, patch) => commitDrawings(drawingsRef.current.map((d) => (d.id === id ? { ...d, ...patch } : d)))}
      />
      <ChartContextMenu
        state={contextMenu}
        onClose={() => setContextMenu(null)}
        actions={{
          addHLine: addHLineAt,
          addText: addTextAt,
          deleteDrawing: (id) => commitDrawings(drawingsRef.current.filter((d) => d.id !== id)),
          toggleHide: toggleDrawingHidden,
          clearDrawings: () => { commitDrawings([]); if (uid) clearDrawingsRemote(uid, symbolRef.current); },
          resetChart: resetView,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toCandle(b: Bar) {
  return { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close };
}

function toVolume(b: Bar) {
  const up = b.close >= b.open;
  return {
    time: b.time as UTCTimestamp,
    value: b.volume ?? 0,
    color: up ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
  };
}

function seriesToLineData(data: Bar[], values: Point[], asHistogram = false) {
  const out: any[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = values[i];
    if (v == null) continue;
    out.push(asHistogram
      ? { time: data[i].time as UTCTimestamp, value: v, color: v >= 0 ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)" }
      : { time: data[i].time as UTCTimestamp, value: v });
  }
  return out;
}

function findBarIndex(data: Bar[], ts: number): number | null {
  if (!data.length) return null;
  // binary search: last bar whose time <= ts
  let lo = 0;
  let hi = data.length - 1;
  if (ts < data[0].time) return 0;
  if (ts >= data[hi].time) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time === ts) return mid;
    if (data[mid].time < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, hi);
}

function timeToLogical(data: Bar[], tfSec: number, time: number): number | null {
  if (!data.length || !tfSec) return null;
  const idx = findBarIndex(data, time);
  if (idx == null) return null;
  return idx + (time - data[idx].time) / tfSec;
}

function logicalToTime(data: Bar[], tfSec: number, logical: number): number | null {
  if (!data.length || !tfSec) return null;
  const last = data.length - 1;
  if (logical < 0) return data[0].time + logical * tfSec;
  if (logical >= last) return data[last].time + (logical - last) * tfSec;
  const i = Math.round(logical);
  return data[i].time + (logical - i) * tfSec;
}

/**
 * Phase 10 — administrator-only feed diagnostics (temporary debugging tool).
 * Renders from an imperative 1s snapshot of the hot stats store, so it never
 * participates in the chart's render cycle.
 */
function FeedDiagnostics({ symbol, conn, getBars }: { symbol: string; conn: string; getBars: () => Bar[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString([], { hour12: false }) : "—");
    const timer = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const s = getFeedStats();
      const bars = getBars();
      const last = bars?.length ? bars[bars.length - 1] : null;
      const lastAge = last ? Math.max(0, Math.floor(Date.now() / 1000) - last.time) : null;
      const rows: [string, string][] = [
        ["Provider", getInstrument(symbol)?.feedLabel || (getInstrument(symbol)?.feed === "binance" ? "Binance WS+REST" : "Quotes proxy (Yahoo/stooq)")],
        ["Connection", conn],
        ["Last tick", `${fmt(s.lastTickAt)} (${s.tps10s} in 10s)`],
        ["Last chart update", fmt(s.lastChartUpdateAt)],
        ["Measured delay", s.delaySec != null ? `${s.delaySec}s` : "n/a (stream)"],
        ["Latest candle", last ? `O ${last.open} H ${last.high} L ${last.low} C ${last.close}` : "—"],
        ["Candle time (UTC)", last ? `${new Date(last.time * 1000).toISOString().slice(0, 19).replace("T", " ")} (${lastAge}s old)` : "—"],
        ["Invalid bars", String(s.invalidBars)],
        ["Repaired bars (H/L)", String(s.repairedBars)],
        ["Duplicate deliveries", String(s.duplicateBars)],
        ["Out-of-order ticks", String(s.outOfOrderTicks)],
      ];
      el.innerHTML = rows.map(([k, v]) => `<div class="flex justify-between gap-3 border-b border-slate-800/60 py-0.5"><span class="text-slate-500">${k}</span><span class="text-right font-number text-slate-200">${v}</span></div>`).join("");
    }, 1000);
    return () => clearInterval(timer);
  }, [symbol, conn, getBars]);
  return (
    <div className="absolute left-2 top-[6.6rem] z-30 w-72 rounded-lg border border-slate-700 bg-slate-900/95 p-2 text-[11px] shadow-2xl backdrop-blur">
      <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Feed diagnostics</p>
      <div ref={ref} />
    </div>
  );
}

function upsertLocal(bars: Bar[], bar: Bar): Bar[] {
  const last = bars.length ? bars[bars.length - 1] : null;
  if (last && bar.time === last.time) {
    bars[bars.length - 1] = bar;
    return bars;
  }
  if (!last || bar.time > last.time) { bars.push(bar); return bars; }
  const i = bars.findIndex((b) => b.time === bar.time);
  if (i >= 0) bars[i] = bar;
  return bars;
}

function compactNum(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
