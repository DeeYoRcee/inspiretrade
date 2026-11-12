/**
 * TerminalChart — one chart slot of the InspireTrade Terminal.
 *
 * Wraps TradingView Lightweight Charts (Apache-2.0, npm `lightweight-charts`)
 * — the open-source library, NOT TradingView's proprietary Advanced Charts —
 * with: 8 chart types (candles/hollow/bars/line/area/baseline/Heikin-Ashi/
 * Renko), overlay + pane indicators, a drawing-tools canvas overlay, volume
 * histogram, crosshair OHLC legend and live/polling/demo data feeds.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type MouseEventParams,
} from "lightweight-charts";
import { getInstrument, toHeikinAshi, toRenko, type Bar, type ChartType, type Timeframe } from "@shared/terminal";
import { loadFeed, subscribeFeed, type FeedStatus } from "@/lib/terminal/data-feeds";
import { getIndicator, INDICATORS, type Line } from "@/lib/terminal/indicators";
import { DrawingEngine, type Drawing, type DrawingTool } from "@/lib/terminal/drawings";
import { drawingsBus } from "@/lib/terminal/drawings-bus";

export interface ActiveIndicator { id: string; params: Record<string, number>; }

export interface ChartColors {
  up: string; down: string; accent: string; grid: string; bg: string; text: string;
}

export const DEFAULT_COLORS: ChartColors = {
  up: "#22c55e", down: "#ef4444", accent: "#22c55e",
  grid: "rgba(42, 46, 54, 0.5)", bg: "#0b0e13", text: "#9aa4b2",
};

const PALETTE = ["#4ade80", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#f87171", "#34d399"];

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
  onLegend?: (v: { o: number; h: number; l: number; c: number; prevClose: number } | null) => void;
  height?: number;
  compact?: boolean;
}

export function TerminalChart({
  symbol, timeframe, chartType, indicators, showVolume, colors,
  drawings, onDrawingsChange, activeTool, onStatus, onLastBar, onLegend, height, compact,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<HTMLDivElement[]>([]);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayRefs = useRef<ISeriesApi<"Line">[]>([]);
  const paneChartsRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Line" | "Histogram">[] }[]>([]);
  const engineRef = useRef<DrawingEngine | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);
  const syncingRef = useRef(false);
  const lastEmittedRef = useRef<string>("[]");

  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const [feedMsg, setFeedMsg] = useState<string | undefined>();
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number } | null>(null);

  const inst = getInstrument(symbol);

  // indicator pane count changes → recreate sub-charts
  const paneDefs = useMemo(
    () => indicators.map((a) => getIndicator(a.id)).filter((d): d is NonNullable<typeof d> => !!d && d.placement === "pane"),
    [indicators],
  );

  // ---- create/destroy chart -------------------------------------------------

  useEffect(() => {
    if (!mainRef.current) return;
    const common = (extra?: object) => ({
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        fontSize: compact ? 10 : 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Solid },
        horzLines: { color: colors.grid, style: LineStyle.Solid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(154,164,178,0.4)", labelBackgroundColor: "#1f2937" },
        horzLine: { color: "rgba(154,164,178,0.4)", labelBackgroundColor: "#1f2937" },
      },
      rightPriceScale: { borderColor: "rgba(42,46,54,0.8)" },
      timeScale: {
        borderColor: "rgba(42,46,54,0.8)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: compact ? 4 : 8,
      },
      ...extra,
    });

    const chart = createChart(mainRef.current, common());
    chartRef.current = chart;

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (!seriesRef.current) return;
      const bar = param.seriesData.get(seriesRef.current) as any;
      if (bar && bar.close != null) {
        setLegend({ o: bar.open, h: bar.high, l: bar.low, c: bar.close });
        onLegend?.({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, prevClose: barsRef.current[0]?.open ?? bar.open });
      }
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

    // keep drawing overlay in sync with visible range changes
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => engineRef.current?.redraw());

    return () => {
      unsubBus();
      unsubRef.current?.();
      unsubRef.current = null;
      engineRef.current?.destroy();
      engineRef.current = null;
      paneChartsRef.current.forEach((p) => p.chart.remove());
      paneChartsRef.current = [];
      overlayRefs.current = [];
      volSeriesRef.current = null;
      seriesRef.current = null;
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- theme updates ---------------------------------------------------------

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    });
  }, [colors]);

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

  // ---- data loading ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setFeedStatus("connecting");
    setFeedMsg(undefined);
    barsRef.current = [];

    (async () => {
      const res = await loadFeed(symbol, timeframe);
      if (cancelled) return;
      barsRef.current = res.bars;
      setFeedStatus(res.status);
      setFeedMsg(res.message);
      onStatus?.(res.status, res.message);
      renderData();
      startLive();
    })();

    function startLive() {
      unsubRef.current?.();
      unsubRef.current = subscribeFeed(symbol, timeframe, (u) => {
        barsRef.current = u.bars;
        applyLastBar(u.lastBar);
        onLastBar?.(u.lastBar);
        recomputeIndicators();
      });
    }

    function applyLastBar(bar: Bar) {
      const s = seriesRef.current;
      if (!s) return;
      const t = bar.time as UTCTimestamp;
      if (chartType === "line" || chartType === "area" || chartType === "baseline") {
        (s as unknown as ISeriesApi<"Line">).update({ time: t, value: bar.close });
      } else {
        (s as ISeriesApi<"Candlestick">).update({ time: t, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      }
      if (volSeriesRef.current && bar.volume != null) {
        volSeriesRef.current.update({
          time: t, value: bar.volume,
          color: bar.close >= bar.open ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
        });
      }
      engineRef.current?.redraw();
    }

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  // ---- (re)build series when type/indicators/volume change ----------------------

  function displayBars(): Bar[] {
    const bars = barsRef.current;
    if (chartType === "heikin") return toHeikinAshi(bars);
    if (chartType === "renko") return toRenko(bars);
    return bars;
  }

  function renderData() {
    const chart = chartRef.current;
    if (!chart) return;
    const inst2 = getInstrument(symbol);
    const precision = inst2?.digits ?? 2;
    const minMove = Number((1 / Math.pow(10, precision)).toFixed(precision));
    const priceFormat = { type: "price" as const, precision, minMove };

    // remove old series
    try { chart.removeSeries(seriesRef.current!); } catch { /* not yet created */ }
    seriesRef.current = null;
    if (volSeriesRef.current) { try { chart.removeSeries(volSeriesRef.current); } catch {} volSeriesRef.current = null; }
    for (const s of overlayRefs.current) { try { chart.removeSeries(s); } catch {} }
    overlayRefs.current = [];

    const bars = displayBars();
    const t = (b: Bar) => b.time as UTCTimestamp;
    let s: ISeriesApi<"Candlestick">;

    switch (chartType) {
      case "line":
        s = chart.addLineSeries({ color: colors.accent, lineWidth: 2, priceFormat }) as unknown as ISeriesApi<"Candlestick">;
        (s as unknown as ISeriesApi<"Line">).setData(bars.map((b) => ({ time: t(b), value: b.close })));
        break;
      case "area":
        s = chart.addAreaSeries({
          lineColor: colors.accent, topColor: "rgba(34,197,94,0.28)", bottomColor: "rgba(34,197,94,0.02)",
          lineWidth: 2, priceFormat,
        }) as unknown as ISeriesApi<"Candlestick">;
        (s as unknown as ISeriesApi<"Area">).setData(bars.map((b) => ({ time: t(b), value: b.close })));
        break;
      case "baseline":
        s = chart.addBaselineSeries({
          baseValue: { type: "price", price: bars.length ? bars[Math.floor(bars.length / 2)].close : 0 },
          topLineColor: colors.up, topFillColor1: "rgba(34,197,94,0.28)", topFillColor2: "rgba(34,197,94,0.05)",
          bottomLineColor: colors.down, bottomFillColor1: "rgba(239,68,68,0.05)", bottomFillColor2: "rgba(239,68,68,0.28)",
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

    // volume overlay (bottom 18%)
    if (showVolume) {
      const v = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      v.setData(bars.filter((b) => b.volume != null).map((b) => ({
        time: t(b), value: b.volume!,
        color: b.close >= b.open ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
      })));
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeriesRef.current = v;
    }

    // overlay indicators (on price)
    for (let i = 0; i < indicators.length; i++) {
      const def = getIndicator(indicators[i].id);
      if (!def || def.placement !== "overlay") continue;
      const named = def.compute(bars, { ...def.defaults, ...indicators[i].params });
      for (const nl of named) {
        const color = PALETTE[(overlayRefs.current.length + i) % PALETTE.length];
        const ls = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        ls.setData(nl.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
        overlayRefs.current.push(ls);
      }
    }

    recomputePaneIndicators();
    engineRef.current?.redraw();
  }

  function recomputeIndicators() {
    // cheap live path: overlay/pane series update with the new last bar
    renderData();
  }

  // ---- pane indicators (separate synced sub-charts) ------------------------------

  useEffect(() => {
    renderData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType, indicators, showVolume, barsRef.current.length]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // sync pane charts with the main chart's visible range
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
    // destroy old pane charts
    for (const p of paneChartsRef.current) { try { p.chart.remove(); } catch {} }
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
        height: h,
        layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 10, attributionLogo: false },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: "rgba(42,46,54,0.8)" },
        timeScale: { borderColor: "rgba(42,46,54,0.8)", timeVisible: true, secondsVisible: false, visible: true },
        crosshair: { mode: CrosshairMode.Normal },
      });
      const act = indicators.find((a) => a.id === def.id)!;
      const named = def.compute(bars, { ...def.defaults, ...act.params });
      const series: ISeriesApi<"Line" | "Histogram">[] = [];
      for (let i = 0; i < named.length; i++) {
        const nl = named[i];
        const color = nl.kind === "histogram"
          ? undefined
          : PALETTE[(i + 1) % PALETTE.length];
        if (nl.kind === "histogram") {
          const hs = sub.addHistogramSeries({ priceFormat: { type: "volume" }, color: "rgba(96,165,250,0.6)" });
          hs.setData(nl.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value, color: p.value >= 0 ? "rgba(34,197,94,0.6)" : "rgba(239,68,68,0.6)" })));
          series.push(hs);
        } else {
          const ls = sub.addLineSeries({ color: color ?? "#60a5fa", lineWidth: 1 });
          ls.setData(nl.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
          series.push(ls);
        }
      }
      paneChartsRef.current.push({ chart: sub, series });
    }
  }

  // pane container refs callback: when count changes, rebuild
  const setPaneRef = (el: HTMLDivElement | null, i: number) => {
    if (el) paneRefs.current[i] = el;
  };

  useEffect(() => {
    recomputePaneIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDefs]);

  // ---- legend / labels -----------------------------------------------------------

  const feedLabel =
    feedStatus === "live" ? "LIVE" :
    feedStatus === "polling" ? "DELAYED" :
    feedStatus === "demo" ? "DEMO" : "…";

  const feedColor =
    feedStatus === "live" ? "text-emerald-400" :
    feedStatus === "polling" ? "text-amber-400" :
    feedStatus === "demo" ? "text-orange-400" : "text-muted-foreground";

  const last = barsRef.current[barsRef.current.length - 1];
  const prev = barsRef.current[barsRef.current.length - 2] ?? last;
  const dayChange = last && prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const shown = legend ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close } : null);
  const legChange = shown && prev ? ((shown.c - prev.close) / prev.close) * 100 : 0;
  const d = inst?.digits ?? 2;

  return (
    <div ref={wrapRef} className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/50 bg-[#0b0e13]">
      {/* legend bar */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] leading-none text-muted-foreground">
        <span className="font-bold text-foreground">{symbol}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">{timeframe}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${feedColor}`}>{feedLabel}</span>
        {shown && (
          <span className="font-number hidden items-center gap-1.5 sm:flex">
            <span>O <b className="text-foreground">{shown.o?.toFixed(d)}</b></span>
            <span>H <b className="text-foreground">{shown.h?.toFixed(d)}</b></span>
            <span>L <b className="text-foreground">{shown.l?.toFixed(d)}</b></span>
            <span>C <b className={legChange >= 0 ? "text-emerald-400" : "text-red-400"}>{shown.c?.toFixed(d)}</b></span>
            <b className={legChange >= 0 ? "text-emerald-400" : "text-red-400"}>{legChange >= 0 ? "+" : ""}{legChange.toFixed(2)}%</b>
          </span>
        )}
        {last && <span className={`ml-auto font-number font-bold ${dayChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>{last.close.toFixed(d)} <span className="text-[10px] font-normal">({dayChange >= 0 ? "+" : ""}{dayChange.toFixed(2)}%)</span></span>}
      </div>
      {feedMsg && feedStatus === "demo" && (
        <div className="border-t border-orange-500/20 bg-orange-500/10 px-2.5 py-1 text-[10px] text-orange-300">⚠ {feedMsg}</div>
      )}
      {/* chart + panes + drawing layer */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={mainRef} className="absolute inset-0" />
          <canvas ref={drawCanvasRef} className="absolute inset-0 z-10" style={{ touchAction: "none" }} />
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
    </div>
  );
}
