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
  createChart, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { loadFeed, subscribeFeed, binanceProvider, type FeedStatus } from "@/lib/market-data";
import { getInstrument, TF_SECONDS, type Bar, type Timeframe } from "@shared/terminal";
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
import type { Drawing, DrawingType } from "@/lib/drawings";
import {
  subscribeDrawings, saveDrawings, clearDrawings as clearDrawingsRemote,
  subscribeIndicators, saveIndicators,
  type LayoutSnapshot,
} from "@/lib/chart-persistence";
import {
  DrawingCanvas, type ChartConverter, type DrawingCanvasHandle, type TradeLine,
} from "@/components/terminal/chart/DrawingCanvas";
import { ChartToolbar } from "@/components/terminal/chart/ChartToolbar";
import {
  ChartContextMenu, ChartSettings, DEFAULT_SETTINGS, DrawingPropsDialog, IndicatorParamsDialog,
  LayoutsDialog, SettingsDialog, SymbolSearchDialog, type ContextMenuState,
} from "@/components/terminal/chart/dialogs";
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
  className,
  height,
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
  className?: string;
  /** Fixed pixel height; omit to fill the parent box. */
  height?: number;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mainHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
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
  const [activeTool, setActiveTool] = useState<DrawingType | "cursor">("cursor");
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

  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const inst = useMemo(() => getInstrument(symbol), [symbol]);
  const digits = inst?.digits ?? 2;
  const priceFormat = useMemo(
    () => ({ type: "price" as const, precision: digits, minMove: Math.pow(10, -digits) }),
    [digits],
  );

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const onModifyRef = useRef(onModifyPosition);
  onModifyRef.current = onModifyPosition;

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
      crosshair: { mode: settings.magnet ? CrosshairMode.Magnet : CrosshairMode.Normal },
    });
    candle.applyOptions({
      upColor: settings.upColor, downColor: settings.downColor,
      borderUpColor: settings.upColor, borderDownColor: settings.downColor,
      wickUpColor: settings.upColor, wickDownColor: settings.downColor,
    });
    volumeRef.current?.applyOptions({ visible: settings.volume });
    canvasRef.current?.redraw();
  }, [settings]);

  // ---- create main chart once ------------------------------------------------
  useEffect(() => {
    const el = mainHostRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: COLORS.bg }, textColor: COLORS.text, fontSize: 11 },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, visible: false, rightOffset: 8 },
    });
    const candles = chart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      priceLineVisible: true, priceLineWidth: 1, lastValueVisible: true,
    });
    const volume = chart.addHistogramSeries({
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    // progressive history: near the left edge → prepend older Binance candles
    const onRangeChange = () => {
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
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onCross as any);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      overlayRef.current.clear();
      lineHandlesRef.current = [];
      for (const p of paneRef.current.values()) p.chart.remove();
      paneRef.current.clear();
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
      candle.applyOptions({ priceFormat: priceFormatRef.current });
      candle.setData(data.map(toCandle));
      volume.setData(data.map(toVolume));
      // rebuild the time→index map (indicators + crosshair lookups)
      const idx = new Map<number, number>();
      for (let i = 0; i < data.length; i++) idx.set(data[i].time, i);
      timeIdxRef.current = idx;
    } else {
      const last = data[data.length - 1];
      candle.update(toCandle(last));
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

    (async () => {
      try {
        const { bars, status, message } = await loadFeed(symbol, timeframe);
        if (disposed) return;
        barsRef.current = bars;
        applyBarsToSeries("set");
        applyMarkers();
        updateLegend(null);
        canvasRef.current?.redraw();
        chartRef.current?.timeScale().scrollToRealTime();
        setLoaded({ status, message });

        unsub = subscribeFeed(symbol, timeframe, ({ lastBar }) => {
          barsRef.current = upsertLocal(barsRef.current, lastBar);
          applyBarsToSeries("update");
          updateLegend(null);
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
        layout: { background: { type: ColorType.Solid, color: PANE_BG }, textColor: COLORS.text, fontSize: 10 },
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
        syncingRef.current = true;
        try { mainChart.timeScale().setVisibleLogicalRange(range as any); } catch { /* race */ } finally { syncingRef.current = false; }
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange((r) => syncHandler(r ? { from: r.from, to: r.to } : null));
      const crossHandler = (param: MouseEventParamsLite) => {
        if (syncingRef.current) return;
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
        } finally { syncingRef.current = false; }
      };
      chart.subscribeCrosshairMove((param: any) => {
        if (syncingRef.current) return;
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
        } finally { syncingRef.current = false; }
      });
      paneRef.current.set(cfg.id, { chart, container: host, series, syncHandler, crossHandler });
      if (barsRef.current.length) applyBarsToSeries("set");
      // panes follow the main range
      const r = mainChart.timeScale().getVisibleLogicalRange();
      if (r) { try { chart.timeScale().setVisibleLogicalRange(r); } catch { /* race */ } }
    }
    // exactly the bottom-most pane shows the time axis
    const lastId = subList[subList.length - 1]?.id;
    for (const [id, pane] of paneRef.current) {
      pane.chart.applyOptions({ timeScale: { visible: id === lastId } });
    }
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

  // ---- pending-order price lines ------------------------------------------------
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    for (const line of lineHandlesRef.current) {
      try { candle.removePriceLine(line); } catch { /* series gone */ }
    }
    lineHandlesRef.current = [];
    for (const m of marks) {
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
  }, [marks]);

  // ---- trade lines (positions) ---------------------------------------------------
  const tradeLines = useMemo<TradeLine[]>(() => {
    const out: TradeLine[] = [];
    for (const p of positions) {
      const color = p.side === "buy" ? "#3b82f6" : "#f97316";
      out.push({ positionId: p.id, kind: "entry", price: p.entry, color, label: `${p.side === "buy" ? "BUY" : "SELL"} ${p.lots}`, digits });
      if (p.sl) out.push({ positionId: p.id, kind: "sl", price: p.sl, color: "#ef4444", label: "SL", digits });
      if (p.tp) out.push({ positionId: p.id, kind: "tp", price: p.tp, color: "#22c55e", label: "TP", digits });
    }
    return out;
  }, [positions, digits]);

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
    setDrawings(next);
    if (uid) saveDrawings(uid, symbolRef.current, next);
  }, [uid]);

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
    let html = `<span class="font-bold text-slate-200">${symbolRef.current}</span> · ${timeframeRef.current.toUpperCase()} <span class="text-slate-500">O</span> <span class="font-number ${cls}">${fmt(b.open)}</span> <span class="text-slate-500">H</span> <span class="font-number ${cls}">${fmt(b.high)}</span> <span class="text-slate-500">L</span> <span class="font-number ${cls}">${fmt(b.low)}</span> <span class="text-slate-500">C</span> <span class="font-number ${cls}">${fmt(b.close)}</span> <span class="font-number ${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>`;
    if (b.volume) html += ` <span class="text-slate-500">Vol</span> <span class="font-number text-slate-400">${compactNum(b.volume)}</span>`;
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
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // ---- keyboard tool shortcuts --------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const map: Record<string, DrawingType> = { t: "trend", h: "hline", v: "vline", r: "rect", f: "fib-retracement", x: "text", p: "channel", e: "fib-extension" };
      const k = map[e.key.toLowerCase()];
      if (k) { setActiveTool(k); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const statusChip = loaded.status !== "error" && (
    <div className="absolute left-2 top-8 z-10 flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300 backdrop-blur">
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          loaded.status === "live" && "bg-emerald-400",
          loaded.status === "polling" && "bg-amber-400",
          loaded.status === "connecting" && "bg-sky-400 animate-pulse",
        )}
      />
      {loaded.status === "live" && "LIVE"}
      {loaded.status === "polling" && (loaded.message || "POLL")}
      {loaded.status === "connecting" && "Loading…"}
    </div>
  );

  return (
    <div ref={wrapperRef} className={cn("relative flex h-full w-full min-h-0 flex-col bg-[#0b1220]", className)} style={height ? { height } : undefined}>
      <ChartToolbar
        activeTool={activeTool}
        onToolSelect={(t) => setActiveTool((cur) => (cur === t ? "cursor" : t))}
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
        onClearDrawings={() => { commitDrawings([]); setSelectedDrawingId(null); if (uid) clearDrawingsRemote(uid, symbolRef.current); }}
        drawingsCount={drawings.length}
      />

      <div className="relative min-h-0 flex-1">
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
          drawings={drawings}
          onChange={commitDrawings}
          activeTool={activeTool === "cursor" ? null : activeTool}
          onToolCommitted={() => setActiveTool("cursor")}
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
            setContextMenu({ clientX, clientY, x: clientX, y: clientY, hitDrawingId: hitId, time, price });
          }}
          tradeLines={tradeLines}
          onTradeLineMove={handleTradeLineMove}
        />

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
