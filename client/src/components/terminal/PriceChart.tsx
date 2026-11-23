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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode, LineStyle, PriceScaleMode,
  type IChartApi, type IPriceLine, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import {
  loadFeed, subscribeFeed, binanceProvider, getConnectionState, markChartUpdate,
  getSpotState, spotMeasuredUpdateSec,
  type FeedStatus,
} from "@/lib/market-data";
import { getInstrument, TF_SECONDS, type Bar, type Timeframe } from "@shared/terminal";
import { SPREAD_PIPS } from "@shared/trading-engine";
import { loadChartType, saveChartType, type ChartType } from "@/lib/chart-types";
import { useInstrumentSettings, getInstrumentSettings } from "@/lib/instrument-settings";
import { quotesHistOlder, quotesPrependHistory, quotesWhenDeep, quotesSnapshotBars } from "@/lib/market-data";
import { authedFetch } from "@/lib/api";
import { priceBusUpdate } from "@/lib/price-store";
import { tradingApi, type ServerPosition, ServerOrder, type ServerTrade } from "@/lib/trading-api";
import { useAuth } from "@/hooks/use-auth";
import {
  atr, bollinger, bollingerWidth, ema, macd as macdCalc, momentum, rsi as rsiCalc, sma,
  sourceSeries, stdev, stochastic, vwap as vwapCalc,
  wma, hma, supertrend, donchian, keltner, psar, ichimoku, adx, williamsR, cci, stochRsi,
  mfi, obv, trix, awesomeOscillator, roc,
  type Point,
} from "@/lib/indicators";
import {
  INDICATOR_CATALOG, newIndicatorConfig, withAlpha, type IndicatorConfig, type IndicatorType,
  sanitizeIndicatorList,
} from "@/lib/indicators-config";
import {
  reorderDrawing, effectiveName, isVisibleOnTf, __sanitizeDrawingList,
  mergeDrawingLists, stampChangedDrawings, newDrawingId, magnetSnapTime, type Drawing, type DrawingType, type DrawingRenderEnv } from "@/lib/drawings";
import { readFavoritesLocal, toggleFavorite, reorderFavorites } from "@/lib/drawing-favorites";
import { saveFavorites, subscribeFavorites } from "@/lib/chart-persistence";
import { saveDrawingDefaults, subscribeDrawingDefaults } from "@/lib/chart-persistence";
import { styleForTool, newDefaultFromStyle, type DrawingDefaultsMap } from "@/lib/drawing-defaults";
import { FavoritesToolbar } from "@/components/terminal/chart/FavoritesToolbar";
import { ObjectTree } from "@/components/terminal/chart/ObjectTree";
import { newGroupId, moveToGroup, groupFlag, groupMemberIds, dissolveGroup, type DrawingGroup } from "@/lib/drawing-tree";
import { subscribeGroups, saveGroups as persistGroups } from "@/lib/chart-persistence";
import {
  subscribeDrawings, saveDrawings, clearDrawings as clearDrawingsRemote,
  subscribeIndicators, saveIndicators, clearIndicators as clearIndicatorsRemote,
  type LayoutSnapshot, recordDrawingTombstones, flushPendingDrawingWrites } from "@/lib/chart-persistence";
import {
  DrawingCanvas, type ChartConverter, type DrawingCanvasHandle, type TradeLine,
} from "@/components/terminal/chart/DrawingCanvas";
import { ChartToolbar } from "@/components/terminal/chart/ChartToolbar";
import { InstrumentExplorer } from "@/components/terminal/InstrumentExplorer";
import { LeftRail } from "@/components/terminal/chart/LeftRail";
import { DrawingPropsBar } from "@/components/terminal/chart/DrawingPropsBar";
import { cursorCss, type CursorMode } from "@/components/terminal/chart/cursor-mode";
import { loadDrawingTemplates, saveDrawingTemplate, deleteDrawingTemplate, loadFibPresets, saveFibPreset, deleteFibPreset, type DrawingTemplate, type FibPreset } from "@/lib/chart-persistence";
import {
  ChartContextMenu, ChartSettings, DEFAULT_SETTINGS, DrawingPropsDialog, IndicatorLibraryDialog, IndicatorParamsDialog,
  LayoutsDialog, type ContextMenuState,
  magnetModeOf, applyGridDefaultOff,
} from "@/components/terminal/chart/dialogs";
import { TerminalSettingsDialog } from "@/components/terminal/TerminalSettingsDialog";
import { TradingAlertDialog } from "@/components/terminal/TradingAlertDialog";
import { loadSyncSettings, onSyncCrosshair, onSyncRange, publishCrosshair, publishRange, isApplyingSync, markApplyingSync } from "@/lib/chart-sync";
import { publishChartSnapshot } from "@/components/terminal/TradingAlertsEngine";
import { Eye, EyeOff, X, Lock, Unlock, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTrading } from "@/hooks/use-trading";
import { ChartTradeOverlay } from "@/components/terminal/chart/ChartTradeOverlay";

export interface PriceMark {
  id: string;
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

// ---- Phase 34: chart timezone (per-instrument, instrument settings panel) ----
// "" = viewer locale; bar timestamps stay UNIX UTC under the hood.
let tzCurrent = "";
const tzOpt = () => (tzCurrent || undefined) as (Intl.DateTimeFormatOptions["timeZone"]);
const fmtHM = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tzOpt() });
const fmtDM = (d: Date) => d.toLocaleDateString([], { day: "2-digit", month: "short", timeZone: tzOpt() });
const fmtMY = (d: Date) => d.toLocaleDateString([], { month: "short", year: "numeric", timeZone: tzOpt() });

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
type MainKind = "candle" | "hollow" | "line" | "area" | "bars" | "baseline" | "heikin";
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
  if (type === "bars") {
    // Phase 34: OHLC bars — native v4 series, genuine OHLC preserved
    return {
      kind: "bars",
      series: chart.addBarSeries({
        upColor: s.upColor, downColor: s.downColor, thinBars: false,
        priceLineVisible: true, lastValueVisible: true,
      }) as unknown as MainSeriesApi,
    };
  }
  if (type === "baseline") {
    // base value is re-anchored to the first loaded close in setMainData
    return {
      kind: "baseline",
      series: chart.addBaselineSeries({
        baseValue: { type: "price", price: 0 },
        topLineColor: s.upColor, topFillColor1: hexAlpha(s.upColor, 0.28), topFillColor2: hexAlpha(s.upColor, 0.05),
        bottomLineColor: s.downColor, bottomFillColor1: "rgba(0,0,0,0)", bottomFillColor2: hexAlpha(s.downColor, 0.22),
        lineWidth: 2, priceLineVisible: true, lastValueVisible: true,
      }) as unknown as MainSeriesApi,
    };
  }
  const hollow = type === "hollow";
  return {
    kind: type === "heikin" ? "heikin" : hollow ? "hollow" : "candle",
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

/** Theme the main series from user settings (per kind). P55 §7: the border
 *  and wick colors may be overridden independently (undefined = candle color). */
function applyMainTheme(series: MainSeriesApi, kind: MainKind, s: { upColor: string; downColor: string; borderColor?: string; wickColor?: string }): void {
  const bU = s.borderColor ?? s.upColor, bD = s.borderColor ?? s.downColor;
  const wU = s.wickColor ?? s.upColor, wD = s.wickColor ?? s.downColor;
  if (kind === "candle") {
    (series as ISeriesApi<"Candlestick">).applyOptions({
      upColor: s.upColor, downColor: s.downColor,
      borderUpColor: bU, borderDownColor: bD,
      wickUpColor: wU, wickDownColor: wD,
    });
  } else if (kind === "hollow") {
    (series as ISeriesApi<"Candlestick">).applyOptions({
      upColor: "rgba(0,0,0,0)",
      borderUpColor: bU, wickUpColor: wU,
      downColor: s.downColor, borderDownColor: bD, wickDownColor: wD,
    });
  } else if (kind === "line") {
    (series as ISeriesApi<"Line">).applyOptions({ color: s.upColor, lineWidth: 2 });
  } else if (kind === "area") {
    (series as ISeriesApi<"Area">).applyOptions({ lineColor: s.upColor, topColor: hexAlpha(s.upColor, 0.26), bottomColor: "rgba(0,0,0,0)", lineWidth: 2 });
  } else if (kind === "bars") {
    (series as unknown as ISeriesApi<"Bar">).applyOptions({ upColor: s.upColor, downColor: s.downColor } as any);
  } else if (kind === "baseline") {
    (series as unknown as ISeriesApi<"Baseline">).applyOptions({
      topLineColor: s.upColor, topFillColor1: hexAlpha(s.upColor, 0.28), topFillColor2: hexAlpha(s.upColor, 0.05),
      bottomLineColor: s.downColor, bottomFillColor1: "rgba(0,0,0,0)", bottomFillColor2: hexAlpha(s.downColor, 0.22),
    } as any);
  } else if (kind === "heikin") {
    (series as ISeriesApi<"Candlestick">).applyOptions({
      upColor: s.upColor, downColor: s.downColor,
      borderUpColor: bU, borderDownColor: bD,
      wickUpColor: wU, wickDownColor: wD,
    });
  }
}

/** Heikin-Ashi incremental state: HA of the bar BEFORE the last painted one,
 * the last painted HA, and its time — ticks repaint the last bar without
 * corrupting the recursive anchor. */
interface HaState { prev: { open: number; close: number }; last: { open: number; close: number } | null; lastTime: number }
/** Phase 59 P0 fix: ONE state PER chart instance. The old module-level
 * singleton was shared by every PriceChart panel — two Heikin-Ashi charts in
 * a multi-chart layout interleaved their live ticks through the SAME anchor,
 * fabricating HA bodies from the wrong instrument's prev open/close. */
type HaStateRef = { current: HaState | null };

function haBar(prev: { open: number; close: number } | null, b: Bar) {
  const close = (b.open + b.high + b.low + b.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
  return { time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) };
}

function setMainData(series: MainSeriesApi, kind: MainKind, data: Bar[], haState: HaStateRef): void {
  if (kind === "line" || kind === "area") {
    (series as ISeriesApi<"Line">).setData(data.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })));
  } else if (kind === "baseline") {
    // anchor the baseline to the first loaded close (else everything reads "below")
    const base = data.length ? data[0].close : 0;
    (series as unknown as ISeriesApi<"Baseline">).applyOptions({ baseValue: { type: "price", price: base } } as any);
    (series as unknown as ISeriesApi<"Baseline">).setData(data.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })));
  } else if (kind === "heikin") {
    // full recursive conversion; remember the tail for incremental live updates
    let prevHa: { open: number; close: number } | null = null;
    const out: any[] = [];
    for (const b of data) {
      const bar = haBar(prevHa, b);
      prevHa = { open: bar.open, close: bar.close };
      out.push(bar);
    }
    const n = out.length;
    const tail = n ? (out[n - 1] as { open: number; close: number; time: number }) : null;
    const beforeTail = n > 1 ? (out[n - 2] as { open: number; close: number }) : null;
    haState.current = tail
      ? { prev: beforeTail ?? { open: tail.open, close: tail.close }, last: { open: tail.open, close: tail.close }, lastTime: tail.time }
      : null;
    (series as ISeriesApi<"Candlestick">).setData(out.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
  } else {
    (series as ISeriesApi<"Candlestick" | "Bar">).setData(data.map(toCandle) as any);
  }
}

function updateMain(series: MainSeriesApi, kind: MainKind, b: Bar, haState: HaStateRef): void {
  if (kind === "line" || kind === "area") {
    (series as ISeriesApi<"Line">).update({ time: b.time as UTCTimestamp, value: b.close });
  } else if (kind === "baseline") {
    (series as unknown as ISeriesApi<"Baseline">).update({ time: b.time as UTCTimestamp, value: b.close });
  } else if (kind === "heikin") {
    const st = haState.current;
    if (!st) {
      const bar = haBar(null, b);
      haState.current = { prev: bar, last: { open: bar.open, close: bar.close }, lastTime: b.time };
      (series as ISeriesApi<"Candlestick">).update({ ...bar, time: bar.time as UTCTimestamp });
      return;
    }
    if (st.lastTime !== b.time) {
      // genuinely new bar: the previous painted HA becomes the anchor
      st.prev = st.last ? { open: st.last.open, close: st.last.close } : st.prev;
    }
    const bar = haBar(st.prev, b);
    st.last = { open: bar.open, close: bar.close };
    st.lastTime = b.time;
    (series as ISeriesApi<"Candlestick">).update({ ...bar, time: bar.time as UTCTimestamp });
  } else {
    (series as ISeriesApi<"Candlestick" | "Bar">).update(toCandle(b) as any);
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
  orders = [],
  onModifyPosition,
  onModifyOrder,
  onClosePosition,
  onCancelOrder,
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
  accountBalance = null,
  panelKey = null,
  chartType: chartTypeProp = null,
  onChartTypeChange = null,
}: {
  symbol: string;
  timeframe: Timeframe;
  /** pending-order price lines (positions render as draggable trade lines) */
  marks: PriceMark[];
  accountId: string | null;
  positions: ServerPosition[];
  /** P54 §3 — pending orders render as draggable lines with a details panel */
  orders?: ServerOrder[];
  onModifyPosition: (positionId: string, patch: { sl?: number | null; tp?: number | null; tsPct?: number }) => Promise<unknown>;
  onModifyOrder?: (orderId: string, patch: { price?: number; sl?: number | null; tp?: number | null }) => Promise<unknown>;
  onClosePosition?: (positionId: string, lots?: number) => Promise<unknown>;
  onCancelOrder?: (orderId: string) => Promise<unknown>;
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
  /** P41 — live account balance (live mode) for the position size calc */
  accountBalance?: number | null;
  /** P48 — unique panel id: enables cross-chart crosshair/time sync */
  panelKey?: string | null;
  /** P48 — controlled chart type (multi-chart panels); null = legacy global */
  chartType?: ChartType | null;
  /** P48 — controlled chart-type setter (multi-chart panels) */
  onChartTypeChange?: ((t: ChartType) => void) | null;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mainHostRef = useRef<HTMLDivElement | null>(null);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<MainSeriesApi | null>(null);
  const haStateRef = useRef<HaState | null>(null); // per-instance HA anchor (ref IS the HaStateRef)
  const mainKindRef = useRef<MainKind>("candle");
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // bid/ask price lines (engine-consistent spread around the mid)
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  // Phase 34: previous-day-close dotted line (per-instrument toggle)
  const pdcLineRef = useRef<IPriceLine | null>(null);
  const lastMidRef = useRef<number | null>(null);
  const overlayRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const paneRef = useRef<Map<string, PaneHandle>>(new Map());
  const lineHandlesRef = useRef<Map<string, { handle: IPriceLine }>>(new Map()); // Phase 59: keyed for diffed updates
  const barsRef = useRef<Bar[]>([]);
  const tfSecRef = useRef(300);
  const timeIdxRef = useRef<Map<number, number>>(new Map());
  const indValuesRef = useRef<Map<string, Map<string, Point[]>>>(new Map()); // indId → seriesKey → values
  /** Phase 36 §5 — compute cache keyed by a params+data signature */
  const indCacheRef = useRef(new Map<string, { sig: string; values: Map<string, Point[]> }>());
  const indTickRef = useRef(0);
  const indLenRef = useRef(0);
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
  // P48 — multi-chart panels control their type from the workspace state
  const controlledType = chartTypeProp != null;
  useEffect(() => {
    if (chartTypeProp != null && chartTypeProp !== chartTypeRef.current) setChartTypeState(chartTypeProp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTypeProp]);
  const setChartTypePanel = (t: ChartType) => {
    if (onChartTypeChange) onChartTypeChange(t); else setChartTypeState(t);
  };
  // TradingView object-state controls (persisted)
  const [locked, setLocked] = useState(() => { try { return localStorage.getItem("it_chart_lock") === "1"; } catch { return false; } });
  const [hiddenAll, setHiddenAll] = useState(() => { try { return localStorage.getItem("it_chart_hideall") === "1"; } catch { return false; } });
  const [scaleMode, setScaleMode] = useState<"normal" | "log" | "percent">(() => {
    try { const v = localStorage.getItem("it_chart_scale"); return v === "log" || v === "percent" ? v : "normal"; } catch { return "normal"; }
  });
  const lastTickRef = useRef<HTMLSpanElement | null>(null);
  const [objectsOpen, setObjectsOpen] = useState(false);
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
  // Phase 59: synchronous mirror — ObjectTree's "Select all"/"Clear selection"
  // loop onToggleSelect several times per tick; a render-closure read saw the
  // SAME stale array each time, so "select all" kept only the last row.
  const selectedIdsRef = useRef<string[]>([]);
  const setSelectedIdsSync = useCallback((next: string[]) => {
    selectedIdsRef.current = next;
    setSelectedIds(next);
    setSelectedDrawingId(next[next.length - 1] ?? null);
  }, []);
  const [olderLoading, setOlderLoading] = useState(false);
  const copyRef = useRef<Drawing[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [editingDrawing, setEditingDrawing] = useState<Drawing | null>(null);
  const [editingIndicator, setEditingIndicator] = useState<IndicatorConfig | null>(null);
  /** Phase 36 §7 — searchable indicator library */
  const [indicatorLibraryOpen, setIndicatorLibraryOpen] = useState(false);
  /** Phase 37 §5 — the user's custom Fibonacci presets (loaded once uid is known) */
  const [fibPresets, setFibPresets] = useState<FibPreset[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [openDialog, setOpenDialog] = useState<"settings" | "layouts" | "search" | null>(null);
  // P47 — trading alerts: context-menu prefilled price + the dialog state
  const [alertPriceDraft, setAlertPriceDraft] = useState<number | null>(null);
  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  // publish the live snapshot (bars + drawings) for the alert engine; a 1s
  // cadence keeps the bridge fresh without per-tick object churn
  useEffect(() => {
    const publish = () => publishChartSnapshot(symbolRef.current, timeframe, barsRef.current, drawingsRef.current, replayBarsRef.current != null);
    publish();
    const t = setInterval(publish, 1000);
    return () => clearInterval(t);
  }, [timeframe]);
  const [settings, setSettings] = useState<ChartSettings>(() => {
    try { return applyGridDefaultOff({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("it_chart_settings") || "{}") }); }
    catch { return DEFAULT_SETTINGS; }
  });
  // Phase 21 — per-instrument overrides (Terminal Settings → Instrument):
  // grid / bid-ask lines / candle colors live-merge over the global chart
  // settings; the `it_chart_settings` blob keeps the GLOBAL values only, so
  // XAUUSD customization never leaks into EURUSD.
  const perInstrument = useInstrumentSettings(symbol);
  const mergedSettings: ChartSettings = useMemo(() => ({
    ...settings,
    grid: perInstrument.grid ?? settings.grid,
    bidAsk: perInstrument.bidAsk ?? settings.bidAsk,
    upColor: perInstrument.upColor ?? settings.upColor,
    downColor: perInstrument.downColor ?? settings.downColor,
    // Phase 34 per-instrument overrides (instrument settings panel)
    precision: (perInstrument as { precision?: number }).precision,
    lastPrice: (perInstrument as { lastPrice?: boolean }).lastPrice,
    prevClose: (perInstrument as { prevClose?: boolean }).prevClose,
    priceScaleSide: (perInstrument as { priceScaleSide?: "right" | "left" }).priceScaleSide,
    timezone: (perInstrument as { timezone?: string }).timezone || "",
  }), [settings, perInstrument]);
  // an instrument's own default chart type applies when its chart opens
  // (the toolbar type button keeps setting the global default) — controlled
  // multi-chart panels own their type via the workspace instead
  useEffect(() => {
    if (controlledType) return;
    const per = getInstrumentSettings(symbol).chartType;
    if (per) setChartTypeState(per as ChartType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, controlledType]);
  // Phase 34: live type change from the instrument settings panel
  useEffect(() => {
    if (controlledType) return;
    const per = (perInstrument as { chartType?: ChartType } | undefined)?.chartType;
    if (per) setChartTypeState(per);
  }, [perInstrument, controlledType]);
  // Terminal Settings dialog edits the same store — pick up its changes live
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as Partial<ChartSettings> | undefined;
      if (d) setSettings((prev) => ({ ...prev, ...d }));
    };
    window.addEventListener("it_chart_settings_changed", h);
    return () => window.removeEventListener("it_chart_settings_changed", h);
  }, []);
  // scale + crosshair modes broadcast by Terminal Settings → Chart section
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { scaleMode?: "normal" | "log" | "percent"; cursorMode?: CursorMode } | undefined;
      if (d?.scaleMode) setScaleMode(d.scaleMode);
      if (d?.cursorMode) setCursorMode(d.cursorMode);
    };
    window.addEventListener("it_chart_aux_changed", h);
    return () => window.removeEventListener("it_chart_aux_changed", h);
  }, []);

  // ---- bid/ask price lines (server-consistent spread: SPREAD_PIPS × pipSize) --
  const updateBidAsk = useCallback((mid: number | null) => {
    const candle = candleRef.current;
    if (!candle) return;
    const s = settingsRef.current;
    const inst = getInstrument(symbolRef.current);
    // Phase 34: previous-day-close dotted line — anchored to the instrument's
    // OWN loaded daily history (never invented). Runs even when bid/ask is off.
    {
      const wantPdc = (s as { prevClose?: boolean }).prevClose === true;
      if (!wantPdc) {
        try { if (pdcLineRef.current) candle.removePriceLine(pdcLineRef.current); } catch { /* gone */ }
        pdcLineRef.current = null;
      } else {
        const todayStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
        const d1 = quotesSnapshotBars(symbolRef.current, "1d") || [];
        const prev = d1.filter((b) => b.time < todayStart).pop();
        if (prev && prev.close > 0) {
          if (pdcLineRef.current) pdcLineRef.current.applyOptions({ price: prev.close });
          else pdcLineRef.current = candle.createPriceLine({ price: prev.close, color: "rgba(148,163,184,0.75)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "PDC" });
        }
      }
    }
    // PHASE 61 §2 — real executable Bid/Ask when the server quote is fresh;
    // the local mid ± spread estimate remains the fallback (never misleading)
    const sq = serverQuoteRef.current;
    const sqFresh = !!sq && sq.live === true
      && Number.isFinite(sq.bid) && Number.isFinite(sq.ask) && sq.bid > 0 && sq.ask > sq.bid
      && Date.now() - (sq.time ?? 0) < 90_000;
    const haveMid = mid != null && Number.isFinite(mid) && mid > 0;
    if (!s.bidAsk || (!haveMid && !sqFresh) || !inst) {
      try { if (bidLineRef.current) candle.removePriceLine(bidLineRef.current); } catch { /* gone */ }
      try { if (askLineRef.current) candle.removePriceLine(askLineRef.current); } catch { /* gone */ }
      bidLineRef.current = null;
      askLineRef.current = null;
      return;
    }
    lastMidRef.current = mid;
    const midN = haveMid ? (mid as number) : sq!.mid;
    const spread = (SPREAD_PIPS[symbolRef.current] ?? 2) * inst.pipSize;
    const bid = sqFresh ? sq!.bid : midN - spread / 2;
    const ask = sqFresh ? sq!.ask : midN + spread / 2;
    const hang = (title: string, price: number, color: string, prev: IPriceLine | null): IPriceLine => {
      if (prev) { prev.applyOptions({ price, title }); return prev; }
      return candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title });
    };
    bidLineRef.current = hang("BID", bid, "rgba(239,68,68,0.8)", bidLineRef.current);
    askLineRef.current = hang("ASK", ask, "rgba(34,197,94,0.8)", askLineRef.current);
  }, []);

  const { user } = useAuth();
  const uid = user?.uid ?? null;
  // P60 fix — symbolRef/tfRef are read by the priceFormat useMemo BELOW, and
  // a useMemo factory executes during render: declaring the refs ~700 lines
  // down (Phase 59) raised "Cannot access 'symbolRef' before initialization"
  // on EVERY chart mount and killed the whole terminal. Declared first here.
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const tfRef = useRef(timeframe);
  tfRef.current = timeframe;
  // PHASE 61 §2 — genuine server Bid/Ask (shared trading store, module
  // singleton — no provider needed) for the bid/ask lines + quick overlay.
  // Stale >90s or non-live feeds fall back to the local spread estimate.
  const tradingAccount = useTrading().account;
  const serverQuote = tradingAccount?.quotes?.[symbol] ?? null;
  const serverQuoteRef = useRef(serverQuote);
  serverQuoteRef.current = serverQuote;
  // PHASE 61 §2 — the store's quotes refresh on a heartbeat; re-hang the
  // bid/ask lines whenever a fresh quote arrives (the tick pipeline keeps
  // updating them between heartbeats via the estimate fallback).
  useEffect(() => {
    if (serverQuote?.live === true && Number.isFinite(serverQuote.bid) && Number.isFinite(serverQuote.ask)) updateBidAsk(null);
  }, [serverQuote, updateBidAsk]);
  const inst = useMemo(() => getInstrument(symbol), [symbol]);
  const digits = inst?.digits ?? 2;
  // Phase 34: per-instrument decimal override (instrument settings panel)
  const precisionOverride = (perInstrument as { precision?: number } | undefined)?.precision;
  const effDigits = precisionOverride ?? digits;
  // P41 §1 — real instrument metadata + live balance for position drawings
  const renderEnv = useMemo<DrawingRenderEnv>(() => ({
    digits: effDigits,
    contractSize: inst?.contractSize,
    pipSize: inst?.pipSize,
    tickSize: inst?.tickSize, // P46 §1 — level rounding to the real tick
    balance: accountBalance ?? undefined,
    symbol,
  }), [effDigits, inst, accountBalance, symbol]);

  // ---- P41 §2 — per-user favorite drawing tools (LS mirror + RTDB) -------
  const [favTools, setFavTools] = useState<string[]>(() => readFavoritesLocal(uid ?? ""));
  useEffect(() => {
    setFavTools(readFavoritesLocal(uid ?? ""));
    if (!uid) return;
    return subscribeFavorites(uid, (list) => setFavTools(list));
  }, [uid]);
  const toggleFavTool = useCallback((id: string) => {
    setFavTools((prev) => {
      const next = toggleFavorite(prev, id);
      saveFavorites(uid ?? "", next);
      return next;
    });
  }, [uid]);
  const reorderFavTools = useCallback((from: number, to: number) => {
    setFavTools((prev) => {
      const next = reorderFavorites(prev, from, to);
      if (next !== prev) saveFavorites(uid ?? "", next);
      return next;
    });
  }, [uid]);

  // ---- P44 §5 — per-tool drawing style defaults (LS mirror + RTDB) -------
  const [toolDefaultMap, setToolDefaultMap] = useState<DrawingDefaultsMap>({});
  useEffect(() => {
    setToolDefaultMap({});
    if (!uid) return;
    return subscribeDrawingDefaults(uid, setToolDefaultMap);
  }, [uid]);
  // Phase 59: honor the instrument's real tick size — NAS100/SPX500 (digits 1,
  // tickSize 0.25) used to get axis/labels stepping in 0.1
  const priceFormat = useMemo(() => {
    const tick = getInstrument(symbolRef.current)?.tickSize;
    return { type: "price" as const, precision: effDigits, minMove: tick && tick > 0 ? tick : Math.pow(10, -effDigits) };
  }, [effDigits, symbol]);

  // Defensive normalization: a stale/hybrid deploy or an RTDB-shaped payload can
  // hand us non-array marks/positions — a broken iterable must never black-screen
  // the terminal, so degrade to "no lines" instead of crashing.
  const safeMarks = Array.isArray(marks) ? marks : [];
  const safePositions = Array.isArray(positions) ? positions : [];

  const settingsRef = useRef(mergedSettings);
  settingsRef.current = mergedSettings;
  const marksRef = useRef(safeMarks);
  marksRef.current = safeMarks;
  // Phase 59 PERF: coalesce drawing-canvas redraws to one per frame — the
  // tick path used to redraw synchronously up to twice per delivery while the
  // redraw itself scans the full bar array
  const redrawRafRef = useRef(0);
  const scheduleCanvasRedraw = useCallback(() => {
    if (redrawRafRef.current) return;
    redrawRafRef.current = requestAnimationFrame(() => {
      redrawRafRef.current = 0;
      canvasRef.current?.redraw();
    });
  }, []);
  const positionsRef = useRef(safePositions);
  positionsRef.current = safePositions;
  const onModifyOrderRef = useRef(onModifyOrder);
  onModifyOrderRef.current = onModifyOrder;
  // P54 §6 — one in-flight order action at a time: a double-click must never
  // submit the same modification twice; released shortly after the call ends
  const tradeBusyRef = useRef(false);
  const withTradeLock = useCallback(async (fn: () => Promise<unknown>) => {
    if (tradeBusyRef.current) return;
    tradeBusyRef.current = true;
    try { await fn(); } finally { setTimeout(() => { tradeBusyRef.current = false; }, 400); }
  }, []);
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
  // replay mode is a STRUCTURAL series source: entering/leaving it must
  // re-run the feed effect so the live subscription is torn down (a replay
  // chart that keeps its live subscription gets spoiler updates) and the
  // replay slice is painted exactly once
  const replayMode = replayBars != null;
  const replayModeRef = useRef(false);
  replayModeRef.current = replayMode;

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
    localStorage.setItem("it_chart_settings", JSON.stringify(settings)); // global blob — per-instrument overrides stay separate
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;
    chart.applyOptions({
      // Phase 34: appearance (background / grid / crosshair) now user-settable
      layout: { background: { type: ColorType.Solid, color: mergedSettings.bgColor ?? COLORS.bg }, textColor: mergedSettings.textColor ?? COLORS.text, fontSize: 11 },
      grid: mergedSettings.grid
        ? { vertLines: { color: mergedSettings.gridColor ?? COLORS.grid }, horzLines: { color: mergedSettings.gridColor ?? COLORS.grid } }
        : { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: {
        // LC's built-in Magnet mode snaps the horizontal line to the CLOSE
        // price only (library contract) — the user saw it "stick only to the
        // candle body". The crosshair mode stays Normal and the full-OHLC
        // magnet below (magnetCrosshair effect) does the real snapping.
        mode: CrosshairMode.Normal,
        vertLine: { visible: true, labelVisible: true, color: mergedSettings.crosshairColor ?? "rgba(224,229,237,0.35)", labelBackgroundColor: "#2a2e39" },
        horzLine: { visible: true, labelVisible: true, color: mergedSettings.crosshairColor ?? "rgba(224,229,237,0.35)", labelBackgroundColor: "#2a2e39" },
      },
    });
    candle.applyOptions({
      upColor: mergedSettings.upColor, downColor: mergedSettings.downColor,
      borderUpColor: mergedSettings.upColor, borderDownColor: mergedSettings.downColor,
      wickUpColor: mergedSettings.upColor, wickDownColor: mergedSettings.downColor,
    } as any);
    // every main-series kind gets its theme + last-price visibility override
    applyMainTheme(candle, mainKindRef.current, mergedSettings);
    const lp = mergedSettings.lastPrice ?? true;
    (candle as unknown as { applyOptions: (o: Record<string, unknown>) => void }).applyOptions({ priceLineVisible: lp, lastValueVisible: lp });
    canvasRef.current?.redraw();
  }, [settings, mergedSettings]);

  // ---- full-OHLC crosshair magnet (P46 §2.3 follow-up) ----------------------
  // LC's own Magnet mode only aligns the crosshair to the bar's CLOSE — the
  // user's "magnet sticks only to the body" report. This effect re-snaps the
  // crosshair to the NEAREST of open/high/low/close (wick tips included)
  // within the magnet threshold and glues the vertical line to the bar's
  // open time. Echo-safe: a synthetic position fires one more crosshairmove
  // whose snap result equals itself → no set, no loop. Mode Normal means the
  // raw mouse point is always the true cursor, never a pre-aligned close.
  const magnetModeRef = useRef<0 | 1 | 2>(0);
  magnetModeRef.current = magnetModeOf(mergedSettings);
  // P48 — this chart's sync identity inside multi-chart workspaces
  const panelKeyRef = useRef<string | null>(null);
  panelKeyRef.current = panelKey;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let lastSet: { p: number; t: number } | null = null;
    const onCross = (param: { point?: { x: number; y: number } | null; time?: unknown }) => {
      const mode = magnetModeRef.current;
      const s = candleRef.current;
      if (!mode || !param.point || !param.time || !s) { lastSet = null; return; }
      const rawPrice = s.coordinateToPrice(param.point.y);
      const rawTime = Number(param.time);
      if (rawPrice == null || !Number.isFinite(rawPrice) || !Number.isFinite(rawTime)) return;
      const tfSec = tfSecRef.current;
      // magnetSnapTime keeps weekly anchors on Monday 00:00 like the engine
      const t = tfSec > 0 ? magnetSnapTime(rawTime, tfSec) : rawTime;
      let snapped = rawPrice;
      let snappedT = t;
      // nearest OHLC of the bar under the cursor (and its immediate
      // neighbours) within the mode's px threshold — high/low included; when
      // a neighbour wins, the vertical line follows that bar (same contract
      // as the drawing-anchor magnet in drawings.ts magnetSnapNear)
      const bars = barsRef.current;
      const py = s.priceToCoordinate(rawPrice);
      if (py != null && bars.length) {
        const thr = mode === 2 ? 36 : 12;
        // binary search: exact bar or the insertion point (nearest pair is
        // covered by the near-1/near+1 scan below)
        let lo = 0, hi = bars.length - 1, near = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if ((bars[mid] as { time: number }).time === t) { near = mid; break; }
          if ((bars[mid] as { time: number }).time < t) lo = mid + 1; else hi = mid - 1;
        }
        if (near < 0) near = Math.max(0, Math.min(bars.length - 1, lo));
        let bestD = Infinity;
        for (const i of [near, near - 1, near + 1]) {
          const bar = i >= 0 ? (bars[i] as { time: number; open: number; high: number; low: number; close: number } | undefined) : undefined;
          if (!bar) continue;
          for (const c of [bar.open, bar.high, bar.low, bar.close]) {
            const cy = s.priceToCoordinate(c);
            if (cy == null) continue;
            const d = Math.abs(cy - py);
            if (d <= thr && d < bestD) { bestD = d; snapped = c as typeof snapped; snappedT = (bar as { time: number }).time; }
          }
        }
      }
      if (snapped === rawPrice && snappedT === rawTime) { lastSet = null; return; }
      if (lastSet && lastSet.p === snapped && lastSet.t === snappedT) return;
      lastSet = { p: snapped, t: snappedT };
      try { chart.setCrosshairPosition(snapped, snappedT as UTCTimestamp, s as never); } catch { /* teardown race */ }
    };
    chart.subscribeCrosshairMove(onCross as Parameters<typeof chart.subscribeCrosshairMove>[0]);
    return () => { try { chart.unsubscribeCrosshairMove(onCross as Parameters<typeof chart.unsubscribeCrosshairMove>[0]); } catch { /* already torn down */ } };
  }, []);



  // ---- Volume is a real indicator now (Phase 20) -----------------------------
  // The histogram is driven by a visible "volume" indicator config (Indicators
  // menu, persisted per user+symbol) — NOT by a hardcoded always-on series.
  // When it is hidden the candles reclaim the full pane height (no dead band).
  const volumeVisible = indicators.some((i) => i.type === "volume" && i.visible);
  const volumeVisibleRef = useRef(volumeVisible);
  volumeVisibleRef.current = volumeVisible;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.08, bottom: volumeVisible ? 0.26 : 0.08 },
    });
    const volume = volumeRef.current;
    if (volume) {
      // fill or clear the histogram — setData([]) renders nothing
      volume.setData(volumeVisible ? barsRef.current.map(toVolume) : []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeVisible]);

  // ---- chart type switch: rebuild the main series in place (no flicker) -------
  useEffect(() => {
    if (!controlledType) saveChartType(chartType); // panels keep their own type
    // eslint-disable-next-line react-hooks/exhaustive-deps
    void controlledType;
    const chart = chartRef.current;
    const old = candleRef.current;
    if (!chart || !old) return;
    const volume = volumeRef.current;
    try { if (volume) chart.removeSeries(volume); } catch { /* gone */ }
    try { chart.removeSeries(old); } catch { /* gone */ }
    // Phase 59: the removed series owned the bid/ask + PDC price lines —
    // LC keeps mutating the dead objects on applyOptions (no re-create), so
    // the lines vanished permanently until a symbol switch. Null the refs so
    // updateBidAsk re-creates them on the NEW series.
    bidLineRef.current = null;
    askLineRef.current = null;
    pdcLineRef.current = null;
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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      // Phase 16: the time axis and crosshair labels render in the VIEWER'S
      // timezone (TradingView behavior) — bar timestamps stay UNIX UTC under
      // the hood, only the presentation is local
      timeScale: {
        borderVisible: false, timeVisible: true, secondsVisible: TF_SECONDS[timeframe] < 60, visible: true, rightOffset: 8,
        tickMarkFormatter: (t: number, kind: number) => {
          const d = new Date(t * 1000);
          if (kind <= 1) return fmtMY(d);
          if (kind === 2) return fmtDM(d);
          return fmtHM(d);
        },
      },
      localization: {
        timeFormatter: (t: number) => fmtHM(new Date(t * 1000)),
      },
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
      // refs, NOT the mount-time props: this handler is attached once at chart
      // creation and must always act on the CURRENT instrument/timeframe
      const symNow = symbolRef.current;
      const tfNow = tfRef.current;
      const instNow = getInstrument(symNow);
      if (range.from < 60 && data.length && !olderLoadingRef.current && tfSecRef.current > 0 && instNow && !replayModeRef.current) {
        // REPLAY: never merge live-provider history into a replay session —
        // prepending candles older than the session start (and the live merge
        // callbacks below it) would paint the future the replay must hide
        // shared prepend: merge older bars, rebuild the series, keep the
        // viewport anchored — no chart jump, no full reload (§5)
        const prependOlder = (older: Bar[]) => {
          if (!older.length) return;
          // Phase 59: generation guard — a symbol/timeframe switch while the
          // fetch is in flight must NEVER paint the previous instrument's
          // candles onto the new chart (the chart instance deliberately
          // survives symbol switches, so an instance check alone can't help)
          if (symbolRef.current !== symNow || tfRef.current !== tfNow) return;
          const map = new Map<number, Bar>();
          for (const b of older) map.set(b.time, b);
          for (const b of data) map.set(b.time, b);
          barsRef.current = [...map.values()].sort((a, b) => a.time - b.time);
          // Phase 24 D3: persist the extension at the PROVIDER level — the
          // next live delivery must carry the same extended series, or the
          // freshly loaded history is wiped 1-2s later and every scroll
          // re-fetches in a loop
          if (instNow.feed === "binance") binanceProvider.prependHistory(symNow, tfNow, older);
          else quotesPrependHistory(symNow, tfNow, older);
          // preserve the user's zoom: shift the logical window right by the
          // number of prepended bars (the old full-series setVisibleRange
          // zoomed the viewport out 10-20x on EVERY prepend)
          let saved: { from: number; to: number } | null = null;
          try { saved = ts.getVisibleLogicalRange() as { from: number; to: number }; } catch { /* fresh chart */ }
          applyBarsToSeries("set");
          if (saved) {
            const added = barsRef.current.length - data.length;
            if (added > 0) {
              try { ts.setVisibleLogicalRange({ from: saved.from + added, to: saved.to + added }); } catch { /* race — ignore */ }
            }
          }
        };
        olderLoadingRef.current = true;
        setOlderLoading(true);
        const oldest = data[0].time;
        const job = instNow.feed === "binance"
          ? binanceProvider.loadOlder(symNow, tfNow, oldest, 1000)      // native kline pagination
          : quotesHistOlder(symNow, tfNow, oldest, 3000);               // Phase 23 day-shard store (stooq/Dukascopy/TD)
        job
          .then(prependOlder)
          .catch(() => { /* transient — the next scroll tries again */ })
          .finally(() => { olderLoadingRef.current = false; setOlderLoading(false); });
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    // crosshair → legend + sub-panes (+ P48 cross-chart sync publish)
    const onCross = (param: any) => {
      if (chartRef.current !== chart) return; // teardown race — chart already removed
      updateLegend(param?.time ?? null);
      if (panelKeyRef.current && !isApplyingSync()) {
        publishCrosshair({ key: panelKeyRef.current, time: param?.time != null ? Number(param.time) : null, at: Date.now() });
      }
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        for (const pane of paneRef.current.values()) pane.crossHandler(param ?? {});
      } finally { syncingRef.current = false; }
      canvasRef.current?.redraw();
    };
    chart.subscribeCrosshairMove(onCross as any);

    const ro = new ResizeObserver(() => { canvasRef.current?.redraw(); });
    // Phase 59: a pending rAF must not fire into a torn-down chart
    ro.observe(el);
    return () => {
      // order matters: kill every handle that could touch the chart AFTER remove()
      converterRef.current = null;
      if (redrawRafRef.current) { cancelAnimationFrame(redrawRafRef.current); redrawRafRef.current = 0; }
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
      lineHandlesRef.current = new Map();
    };
    // symbol/timeframe are handled by the feed effect — the chart instance persists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- P48 Part 3 — cross-chart synchronization (crosshair + time range) ----
  // Only participates when a panelKey is provided (multi-chart workspace).
  // Loop guards: inbound applications set a 60ms applying window so a synced
  // range/crosshair cannot bounce back across the bus forever.
  useEffect(() => {
    if (!panelKey) return;
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = (r: { from: number; to: number } | null) => {
      if (!r || isApplyingSync()) return;
      // Phase 59: publish the visible TIME range (epoch seconds) — the old
      // logical-index range made a 5m panel scroll a 1h panel to a completely
      // different time window
      try {
        const vr = chart.timeScale().getVisibleRange();
        if (!vr) return;
        publishRange({ key: panelKey, from: Number(vr.from), to: Number(vr.to), at: Date.now() });
      } catch { /* no data yet */ }
    };
    const unsubRange = chart.timeScale().subscribeVisibleLogicalRangeChange(onRange as never);
    const offRange = onSyncRange((e) => {
      if (e.key === panelKey || !loadSyncSettings().time || isApplyingSync()) return;
      markApplyingSync();
      try { chart.timeScale().setVisibleRange({ from: e.from as UTCTimestamp, to: e.to as UTCTimestamp }); } catch { /* race */ }
    });
    const offCross = onSyncCrosshair((e) => {
      if (e.key === panelKey || !loadSyncSettings().crosshair) return;
      const s = candleRef.current;
      if (!s) return;
      try {
        if (e.time == null) { chart.clearCrosshairPosition(); return; }
        const t = Number(e.time);
        // Phase 59: snap to the NEAREST bar — a crosshair published from a 5m
        // panel almost never lands exactly on a 1h bar's open time, so the
        // exact-map lookup dropped the crosshair silently on cross-TF grids
        const idx = timeIdxRef.current.get(t) ?? findBarIndex(barsRef.current, t);
        const close = idx != null ? barsRef.current[idx]?.close : undefined;
        if (close != null) chart.setCrosshairPosition(close, t as UTCTimestamp, s as never);
        // route through the sub-panes too — they only followed LOCAL hovers
        for (const [cfgId, pane] of paneRef.current.entries()) {
          const vals = indValuesRef.current.get(cfgId);
          const series = pane.series.find((x) => x);
          if (!vals || !series) continue;
          const arr = vals.values().next().value;
          const v = idx != null && arr && idx < (arr as any[]).length ? (arr as any[])[idx] : null;
          if (v != null) {
            try { pane.chart.setCrosshairPosition(v as number, t as UTCTimestamp, series as never); } catch { /* pane race */ }
          }
        }
      } catch { /* teardown race */ }
    });
    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange as never); } catch { /* gone */ }
      offRange();
      offCross();
    };
  }, [panelKey]);

  // Phase 23 BUG-2 → refined by Phase 24 feedback: the site theme styles the
  // terminal CHROME (panels, toolbars, dialogs — index.css [data-term] token
  // overrides) but the CHART CANVAS STAYS DARK. A professional chart surface
  // must not change contrast semantics mid-session; candles, wicks and the
  // price axis keep their tuned colors on #0b1220. The root carries
  // data-chart-dark so the CSS theme overrides explicitly skip it.

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
      case "sma": out.set("sma", sma(sourceSeries(bars, String(cfg.params.source || "close")), p("period"))); break;
      case "ema": out.set("ema", ema(sourceSeries(bars, String(cfg.params.source || "close")), p("period"))); break;
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
      // ---- Phase 27: the TradingView-standard set --------------------------
      case "wma": out.set("wma", wma(sourceSeries(bars, String(cfg.params.source || "close")), p("period"))); break;
      case "hma": out.set("hma", hma(closes, p("period"))); break;
      case "supertrend": {
        const r = supertrend(bars, p("period"), p("mult"));
        out.set("up", r.up); out.set("down", r.down);
        break;
      }
      case "donchian": {
        const r = donchian(bars, p("period"));
        out.set("upper", r.upper); out.set("basis", r.basis); out.set("lower", r.lower);
        break;
      }
      case "keltner": {
        const r = keltner(bars, p("period"), p("mult"));
        out.set("basis", r.basis); out.set("upper", r.upper); out.set("lower", r.lower);
        break;
      }
      case "psar": out.set("sar", psar(bars, p("step"), p("max"))); break;
      case "ichimoku": {
        const r = ichimoku(bars, p("conv"), p("base"), p("span"));
        out.set("tenkan", r.tenkan); out.set("kijun", r.kijun); out.set("spanA", r.spanA); out.set("spanB", r.spanB);
        break;
      }
      case "adx": {
        const r = adx(bars, p("period"));
        out.set("adx", r.adx); out.set("plusDI", r.plusDI); out.set("minusDI", r.minusDI);
        break;
      }
      case "willr": out.set("willr", williamsR(bars, p("period"))); break;
      case "cci": out.set("cci", cci(bars, p("period"))); break;
      case "stochrsi": {
        const r = stochRsi(closes, p("rsiPeriod"), p("stochPeriod"), p("kSmooth"), p("dSmooth"));
        out.set("k", r.k); out.set("d", r.d);
        break;
      }
      case "mfi": out.set("mfi", mfi(bars, p("period"))); break;
      case "obv": out.set("obv", obv(bars)); break;
      case "trix": out.set("trix", trix(closes, p("period"))); break;
      case "ao": out.set("ao", awesomeOscillator(bars, p("fast"), p("slow"))); break;
      case "roc": out.set("roc", roc(closes, p("period"))); break;
      // ---- Phase 36 additions ------------------------------------------------
      case "momentum": out.set("momentum", momentum(sourceSeries(bars, String(cfg.params.source || "close")), p("period"))); break;
      case "bbw": out.set("bbw", bollingerWidth(closes, p("period"), p("mult"))); break;
      case "stddev": out.set("stddev", stdev(sourceSeries(bars, String(cfg.params.source || "close")), p("period"))); break;
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
      setMainData(candle, mainKindRef.current, data, haStateRef);
      // volume histogram = the visible "volume" indicator only (Phase 20)
      volume.setData(volumeVisibleRef.current ? data.map(toVolume) : []);
      // rebuild the time→index map (indicators + crosshair lookups)
      const idx = new Map<number, number>();
      for (let i = 0; i < data.length; i++) idx.set(data[i].time, i);
      timeIdxRef.current = idx;
    } else {
      const last = data[data.length - 1];
      updateMain(candle, mainKindRef.current, last, haStateRef);
      if (volumeVisibleRef.current) volume.update(toVolume(last));
    }

    // indicators: overlays on the main series + sub-pane series.
    // Phase 36 §5 — compute cache: values are keyed by a params+data
    // signature so unchanged indicators never recompute, and same-bar tick
    // revisions recompute at most 2 Hz (new bars and config changes stay
    // immediate). Replaces the per-tick full O(n) recompute of every series.
    const now = Date.now();
    const fresh = mode === "set" || data.length !== indLenRef.current || now - indTickRef.current >= 500;
    if (fresh) indTickRef.current = now;
    const prevLen = indLenRef.current; // capture BEFORE overwrite (append detection)
    indLenRef.current = data.length;
    const wantedIds = new Set<string>();
    const wantedOverlayKeys = new Set<string>();
    for (const cfg of indicatorsRef.current) {
      if (!cfg.visible) continue;
      wantedIds.add(cfg.id);
      const lastBar = data[data.length - 1];
      // Phase 59: high/low in the signature — H/L-based indicators (ATR,
      // Stochastic, Donchian, PSAR, Ichimoku…) froze intra-bar when the
      // spike reverted to the same close
      const sig = `${JSON.stringify(cfg.params)}|${data.length}|${data[0]?.time}|${lastBar?.time}|${lastBar?.close}|${lastBar?.high}|${lastBar?.low}`;
      const cached = indCacheRef.current.get(cfg.id);
      let values: Map<string, Point[]>;
      if (cached && (cached.sig === sig || !fresh)) {
        values = cached.values;
      } else {
        values = computeIndicator(cfg, data);
        indCacheRef.current.set(cfg.id, { sig, values });
      }
      indValuesRef.current.set(cfg.id, values);
      const color = String(cfg.params.color || INDICATOR_CATALOG[cfg.type].colors[0] || COLORS.accent);
      if (INDICATOR_CATALOG[cfg.type].pane === "main" && cfg.type !== "volume") {
        const metaC = INDICATOR_CATALOG[cfg.type];
        const seriesMap = overlayRef.current;
        const keys = [...values.keys()];
        // ensure series exist for each key — Phase 27: per-key colors/styles
        // (SuperTrend up/down, Ichimoku lines, dotted PSAR, band midpoints)
        for (const key of keys) {
          const id = `${cfg.id}:${key}`;
          if (!seriesMap.has(id)) {
            const style = metaC.keyStyle?.[key];
            const st = cfg.style;
            const s = chartRef.current!.addLineSeries({
              color: withAlpha(metaC.keyColors?.[key] || color, st?.opacity),
              lineWidth: (st?.width ? Math.min(4, Math.max(1, Math.round(st.width))) : style?.lineWidth ?? 1) as 1 | 2 | 3 | 4,
              lineStyle: (st?.dash === "dashed" ? LineStyle.Dashed : st?.dash === "dotted" ? LineStyle.Dotted : style?.lineStyle ?? LineStyle.Solid) as LineStyle,
              priceLineVisible: false,
              lastValueVisible: key !== "upper" && key !== "lower",
              crosshairMarkerVisible: false,
            });
            seriesMap.set(id, s);
          }
        }
        for (const key of keys) wantedOverlayKeys.add(`${cfg.id}:${key}`);
        for (const [key, arr] of values) {
          const s = seriesMap.get(`${cfg.id}:${key}`);
          if (!s) continue;
          if (mode === "set") s.setData(seriesToLineData(data, arr));
          else if (arr.length && arr[arr.length - 1] != null) {
            // Phase 59 PERF: build ONLY the point(s) being pushed — the old
            // path rebuilt the full O(n) point array per series key per tick
            // (Ichimoku = 5 keys × 20k bars ≈ 100k allocations/second/panel)
            const mk = (i: number) => ({ time: data[i].time as UTCTimestamp, value: arr[i] });
            // a delivery that APPENDED a bar may also revise the previous
            // last bar's OHLC — its indicator point moved too (the recompute
            // above already knows it; only the apply skipped it)
            const grew = data.length > prevLen;
            if (grew && arr.length >= 2 && arr[arr.length - 2] != null) {
              try { s.update(mk(arr.length - 2) as any); } catch { /* ordering race — next full pass heals */ }
            }
            s.update(mk(arr.length - 1) as any);
          }
        }
      }
      const pane = paneRef.current.get(cfg.id);
      if (pane) {
        for (const [key, arr] of values) {
          const s = pane.series.find((x) => x && (x as any).__key === key);
          if (!s) continue;
          // live per-instance style (Phase 36 §2) — line series only; the
          // histogram panes (MACD hist, AO) carry no __color and are skipped
          const st = cfg.style;
          if (st && (s as any).__color) {
            try {
              s.applyOptions({
                ...(st.width ? { lineWidth: Math.min(4, Math.max(1, Math.round(st.width))) } : {}),
                ...(st.dash ? { lineStyle: st.dash === "dashed" ? LineStyle.Dashed : st.dash === "dotted" ? LineStyle.Dotted : LineStyle.Solid } : {}),
                ...(st.opacity != null ? { color: withAlpha(String((s as any).__color), st.opacity) } : {}),
              } as any);
            } catch { /* style race — next pass fixes it */ }
          }
          if (mode === "set") s.setData(seriesToLineData(data, arr, key === "hist"));
          else if (arr.length && arr[arr.length - 1] != null) {
            // Phase 59 PERF: same O(1) per-tick point build as the overlays
            const asHist = key === "hist";
            const mk = (i: number) => ({ time: data[i].time as UTCTimestamp, value: arr[i], ...(asHist ? { color: (arr[i] as number) >= 0 ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)" } : {}) });
            const grew = data.length > prevLen;
            if (grew && arr.length >= 2 && arr[arr.length - 2] != null) {
              try { s.update(mk(arr.length - 2) as any); } catch { /* ordering race — next full pass heals */ }
            }
            s.update(mk(arr.length - 1) as any);
          }
        }
      }
    }
    // Phase 59: remove orphaned overlay series — Hide (visible:false) used to
    // leave SMA/EMA/BB/PSAR lines drawn on the chart with only the legend
    // entry gone (sub-panes were destroyed correctly; overlays were not)
    for (const [key, orphan] of [...overlayRef.current]) {
      if (!wantedOverlayKeys.has(key)) {
        try { chartRef.current?.removeSeries(orphan); } catch { /* already gone */ }
        overlayRef.current.delete(key);
      }
    }
    for (const k of [...indCacheRef.current.keys()]) if (!wantedIds.has(k)) indCacheRef.current.delete(k);
  }, [computeIndicator]);

  /** Phase 36 §1 — volume honesty: crypto carries real exchange base volume;
   *  forex/metals/indices feeds only give tick or sample-count volume. */
  const volumeNote = useMemo(
    () => /(USDT|USDC|BUSD|FDUSD|TUSD|DAI)$/i.test(symbol)
      ? undefined
      : "Forex / metals / indices feeds provide tick or sample-count volume — volume-based readings are an activity proxy, not exchange-traded size.",
    [symbol],
  );

  const priceFormatRef = useRef(priceFormat);
  priceFormatRef.current = priceFormat;
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  // symbolRef / tfRef are declared at the TOP of this component (P60 TDZ fix)

  // ---- feed load + live subscribe ---------------------------------------------
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    setLoaded({ status: "connecting" });
    tfSecRef.current = TF_SECONDS[timeframe];
    barsRef.current = [];
    // blank the rendered series IMMEDIATELY: the chart instance persists
    // across switches, so the previous symbol's candles otherwise stay visible
    // under the new title (and keep shining through the error overlay when
    // the new feed fails to load)
    try {
      candleRef.current?.setData([]);
      volumeRef.current?.setData([]);
      candleRef.current?.setMarkers([]);
    } catch { /* series not created yet (first mount) */ }
    // instrument switch: the previous symbol's mid must NEVER leak into the
    // new instrument's bid/ask lines or the price bus (§3 identity guard)
    lastMidRef.current = null;
    updateBidAsk(null);
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
      scheduleCanvasRedraw();
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
        scheduleCanvasRedraw();
        // Phase 19: open on a readable default window (~130 bars) instead of
        // the previous zoom state — the chart instance persists across
        // instrument/timeframe switches, so a zoomed-out M1 view carried over
        // and made the new instrument's candles nearly invisible. The user's
        // zoom is preserved from here on (live updates never touch it).
        // Phase 20: the PRICE scale resets too — dragging the price axis once
        // disables autoScale and that persisted across symbol switches, so
        // XAUUSD opened on EURUSD's ~1.09 axis (invisible until the user
        // zoomed around and "found" 3800). Re-enabling autoScale re-fits the
        // new instrument's data to its own price.
        try {
          const chart = chartRef.current;
          const ts = chart?.timeScale();
          if (chart) {
            chart.priceScale("right").applyOptions({
              autoScale: true,
              scaleMargins: { top: 0.08, bottom: volumeVisibleRef.current ? 0.26 : 0.08 },
            });
          }
          if (ts && bars.length) {
            ts.setVisibleLogicalRange({ from: Math.max(0, bars.length - 130), to: bars.length + 8 });
          }
        } catch { /* race — fallback scroll */ }
        setLoaded({ status, message });

        // Phase 33: FIRST-VISIT FULL HISTORY — the deep layers (hist shards ∪
        // store fold ∪ stooq archive) merge in the background. On a cold first
        // visit that merge could land before the subscription attached (or its
        // repaint was swallowed on a weekend with no live ticks), leaving the
        // short fast window on screen — the "switch tf away and back"
        // workaround. Await the merge and repaint once; idempotent when the
        // provider has no pending deep load (crypto / replay paths).
        void (async () => {
          try { await quotesWhenDeep(symbol, timeframe); } catch { return; }
          if (disposed) return;
          const prevDeepLenRef = { current: barsRef.current.length };
          const deep = quotesSnapshotBars(symbol, timeframe);
          if (!deep || !deep.length || deep.length <= barsRef.current.length) return;
          // keep the viewport the user is already looking at — the old forced
          // 130-bar reset yanked the chart while they were scrolling/zooming
          let savedRange: { from: number; to: number } | null = null;
          try { savedRange = chartRef.current?.timeScale().getVisibleLogicalRange() as { from: number; to: number } ?? null; } catch { /* fresh */ }
          barsRef.current = deep;
          applyBarsToSeries("set");
          applyMarkers();
          updateLegend(null);
          updateBidAsk(deep[deep.length - 1].close);
          scheduleCanvasRedraw();
          if (savedRange) {
            try {
              // the deep merge only PREPENDS older bars → shift the saved
              // window right by the added count so the view stays put
              const delta = deep.length - prevDeepLenRef.current;
              if (delta > 0) chartRef.current?.timeScale().setVisibleLogicalRange({ from: savedRange.from + delta, to: savedRange.to + delta });
              else chartRef.current?.timeScale().setVisibleLogicalRange(savedRange);
            } catch { /* keep the current viewport */ }
          }
        })();

        unsub = subscribeFeed(symbol, timeframe, ({ bars, lastBar }) => {
          const prev = barsRef.current;
          // PURE APPEND (new minute/tail fills ≤6 bars, nothing prepended or
          // replaced) → cheap series.update() per new bar: the user's zoom,
          // scroll position and autoscale window are untouched, and we skip
          // re-rendering thousands of candles every minute (§5/§8). The old
          // full setData ran on EVERY new candle — the visible range could
          // jump and big histories stuttered.
          const pureAppend =
            bars.length > prev.length && prev.length > 0 &&
            bars.length - prev.length <= 6 &&
            bars[0].time === prev[0].time &&
            bars[prev.length - 1].time === prev[prev.length - 1].time;
          if (pureAppend) {
            barsRef.current = bars;
            // Phase 24 D4: the previous last bar's FINAL ticks (high/low/close
            // revisions in the same delivery) must repaint too — the loop used
            // to touch only indices ≥ prev.length, so the rendered
            // second-to-last candle kept stale values until the next
            // structural change (visible as frozen candle bodies on minute roll)
            const prevLast = prev[prev.length - 1];
            const newLast = bars[prev.length - 1];
            if (prevLast && newLast &&
              (prevLast.open !== newLast.open || prevLast.high !== newLast.high ||
               prevLast.low !== newLast.low || prevLast.close !== newLast.close ||
               prevLast.volume !== newLast.volume)) {
              updateMain(candleRef.current!, mainKindRef.current, newLast, haStateRef);
              if (volumeVisibleRef.current) volumeRef.current?.update(toVolume(newLast));
            }
            for (let i = prev.length; i < bars.length; i++) {
              updateMain(candleRef.current!, mainKindRef.current, bars[i], haStateRef);
              if (volumeVisibleRef.current) volumeRef.current?.update(toVolume(bars[i]));
            }
            const idx = timeIdxRef.current;
            for (let i = prev.length; i < bars.length; i++) idx.set(bars[i].time, i);
            applyBarsToSeries("update"); // indicators + tail refresh
          } else if (bars.length !== prev.length) {
            // structural change (prepend / big resync) — full rebuild
            barsRef.current = bars;
            applyBarsToSeries("set");
            // Phase 30 §5: the requested range follows the series when deep
            // history extends it (All / 5Y keep showing the full depth)
            if (lastRangeKeyRef.current) queueMicrotask(() => applyRange(lastRangeKeyRef.current!));
          } else {
            barsRef.current = upsertLocal(prev, lastBar);
            applyBarsToSeries("update");
          }
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
  }, [symbol, timeframe, reloadKey, replayMode]);

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
      if (volumeVisibleRef.current) volumeRef.current?.update(toVolume(next[next.length - 1]));
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
    .map((i) => `${i.id}:${i.type}:${JSON.stringify(i.params)}:${JSON.stringify(i.style ?? {})}`)
    .join("|");
  const overlayKey = indicators
    .filter((i) => i.visible && INDICATOR_CATALOG[i.type].pane === "main" && i.type !== "volume")
    .map((i) => `${i.id}:${JSON.stringify(i.params)}:${JSON.stringify(i.style ?? {})}`)
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
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: TF_SECONDS[timeframe] < 60, visible: cfg.id === subList[subList.length - 1]?.id },
      });
      const series: ISeriesApi<"Line" | "Histogram">[] = [];
      const addLine = (key: string, color: string, lineWidth: 1 | 2, opts: Record<string, unknown> = {}) => {
        const st = cfg.style;
        const s = chart.addLineSeries({
          color: withAlpha(color, st?.opacity),
          lineWidth: (st?.width ? Math.min(4, Math.max(1, Math.round(st.width))) : lineWidth) as 1 | 2,
          lineStyle: (st?.dash === "dashed" ? LineStyle.Dashed : st?.dash === "dotted" ? LineStyle.Dotted : LineStyle.Solid) as LineStyle,
          priceLineVisible: false, lastValueVisible: false, ...opts,
        } as any);
        (s as any).__key = key;
        (s as any).__color = color;
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
      // ---- Phase 27 sub-panes -------------------------------------------------
      if (cfg.type === "adx") { addLine("adx", "#e879f9", 2); addLine("plusDI", "#22c55e", 1); addLine("minusDI", "#ef4444", 1); }
      if (cfg.type === "willr") addLine("willr", "#38bdf8", 2);
      if (cfg.type === "cci") addLine("cci", "#f59e0b", 2);
      if (cfg.type === "stochrsi") { addLine("k", "#38bdf8", 1); addLine("d", "#f59e0b", 1); }
      if (cfg.type === "mfi") addLine("mfi", "#22c55e", 2);
      if (cfg.type === "obv") addLine("obv", "#38bdf8", 2);
      if (cfg.type === "trix") addLine("trix", "#e879f9", 2);
      if (cfg.type === "ao") {
        const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, color: "#f59e0b" });
        (hist as any).__key = "ao";
        series.push(hist);
      }
      if (cfg.type === "roc") addLine("roc", "#94a3b8", 2);
      // ---- Phase 36 sub-panes -------------------------------------------------
      if (cfg.type === "momentum") addLine("momentum", "#94a3b8", 2);
      if (cfg.type === "bbw") addLine("bbw", "#38bdf8", 2);
      if (cfg.type === "stddev") addLine("stddev", "#a78bfa", 2);

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
  // Phase 30 §5: remember the requested range so it RE-APPLIES when deeper
  // history lands in the background (metals deep layers load async), and
  // wake the feed again when the loaded series does not reach the requested
  // window yet.
  const lastRangeKeyRef = useRef<string | null>(null);
  const rangeRefireAtRef = useRef(0);
  const tfForRangeRef = useRef(timeframe);
  tfForRangeRef.current = timeframe;
  const applyRange = useCallback((key: string) => {
    lastRangeKeyRef.current = key;
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
    if (data[0].time > cutoff) {
      // history doesn't reach that far — show everything we have, and (once
      // per 3s) re-fire the loader so background deep layers (metals) or a
      // fresh fetch can extend the series; the structural-change branch
      // re-applies this range when the older candles arrive.
      ts.fitContent();
      ts.scrollToRealTime();
      if (Date.now() - rangeRefireAtRef.current > 3000) {
        rangeRefireAtRef.current = Date.now();
        void loadFeed(symbolRef.current, tfForRangeRef.current).catch(() => { /* transient — the next click retries */ });
      }
      return;
    }
    let lo = 0;
    let hi = data.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].time >= cutoff) hi = mid; else lo = mid + 1; }
    ts.setVisibleLogicalRange({ from: Math.max(0, lo - 2), to: data.length + 5 });
  }, []);

  // ---- pending-order price lines (re-hung after every main-series swap) --------
  const [seriesEpoch, setSeriesEpoch] = useState(0);

  // Phase 34: price-scale side (per instrument, survives series rebuilds)
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    const side = mergedSettings.priceScaleSide ?? "right";
    if (!chart || !candle) return;
    chart.applyOptions({
      rightPriceScale: { visible: side === "right", borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      leftPriceScale: { visible: side === "left", borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
    });
    (candle as unknown as { applyOptions: (o: Record<string, unknown>) => void }).applyOptions({ priceScaleId: side });
  }, [mergedSettings.priceScaleSide, seriesEpoch]);

  // Phase 34: chart timezone (per instrument) — re-register the formatters
  useEffect(() => {
    tzCurrent = mergedSettings.timezone || "";
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.applyOptions({
        timeScale: { tickMarkFormatter: (t: number, kind: number) => {
          const d = new Date(t * 1000);
          if (kind <= 1) return fmtMY(d);
          if (kind === 2) return fmtDM(d);
          return fmtHM(d);
        } },
        localization: { timeFormatter: (t: number) => fmtHM(new Date(t * 1000)) },
      });
    } catch { /* invalid tz — viewer locale keeps rendering */ }
  }, [mergedSettings.timezone, seriesEpoch]);
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    // Phase 59: DIFF instead of recreate — use-trading's 10s heartbeat hands
    // us fresh array identities for unchanged orders; the old remove-all +
    // recreate blinked the axis labels on every heartbeat. A mark survives
    // unless its (id, price, color, style, title) changed.
    const keyOf = (m: any) => `${m.id ?? m.title}|${m.price}|${m.color}|${m.dashed ? "d" : "s"}|${m.title}`;
    const want = new Map<string, any>();
    for (const m of safeMarks) {
      if (!Number.isFinite(m.price) || m.price <= 0) continue;
      want.set(keyOf(m), m);
    }
    const have = lineHandlesRef.current;
    for (const [key, entry] of [...have.entries()]) {
      if (!want.has(key)) {
        try { candle.removePriceLine(entry.handle); } catch { /* series gone */ }
        have.delete(key);
      }
    }
    for (const [key, m] of want.entries()) {
      if (have.has(key)) continue;
      have.set(key, {
        handle: candle.createPriceLine({
          price: m.price,
          color: m.color,
          lineWidth: 1,
          lineStyle: m.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: m.title,
        }),
      });
    }
  }, [safeMarks, seriesEpoch]);

  // ---- trade lines (positions) ---------------------------------------------------
  const safeOrders = Array.isArray(orders) ? orders : [];
  const tradeLines = useMemo<TradeLine[]>(() => {
    const out: TradeLine[] = [];
    for (const p of safePositions) {
      const color = p.side === "buy" ? "#3b82f6" : "#f97316";
      out.push({ positionId: p.id, kind: "entry", price: p.entry, color, label: `${p.side === "buy" ? "BUY" : "SELL"} ${p.lots}`, digits });
      if (p.sl) out.push({ positionId: p.id, kind: "sl", price: p.sl, color: "#ef4444", label: "SL", digits });
      if (p.tp) out.push({ positionId: p.id, kind: "tp", price: p.tp, color: "#22c55e", label: "TP", digits });
    }
    // P54 §3 — pending orders: draggable entry (→ modify-order price), SL/TP
    for (const o of safeOrders) {
      const color = "#f59e0b";
      out.push({ positionId: o.id, kind: "order-entry", price: o.price, color, label: `${o.kind === "limit" ? "LIMIT" : "STOP"} ${o.side.toUpperCase()} ${o.lots}`, digits });
      if (o.sl) out.push({ positionId: o.id, kind: "order-sl", price: o.sl, color: "#ef4444", label: "SL", digits });
      if (o.tp) out.push({ positionId: o.id, kind: "order-tp", price: o.tp, color: "#22c55e", label: "TP", digits });
    }
    return out;
  }, [safePositions, safeOrders, digits]);

  const handleTradeLineMove = useCallback((positionId: string, kind: TradeLine["kind"], price: number) => {
    // pending-order lines route to the modify-order endpoint; a rejected
    // modification simply never confirms — the order refetch restores the
    // real levels (the parent keeps the authoritative state)
    if (kind === "order-entry") { void withTradeLock(() => Promise.resolve(onModifyOrderRef.current?.(positionId, { price }))); return; }
    if (kind === "order-sl") { void withTradeLock(() => Promise.resolve(onModifyOrderRef.current?.(positionId, { sl: price }))); return; }
    if (kind === "order-tp") { void withTradeLock(() => Promise.resolve(onModifyOrderRef.current?.(positionId, { tp: price }))); return; }
    if (kind === "entry") return;
    const patch = kind === "sl" ? { sl: price } : { tp: price };
    void withTradeLock(() => onModifyRef.current(positionId, patch));
  }, []);

  // ---- P54 §3 — order/position details panel (click on a trade line) -------
  const [tradeDetails, setTradeDetails] = useState<{ kind: "position" | "order"; id: string } | null>(null);
  // PHASE 61 §6 — partial close straight from the chart details panel; the
  // input defaults to half the position volume and is clamped client-side.
  const [partialLots, setPartialLots] = useState("");
  const handleTradeLineClick = useCallback((t: TradeLine) => {
    setTradeDetails({ kind: t.kind.startsWith("order") ? "order" : "position", id: t.positionId });
    const pos = safePositions.find((p) => p.id === t.positionId);
    setPartialLots(pos ? String(Math.max(0.01, Math.round((pos.lots / 2) * 100) / 100)) : "");
  }, [safePositions]);

  // ---- drawings persistence -------------------------------------------------------
  useEffect(() => {
    if (!uid || !symbol) return;
    // instrument switch: the undo/redo stacks belong to the OLD instrument —
    // replaying them here would save another symbol's drawings onto this one
    historyRef.current = [];
    futureRef.current = [];
    setHistLens({ u: 0, r: 0 });
    setSelectedDrawingId(null);
    setSelectedIds([]);
    setEditingDrawing(null);
    // the previous instrument's objects must not render on the new chart for
    // even a moment — clear synchronously, RTDB delivers the real list after
    setDrawings([]);
    setIndicators([]);
    const offD = subscribeDrawings(uid, symbol, (list) => {
      // P40 — per-drawing LWW merge replaces the old 15s echo window:
      // local edits whose write is still in flight survive, remote edits and
      // deletions propagate, tombstoned (locally deleted) echoes are already
      // filtered out by subscribeDrawings. Identical echoes return the local
      // reference → no re-render, no mid-drag flicker.
      // drawings written <3s ago are still in flight — a remote snapshot
      // without them must not drop them (RTDB offline queue delivers later)
      const pendingIds = new Set(
        drawingsRef.current.filter((d) => (d.updatedAt ?? 0) > Date.now() - 3000).map((d) => d.id),
      );
      const merged = mergeDrawingLists(drawingsRef.current, list, pendingIds);
      if (merged === drawingsRef.current) return;
      setDrawings(merged);
      drawingsRef.current = merged;
    });
    const offI = subscribeIndicators(uid, symbol, (list) => setIndicators(list));
    return () => { offD(); offI(); flushPendingDrawingWrites(); };
  }, [uid, symbol]);

  /** P40 — stamp updatedAt on changed drawings, tombstone removals, then
   *  persist (LS immediate, RTDB debounced per-child diff). Shared by
   *  commit / undo / redo. */
  const persistDrawings = useCallback((prev: Drawing[], next: Drawing[]) => {
    const stamped = stampChangedDrawings(prev, next, Date.now());
    if (uid) {
      const nextIds = new Set(stamped.map((d) => d.id));
      recordDrawingTombstones(uid, symbolRef.current, prev.filter((d) => !nextIds.has(d.id)).map((d) => d.id));
      saveDrawings(uid, symbolRef.current, stamped);
    }
    return stamped;
  }, [uid]);

  const commitDrawings = useCallback((next: Drawing[]) => {
    historyRef.current.push(drawingsRef.current);
    if (historyRef.current.length > 100) historyRef.current.shift();
    futureRef.current = [];
    const stamped = persistDrawings(drawingsRef.current, next);
    setDrawings(stamped);
    drawingsRef.current = stamped;
    setHistLens({ u: historyRef.current.length, r: futureRef.current.length });
  }, [uid, persistDrawings]);

  const undoDrawings = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    futureRef.current.push(drawingsRef.current);
    const stamped = persistDrawings(drawingsRef.current, prev);
    setDrawings(stamped);
    drawingsRef.current = stamped;
    setHistLens({ u: historyRef.current.length, r: futureRef.current.length });
  }, [persistDrawings]);

  const redoDrawings = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(drawingsRef.current);
    const stamped = persistDrawings(drawingsRef.current, next);
    setDrawings(stamped);
    drawingsRef.current = stamped;
    setHistLens({ u: historyRef.current.length, r: futureRef.current.length });
  }, [persistDrawings]);

  const toggleDrawingHidden = useCallback((id: string) => {
    commitDrawings(drawingsRef.current.map((d) => (d.id === id ? { ...d, hidden: !d.hidden } : d)));
  }, [commitDrawings]);

  // ---- P42 — object tree: single/bulk patches, locate, duplicate, groups ----
  const patchDrawing = useCallback((id: string, patch: Partial<Drawing>) => {
    commitDrawings(drawingsRef.current.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, [commitDrawings]);

  const patchManyDrawings = useCallback((ids: string[], patch: Partial<Drawing>) => {
    const set = new Set(ids);
    if (!set.size) return;
    commitDrawings(drawingsRef.current.map((d) => (set.has(d.id) ? { ...d, ...patch } : d)));
  }, [commitDrawings]);

  /** bulk delete — locked objects are NEVER deleted (safe & predictable) */
  const deleteManyTree = useCallback((ids: string[]) => {
    const set = new Set(ids);
    // Phase 59: the CANONICAL delete — per-object locks are honored here and
    // ONLY here (4 of 5 delete paths used to bypass `locked`). Selected ids
    // clear through the sync mirror so stale closures can't resurrect them.
    commitDrawings(drawingsRef.current.filter((d) => !set.has(d.id) || d.locked || locked));
    setSelectedIdsSync([]);
  }, [commitDrawings, locked, setSelectedIdsSync]);

  const duplicateDrawingById = useCallback((id: string) => {
    const src = drawingsRef.current.find((d) => d.id === id);
    if (!src) return;
    // one tf-bucket to the right + a hair of price offset — clearly a
    // separate object, immediately selectable
    const step = TF_SECONDS[timeframeRef.current] ?? 60;
    const copy: Drawing = {
      ...src,
      id: newDrawingId(),
      points: src.points.map((q) => ({ time: q.time + step, price: q.price * 1.001 })),
    };
    commitDrawings([...drawingsRef.current, copy]);
    setSelectedDrawingId(copy.id);
  }, [commitDrawings]);

  /** select + scroll the time scale to the object's first anchor */
  const locateDrawing = useCallback((id: string) => {
    const d = drawingsRef.current.find((x) => x.id === id);
    if (!d) return;
    const t0 = d.points[0]?.time;
    if (!t0) return;
    let idx = timeIdxRef.current.get(t0);
    const data = barsRef.current;
    if (idx == null && data.length) {
      idx = data.findIndex((b) => b.time >= t0);
      if (idx < 0) idx = data.length - 1;
    }
    if (idx != null && chartRef.current) {
      try { chartRef.current.timeScale().setVisibleLogicalRange({ from: idx - 30, to: idx + 30 }); } catch { /* race */ }
    }
  }, []);

  // groups — RTDB `chart/{uid}/groups/{symbol}` + LS mirror (LS-first paint)
  const [groups, setGroups] = useState<Record<string, DrawingGroup>>({});
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  useEffect(() => {
    if (!uid) { setGroups({}); return; }
    return subscribeGroups(uid, symbol, setGroups);
  }, [uid, symbol]);
  const commitGroups = useCallback((next: Record<string, DrawingGroup>) => {
    setGroups(next);
    persistGroups(uid ?? "", symbolRef.current, next);
  }, [uid]);

  const createGroup = useCallback((name: string): string => {
    const g: DrawingGroup = { id: newGroupId(), name: name.slice(0, 40) || "Group", createdAt: Date.now() };
    commitGroups({ ...groupsRef.current, [g.id]: g });
    return g.id;
  }, [commitGroups]);

  const renameGroup = useCallback((id: string, name: string) => {
    const g = groupsRef.current[id];
    if (!g || !name.trim()) return;
    commitGroups({ ...groupsRef.current, [id]: { ...g, name: name.trim().slice(0, 40) } });
  }, [commitGroups]);

  const deleteGroup = useCallback((id: string) => {
    // members return to the ungrouped root — nothing is silently deleted
    commitDrawings(dissolveGroup(drawingsRef.current, id));
    const next = { ...groupsRef.current };
    delete next[id];
    commitGroups(next);
  }, [commitDrawings, commitGroups]);

  const toggleGroupHiddenById = useCallback((id: string) => {
    const all = groupFlag(drawingsRef.current, id, "hidden");
    patchManyDrawings(groupMemberIds(drawingsRef.current, id), { hidden: !all });
  }, [patchManyDrawings]);

  const toggleGroupLockedById = useCallback((id: string) => {
    const all = groupFlag(drawingsRef.current, id, "locked");
    patchManyDrawings(groupMemberIds(drawingsRef.current, id), { locked: !all });
  }, [patchManyDrawings]);

  const moveToGroupTree = useCallback((ids: string[], groupId: string | null) => {
    commitDrawings(moveToGroup(drawingsRef.current, ids, groupId));
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

  // Phase 37 §5 — load the user's fib presets (uid declared above this point)
  useEffect(() => {
    let on = true;
    if (uid) void loadFibPresets(uid).then((ps) => { if (on) setFibPresets(ps); });
    return () => { on = false; };
  }, [uid]);

  /** Remove one indicator + its orphan overlay series (shared by toolbar,
   *  object tree and the library). */
  const removeIndicator = useCallback((id: string) => {
    commitIndicators(indicatorsRef.current.filter((i) => i.id !== id));
    for (const [key, s] of [...overlayRef.current]) {
      if (key.startsWith(`${id}:`)) { try { chartRef.current?.removeSeries(s); } catch { /* gone */ } overlayRef.current.delete(key); }
    }
    indCacheRef.current.delete(id);
    indValuesRef.current.delete(id);
  }, [commitIndicators]);

  /** Phase 36 §6 — Remove All Indicators with confirmation. */
  const clearAllIndicators = useCallback(() => {
    if (!indicatorsRef.current.length) return;
    if (!window.confirm("Remove ALL indicators from this chart?")) return;
    commitIndicators([]);
    for (const [, s] of [...overlayRef.current]) { try { chartRef.current?.removeSeries(s); } catch { /* gone */ } }
    overlayRef.current.clear();
    indCacheRef.current.clear();
    indValuesRef.current.clear();
    if (uid) clearIndicatorsRemote(uid, symbolRef.current);
  }, [commitIndicators, uid]);

  /** Phase 36 §3 — reorder indicators (z-order for overlays, pane order). */
  const moveIndicator = useCallback((id: string, dir: -1 | 1) => {
    const list = [...indicatorsRef.current];
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    commitIndicators(list);
  }, [commitIndicators]);

  // ---- legend + countdown ----------------------------------------------------------
  const updateLegend = useCallback((hoverTime: number | null) => {
    const el = legendRef.current;
    if (!el) return;
    const data = barsRef.current;
    if (!data.length) { el.innerHTML = ""; return; }
    // Phase 59: hover in a session gap shows the NEAREST bar (the old
    // `?? data.length - 1` presented the last candle's OHLC as if it were
    // under the crosshair)
    const idx = hoverTime != null
      ? (timeIdxRef.current.get(hoverTime) ?? findBarIndex(data, hoverTime) ?? data.length - 1)
      : data.length - 1;
    const b = data[idx];
    const prev = data[Math.max(0, idx - 1)];
    const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : 0;
    const fmt = (v: number) => v.toFixed(priceFormatRef.current.precision);
    const cls = chg >= 0 ? "text-emerald-400" : "text-red-400";
    // TradingView-style: the exact bar under the crosshair, with its own timestamp
    const ts2 = new Date(b.time * 1000);
    const hh = (n: number) => String(n).padStart(2, "0");
    // D1/W1/MN candles start at a day boundary — a HH:MM stamp is noise there
    // (TradingView shows the date only for daily+ bars)
    const tfSec2 = TF_SECONDS[timeframeRef.current] ?? 60;
    // honor the per-instrument timezone override — the axis/crosshair already
    // do (fmtDM/fmtHM); legend and axis must agree on the same candle
    const stamp = tfSec2 >= 86400
      ? fmtDM(ts2) + (tfSec2 >= 2592000 ? ` ${fmtMY(ts2).split(" ")[1]}` : "")
      : `${fmtDM(ts2)} ${fmtHM(ts2)}`;
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
        const keyLabelMap: Record<string, string> = { plusDI: "+DI", minusDI: "−DI", up: "ST↑", down: "ST↓", spanA: "SpanA", spanB: "SpanB" };
        const short = cfg.type === "bb"
          ? (key === "basis" ? "BB" : key === "upper" ? "BB↑" : key === "lower" ? "BB↓" : key.toUpperCase())
          : (keyLabelMap[key] || key.toUpperCase());
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
      // last real data update stamp (badge) — imperative, no re-renders.
      // Phase 19 transparency: stamp + MEASURED freshness (age in seconds)
      // + the provider's own lag; the text goes red when the feed is stale.
      const tickEl = lastTickRef.current;
      if (tickEl) {
        const inst = getInstrument(symbolRef.current);
        const s = getSpotState();
        const at = inst?.spotCode ? s.lastTickAt : getConnectionState().lastTickAt;
        const age = at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
        const stale = age != null && age > 120; // no update for 2 min → stale
        // P49 §6 diagnostics: provider name + provider-stamp lag + MEASURED
        // provider cadence (mean interval between distinct prices). Binance
        // streams over WS (stamp = receipt); metals poll gold-api 1s and the
        // provider's own updatedAt lag is the honest upstream latency number.
        const provName = inst?.spotCode ? "gold-api" : inst?.feed === "binance" ? "Binance WS" : "quotes-api";
        const cadence = inst?.spotCode ? spotMeasuredUpdateSec(inst.spotCode) : null;
        tickEl.textContent = at
          ? `· upd ${new Date(at).toLocaleTimeString([], { hour12: false })} · ${age}s ago` +
            (inst?.spotCode && s.providerDelaySec != null && s.providerDelaySec > 15 ? ` · feed +${s.providerDelaySec}s` : "") +
            (cadence != null ? ` · Δ${cadence}s` : "") +
            ` · ${provName}` +
            (stale ? " · STALE" : "")
          : "";
        tickEl.style.color = stale ? "#f87171" : "";
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // ---- P55 §11 — chart-action shortcuts (dispatched from TerminalPage) ----
  useEffect(() => {
    const h = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (action === "undo") undoDrawings();
      else if (action === "redo") redoDrawings();
      else if (action === "fullscreen") toggleFullscreen();
      else if (action === "crosshair") setCursorMode("cross");
      else if (action === "toggleStayDrawing") {
        const next = !stayDrawingRef.current;
        stayDrawingRef.current = next;
        setStayDrawing(next);
        try { localStorage.setItem("it-stay-drawing", next ? "1" : "0"); } catch { /* private mode */ }
      }
    };
    window.addEventListener("it-shortcut", h);
    return () => window.removeEventListener("it-shortcut", h);
  });

  // ---- P38 §1 — "Stay in Drawing Mode" --------------------------------------
  // Default: after finishing one drawing the tool returns to Select, so a
  // click can never accidentally start a second object. This toggle (persisted)
  // keeps the tool armed for users drawing many objects in a row — the same
  // effect as the Shift chaining shortcut, but visible and sticky.
  const [stayDrawing, setStayDrawing] = useState<boolean>(() => {
    try { return localStorage.getItem("it-stay-drawing") === "1"; } catch { return false; }
  });
  const stayDrawingRef = useRef(stayDrawing);
  stayDrawingRef.current = stayDrawing;
  const onStayDrawingToggle = useCallback(() => {
    setStayDrawing((v) => {
      try { localStorage.setItem("it-stay-drawing", v ? "0" : "1"); } catch { /* private mode */ }
      return !v;
    });
  }, []);

  // ---- keyboard tool shortcuts --------------------------------------------------------
  // Phase 31: Shift-held tracker — chaining drawings (Shift+commit keeps the
  // tool armed, TradingView-style) without a per-user setting to forget.
  const shiftHeldRef = useRef(false);
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeldRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeldRef.current = false; };
    const blur = () => { shiftHeldRef.current = false; };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // P39 — Delete/Backspace is owned by DrawingCanvas's window handler
      // (lock-aware + multi-select-aware). This branch used to run for the
      // SAME keypress: two undo entries per delete, and it bypassed the
      // global LOCK the rail button honors — keyboard delete while locked
      // was possible while the button looked disabled.
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
          const pasted = copyRef.current.map((d) => ({ ...d, id: newDrawingId(), locked: false, points: d.points.map((q) => ({ time: q.time + dt, price: q.price })) }));
          commitDrawings([...drawingsRef.current, ...pasted]);
          return;
        }
        if (k === "d" && ids.length) {
          const dt = (TF_SECONDS[timeframe] || 3600) * 4;
          const copies = drawingsRef.current.filter((d) => ids.includes(d.id)).map((d) => ({ ...d, id: newDrawingId(), locked: false, points: d.points.map((q) => ({ time: q.time + dt, price: q.price })) }));
          commitDrawings([...drawingsRef.current, ...copies]);
          return;
        }
        // P38 §4 — Ctrl+A selects all visible drawings (the INPUT/TEXTAREA
        // guard at the top of this handler keeps text fields native)
        if (k === "a" && drawingsRef.current.length) {
          e.preventDefault();
          const ids = drawingsRef.current.filter((d) => !d.locked && !d.hidden).map((d) => d.id);
          setSelectedIds(ids);
          setSelectedDrawingId(ids[ids.length - 1] ?? null);
          return;
        }
      }
      // Any Ctrl/Alt/Meta combo (Ctrl+R, Ctrl+Shift+R reload, Ctrl+S, Ctrl+T…)
      // stays NATIVE — the plain-letter drawing shortcuts must never swallow
      // browser shortcuts (r used to activate the rect tool on Ctrl+Shift+R).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map: Record<string, DrawingType> = { t: "trend", h: "hline", v: "vline", r: "rect", f: "fib-retracement", x: "text", p: "channel", e: "fib-extension", i: "extended", m: "measure" };
      const k = map[e.key.toLowerCase()];
      if (k) {
        setActiveTool(k);
        e.preventDefault();
        // Phase 59: CONSUME the event — TerminalPage's dispatcher is another
        // listener on the SAME window node, so stopPropagation alone can't
        // stop it; bare "t" armed the trend tool AND toggled the order ticket
        e.stopImmediatePropagation();
      }
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
    const d: Drawing = { id: newDrawingId(), type: "hline", points: [{ time: 0, price }], style: { color: "#38bdf8", width: 1, dash: "solid", fontSize: 12 } };
    commitDrawings([...drawingsRef.current, d]);
    setSelectedDrawingId(d.id);
  }, [commitDrawings]);

  const addTextAt = useCallback((time: number, price: number) => {
    const d: Drawing = { id: newDrawingId(), type: "text", points: [{ time, price }], style: { color: "#e2e8f0", width: 1, dash: "solid", fontSize: 12 }, text: "Note" };
    commitDrawings([...drawingsRef.current, d]);
    setSelectedDrawingId(d.id);
    setEditingDrawing(d);
  }, [commitDrawings]);

  const applyLayout = useCallback((snap: LayoutSnapshot) => {
    onSymbolChange(snap.symbol);
    onTimeframeChange(snap.timeframe as Timeframe);
    // Phase 59: RTDB layouts are user-editable data — an unknown indicator
    // type used to throw at render (INDICATOR_CATALOG[...].pane) and brick
    // the whole chart. Sanitize like every other snapshot path.
    const layoutIndicators = sanitizeIndicatorList(snap.indicators ?? []);
    setIndicators(layoutIndicators);
    if (uid) saveIndicators(uid, snap.symbol, layoutIndicators);
    if (snap.settings) setSettings(applyGridDefaultOff({ ...DEFAULT_SETTINGS, ...(snap.settings as unknown as Partial<ChartSettings>) }));
  }, [onSymbolChange, onTimeframeChange, uid]);

  // The on-chart feed status badge (Live spot · gold-api · … / MARKET CLOSED)
  // is HIDDEN by user request — the feeds themselves keep running exactly as
  // before: the badge was pure presentation over `conn` + the spot snapshot,
  // and the gold-api poller lives in market-data (independent of React).
  // The last-tick span is gone with it; the imperative updater guards null.

  return (
    <div ref={wrapperRef} data-chart-dark="1" className={cn("relative flex h-full w-full min-h-0 flex-col bg-[#0b1220]", className)} style={height ? { height } : undefined}>
      {olderLoading && (
        <div className="absolute left-2 top-16 z-10 flex items-center gap-2 rounded-md border border-sky-700/50 bg-sky-950/70 px-2 py-1 text-[11px] text-sky-300 backdrop-blur">
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
          Loading older candles…
        </div>
      )}
      <ChartToolbar
        symbol={symbol}
        indicators={indicators}
        onAddIndicator={(type) => commitIndicators([...indicatorsRef.current, newIndicatorConfig(type)])}
        onIndicatorToggle={(id) => commitIndicators(indicatorsRef.current.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)))}
        onIndicatorRemove={removeIndicator}
        onIndicatorConfigure={(id) => setEditingIndicator(indicatorsRef.current.find((i) => i.id === id) ?? null)}
        onOpenIndicatorLibrary={() => setIndicatorLibraryOpen(true)}
        volumeNote={volumeNote}
        onOpenSettings={() => setOpenDialog("settings")}
        onOpenLayouts={() => setOpenDialog("layouts")}
        onOpenSearch={() => setOpenDialog("search")}
        onReset={resetView}
        onFullscreen={toggleFullscreen}
        onOpenAlerts={() => onOpenAlerts?.()}
        onOpenReplay={() => onOpenReplay?.()}
        chartType={chartType}
        onChartTypeChange={setChartTypePanel}
        canUndo={histLens.u > 0}
        canRedo={histLens.r > 0}
        onUndo={undoDrawings}
        onRedo={redoDrawings}
        onScreenshot={screenshot}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <LeftRail
          activeTool={activeTool}
          favs={favTools}
          onToggleFav={toggleFavTool}
          onToolSelect={(t) => setActiveTool((cur) => (cur === t ? "cursor" : t))}
          magnetMode={magnetModeOf(settings)}
          onMagnetCycle={() => setSettings((s) => {
            const next = ((magnetModeOf(s) + 1) % 3) as 0 | 1 | 2;
            return { ...s, magnetMode: next, magnet: next > 0 }; // keep the legacy boolean in sync
          })}
          locked={locked}
          onLockToggle={() => setLocked((v) => { try { localStorage.setItem("it_chart_lock", v ? "0" : "1"); } catch { /* private mode */ } return !v; })}
          hiddenAll={hiddenAll}
          onHideAllToggle={() => setHiddenAll((v) => { try { localStorage.setItem("it_chart_hideall", v ? "0" : "1"); } catch { /* private mode */ } return !v; })}
          drawingsCount={drawings.length}
          stayDrawing={stayDrawing}
          onStayDrawingToggle={onStayDrawingToggle}
          hasSelected={!!selectedDrawingId || selectedIds.length > 0}
          onDeleteSelected={() => {
            // P38 §3 — toolbar Delete for the SELECTED drawing (mouse-first;
            // the keyboard Delete path already existed). Phase 59: routed
            // through the canonical locked-aware delete.
            const ids = selectedIds.length ? selectedIds : (selectedDrawingId ? [selectedDrawingId] : []);
            if (!ids.length) return;
            deleteManyTree(ids);
          }}
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
          onSelectIds={(ids) => setSelectedIdsSync(ids)}
          onDeleteMany={(ids) => deleteManyTree(ids)}
          activeTool={activeTool === "cursor" ? null : activeTool}
          // Phase 31: TradingView behaviour — after a drawing commits the
          // tool ALWAYS returns to the cursor; hold Shift while committing to
          // chain another object with the same tool. Esc also disarms.
          onToolCommitted={() => { if (!stayDrawingRef.current && !shiftHeldRef.current) setActiveTool("cursor"); }}
          magnetMode={magnetModeOf(settings)}
          toolDefaults={styleForTool(toolDefaultMap, activeTool === "cursor" ? null : activeTool, {
            color: settingsRef.current.drawColor,
            width: settingsRef.current.drawWidth,
            dash: settingsRef.current.drawDash,
            fontSize: settingsRef.current.drawFontSize,
          })}
          selectedId={selectedDrawingId}
          onSelect={(id) => { setSelectedDrawingId(id); setSelectedIds([]); }}
          onDelete={(id) => deleteManyTree([id])}
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
          onTradeLineClick={handleTradeLineClick}
          tfSeconds={TF_SECONDS[timeframe] ?? 0}
          digits={digits}
          renderEnv={renderEnv}
          locked={locked}
          hiddenAll={hiddenAll}
          getBars={() => barsRef.current}
          cursorFallback={cursorCss(cursorMode)}
        />

        {/* P41 §2 — floating favorites toolbar (quick-access drawing tools) */}
        <FavoritesToolbar
          favs={favTools}
          activeTool={activeTool}
          onActivate={(t) => setActiveTool(t)}
          onToggleFav={toggleFavTool}
          onReorder={reorderFavTools}
        />
        {/* P54 §3 — order/position details panel (opened by clicking a trade
            line on the chart; a drag still modifies through the backend) */}
        {tradeDetails && (() => {
          const pos = tradeDetails.kind === "position" ? safePositions.find((p) => p.id === tradeDetails.id) : null;
          const ord = tradeDetails.kind === "order" ? safeOrders.find((o) => o.id === tradeDetails.id) : null;
          if (!pos && !ord) return null;
          const last = barsRef.current?.at(-1)?.close ?? null;
          const dg = digits;
          const busyTrade = tradeBusyRef.current;
          const plNum = Number(partialLots);
          const canPartial = pos != null && Number.isFinite(plNum)
            && plNum >= 0.01 && plNum < pos.lots && pos.lots - plNum >= 0.01 - 1e-9;
          return (
            <div data-chart-ui className="absolute right-12 top-9 z-40 w-56 rounded-xl border border-slate-700 bg-[#0d1526]/95 p-3 text-xs shadow-2xl backdrop-blur">
              <div className="mb-2 flex items-center justify-between">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold",
                  (pos?.side ?? ord?.side) === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>
                  {ord ? `${ord.kind.toUpperCase()} ${ord.side.toUpperCase()} ${ord.lots.toFixed(2)} ${ord.symbol}`
                       : `${pos!.side.toUpperCase()} ${pos!.lots.toFixed(2)} ${pos!.symbol}`}
                </span>
                <button onClick={() => setTradeDetails(null)} aria-label="Close details" className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X className="h-3 w-3" /></button>
              </div>
              {ord ? (
                <div className="space-y-1 text-[11px] text-slate-300">
                  <div className="flex justify-between"><span className="text-slate-500">Trigger</span><span className="font-number">{ord.price.toFixed(dg)}</span></div>
                  {ord.sl != null && <div className="flex justify-between"><span className="text-slate-500">Stop loss</span><span className="font-number">{ord.sl.toFixed(dg)}</span></div>}
                  {ord.tp != null && <div className="flex justify-between"><span className="text-slate-500">Take profit</span><span className="font-number">{ord.tp.toFixed(dg)}</span></div>}
                  {last != null && <div className="flex justify-between"><span className="text-slate-500">Distance</span><span className="font-number">{(((ord.price - last) / last) * 100).toFixed(2)}%</span></div>}
                  <div className="flex justify-between"><span className="text-slate-500">Expiry</span><span className="font-number">{ord.expiryAt ? new Date(ord.expiryAt).toLocaleString([], { hour12: false }) : "GTC"}</span></div>
                  <button
                    disabled={busyTrade || !onCancelOrder}
                    onClick={() => { setTradeDetails(null); void withTradeLock(() => Promise.resolve(onCancelOrder?.(ord.id))); }}
                    className="mt-2 w-full rounded bg-destructive/15 py-1 font-semibold text-red-400 hover:bg-destructive/25 disabled:opacity-40"
                  >Cancel order</button>
                </div>
              ) : (
                <div className="space-y-1 text-[11px] text-slate-300">
                  <div className="flex justify-between"><span className="text-slate-500">Entry</span><span className="font-number">{pos!.entry.toFixed(dg)}</span></div>
                  {pos!.sl != null && <div className="flex justify-between"><span className="text-slate-500">Stop loss</span><span className="font-number">{pos!.sl.toFixed(dg)}</span></div>}
                  {pos!.tp != null && <div className="flex justify-between"><span className="text-slate-500">Take profit</span><span className="font-number">{pos!.tp.toFixed(dg)}</span></div>}
                  {last != null && <div className="flex justify-between"><span className="text-slate-500">Last</span><span className="font-number">{last.toFixed(dg)}</span></div>}
                  <div className="mt-2 grid grid-cols-3 gap-1">
                    <button
                      disabled={busyTrade || (pos!.side === "buy" ? pos!.sl != null && pos!.sl >= pos!.entry : pos!.sl != null && pos!.sl <= pos!.entry)}
                      onClick={() => void withTradeLock(() => onModifyRef.current(pos!.id, { sl: pos!.entry }))}
                      className="rounded border border-border/60 py-1 font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                      title="Breakeven — SL to entry"
                    >BE</button>
                    {([0.5, 1, 2] as const).map((v) => (
                      <button
                        key={v}
                        disabled={busyTrade}
                        onClick={() => void withTradeLock(() => onModifyRef.current(pos!.id, { tsPct: v }))}
                        className={cn("rounded border py-1 font-semibold hover:bg-slate-800 disabled:opacity-40",
                          pos!.tsPct === v ? "border-emerald-500/60 text-emerald-400" : "border-border/60 text-slate-300")}
                        title={`Trailing stop ${v}%`}
                      >TS {v}%</button>
                    ))}
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      type="number" step="0.01" min="0.01" inputMode="decimal"
                      value={partialLots}
                      onChange={(e) => setPartialLots(e.target.value)}
                      placeholder="Lots"
                      className="num-input w-[68px] px-1.5 py-1 text-[11px]"
                      aria-label="Lots to close"
                    />
                    <button
                      disabled={busyTrade || !onClosePosition || !canPartial}
                      onClick={() => { const v = Number(partialLots); setTradeDetails(null); void withTradeLock(() => Promise.resolve(onClosePosition?.(pos!.id, v))); }}
                      className="flex-1 rounded bg-amber-500/15 py-1 font-semibold text-amber-400 hover:bg-amber-500/25 disabled:opacity-40"
                      title="Close part of the position at market"
                    >Close partial</button>
                  </div>
                  <button
                    disabled={busyTrade || !onClosePosition}
                    onClick={() => { setTradeDetails(null); void withTradeLock(() => Promise.resolve(onClosePosition?.(pos!.id))); }}
                    className="mt-1 w-full rounded bg-destructive/15 py-1 font-semibold text-red-400 hover:bg-destructive/25 disabled:opacity-40"
                  >Close position</button>
                </div>
              )}
            </div>
          );
        })()}

        {/* PHASE 61 §2/§3 — TradingView-style quick execution overlay:
            live server Bid/Ask + BUY/SELL with idempotent submit */}
        {accountId && <ChartTradeOverlay symbol={symbol} accountId={accountId} />}

        {/* Phase 35 §6 — drawings restore feedback is now INVISIBLE per user
            request: the restore flow itself (subscribe → LWW merge) keeps
            running untouched; only the on-chart pill was removed. */}

        {/* floating properties bar for the selected drawing */}
        {(() => {
          const sel = drawings.find((d) => d.id === selectedDrawingId);
          if (!sel || locked) return null;
          return (
            <DrawingPropsBar
              drawing={sel}
              positionEnv={renderEnv}
              onSetDefault={() => {
                if (uid) saveDrawingDefaults(uid, { ...toolDefaultMap, [sel.type]: newDefaultFromStyle(sel.style, sel.riskPct) });
              }}
              fibPresets={fibPresets}
              onSaveFibPreset={(name, lvls) => {
                if (uid) { saveFibPreset(uid, name, sel.type, lvls); void loadFibPresets(uid).then(setFibPresets); }
              }}
              onDeleteFibPreset={(name) => {
                if (uid) { deleteFibPreset(uid, name); void loadFibPresets(uid).then(setFibPresets); }
              }}
              onChange={(patch) => commitDrawings(drawingsRef.current.map((d) => (d.id === sel.id ? { ...d, ...patch } : d)))}
              onDuplicate={() => {
                const dt = (TF_SECONDS[timeframe] || 3600) * 4;
                const copy: Drawing = {
                  ...sel,
                  id: newDrawingId(),
                  points: sel.points.map((q) => ({ time: q.time + dt, price: q.price * 1.001 })),
                  locked: false,
                };
                commitDrawings([...drawingsRef.current, copy]);
                setSelectedDrawingId(copy.id);
              }}
              onDelete={() => deleteManyTree([sel.id])}
              onEditText={() => {
                // Phase 59: open the in-app properties dialog (it carries the
                // text editor) — the blocking window.prompt was the last
                // leftover of a flow Phase 27 removed at creation time
                const cur = drawingsRef.current.find((d) => d.id === sel.id);
                if (cur) setEditingDrawing(cur);
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
        {/* on-chart feed status badge removed (kept working in background) */}
        {/* admin-only Feed diagnostics + Historical data manager UI removed
            per user request (the data layer behind them is untouched) */}

        {/* P42 — Object Tree manager: grouped drawings, rename / visibility
            / lock, two-way selection sync, bulk actions, search + category
            filter, context menu. Templates & indicators stay PriceChart-
            owned and render inside the same panel. */}
        {objectsOpen && (
          <ObjectTree
            drawings={drawings}
            selectedDrawingId={selectedDrawingId}
            selectedIds={selectedIds}
            groups={groups}
            onSelect={(id) => { setSelectedDrawingId(id); setSelectedIds([]); }}
            onToggleSelect={(id) => {
              // Phase 59: read through the synchronous ref mirror — this
              // handler is called in a LOOP by Select-all/Clear-selection
              const cur = new Set(selectedIdsRef.current);
              if (cur.has(id)) cur.delete(id); else cur.add(id);
              setSelectedIdsSync([...cur]);
            }}
            onLocate={locateDrawing}
            onRename={(id, name) => patchDrawing(id, { name: name.trim().slice(0, 60) || undefined })}
            onPatch={patchDrawing}
            onPatchMany={patchManyDrawings}
            onDelete={deleteManyTree}
            onDuplicate={duplicateDrawingById}
            onEditProperties={(id) => {
              const d = drawingsRef.current.find((x) => x.id === id);
              if (d) setEditingDrawing(d);
            }}
            onReorder={(id, action) => commitDrawings(reorderDrawing(drawingsRef.current, id, action))}
            onGroupsChange={commitGroups}
            onCreateGroup={createGroup}
            onRenameGroup={renameGroup}
            onDeleteGroup={deleteGroup}
            onToggleGroupHidden={toggleGroupHiddenById}
            onToggleGroupLocked={toggleGroupLockedById}
            onMoveToGroup={moveToGroupTree}
            onClose={() => setObjectsOpen(false)}
          >
            {/* drawing templates — save the current set, apply on any symbol */}
            <div className="mb-2 mt-1 flex flex-wrap items-center gap-1 border-t border-slate-800 pt-2">
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
                  const suffix = `t${Date.now().toString(36)}`;
                  commitDrawings(__sanitizeDrawingList(tpl.drawings.map((d) => ({ ...d, id: `${d.id}${suffix}` }))));
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
            <p className="mb-1 mt-1 border-t border-slate-800 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">Indicators · {indicators.length}</p>
            <div className="max-h-32 overflow-y-auto pb-1">
              {indicators.length === 0 && <p className="py-1 text-slate-600">No indicators</p>}
              {indicators.map((cfg) => (
                <div key={cfg.id} className="flex items-center gap-1 rounded px-1 py-0.5">
                  <button className="min-w-0 flex-1 truncate text-left text-slate-300 hover:text-sky-300" onClick={() => setEditingIndicator(cfg)}>
                    {INDICATOR_CATALOG[cfg.type].label}
                  </button>
                  <button title="Move up" onClick={() => moveIndicator(cfg.id, -1)} className="text-slate-500 hover:text-slate-200"><ChevronUp className="h-3 w-3" /></button>
                  <button title="Move down" onClick={() => moveIndicator(cfg.id, 1)} className="text-slate-500 hover:text-slate-200"><ChevronDown className="h-3 w-3" /></button>
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
          </ObjectTree>
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

      {/* bottom bar: timeframe shortcuts + scale mode (TV-style). The old
          1D/5D/5Y/All range buttons were replaced by the user's request with
          direct timeframe switching — same one-click row, real TF change.
          pl-11 clears the left rail so the first TF button is never covered. */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-t border-slate-800 bg-slate-900/80 pl-11 pr-2">
        {(["1m", "5m", "15m", "1h", "4h", "1d", "1W"] as Timeframe[]).map((tf) => (
          <button
            key={tf}
            onClick={() => onTimeframeChange(tf)}
            title={`Switch the chart to the ${tf === "1W" ? "1 week" : tf} timeframe`}
            className={cn(
              "rounded px-2 py-0.5 text-[10px] font-semibold transition-colors",
              timeframe === tf
                ? "bg-sky-600 text-white"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
            )}
          >
            {tf.toLowerCase()}
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
      {/* the toolbar gear opens the unified General settings dialog (the old
          chart-only SettingsDialog was merged into its Chart settings section) */}
      <TerminalSettingsDialog open={openDialog === "settings"} onClose={() => setOpenDialog(null)} symbol={symbol} />
      <InstrumentExplorer
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
        onSave={(id, params, style) => commitIndicators(indicatorsRef.current.map((i) => (i.id === id ? { ...i, params, ...(style ? { style } : {}) } : i)))}
      />
      <IndicatorLibraryDialog
        open={indicatorLibraryOpen}
        onClose={() => setIndicatorLibraryOpen(false)}
        active={indicators}
        volumeNote={volumeNote}
        onAdd={(type) => commitIndicators([...indicatorsRef.current, newIndicatorConfig(type)])}
        onConfigure={(id) => setEditingIndicator(indicatorsRef.current.find((i) => i.id === id) ?? null)}
        onToggle={(id) => commitIndicators(indicatorsRef.current.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)))}
        onRemove={removeIndicator}
        onRemoveAll={clearAllIndicators}
      />
      <DrawingPropsDialog
        drawing={editingDrawing}
        onClose={() => setEditingDrawing(null)}
        onSave={(id, patch) => commitDrawings(drawingsRef.current.map((d) => {
          if (d.id !== id) return d;
          // deep-merge style so a partial patch keeps untouched style fields
          return { ...d, ...patch, style: patch.style ? { ...d.style, ...patch.style } : d.style };
        }))}
      />
      <ChartContextMenu
        state={contextMenu}
        onClose={() => setContextMenu(null)}
        actions={{
          addHLine: addHLineAt,
          addText: addTextAt,
          deleteDrawing: (id) => deleteManyTree([id]), // locked-aware canonical delete
          duplicateDrawing: duplicateDrawingById,
          toggleHide: toggleDrawingHidden,
          clearDrawings: () => { commitDrawings([]); if (uid) clearDrawingsRemote(uid, symbolRef.current); },
          clearIndicators: clearAllIndicators,
          resetChart: resetView,
          addAlert: (price) => { setAlertPriceDraft(price); setAlertDialogOpen(true); },
        }}
      />
      {/* P47 — create a trading alert from the chart context menu */}
      <TradingAlertDialog
        open={alertDialogOpen}
        symbol={symbol}
        timeframe={timeframe}
        lastPrice={barsRef.current[barsRef.current.length - 1]?.close ?? null}
        initialPrice={alertPriceDraft}
        drawings={drawings}
        editing={null}
        onClose={() => { setAlertDialogOpen(false); setAlertPriceDraft(null); }}
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
