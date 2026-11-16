/**
 * PriceChart — clean TradingView Lightweight Charts wrapper (the old
 * 1,361-line TerminalChart monolith is deleted; this is the replacement).
 *
 * Responsibilities, deliberately few:
 *  - render REAL candles + volume for one symbol/timeframe (no generated data)
 *  - stream live updates from lib/market-data and publish each tick to the
 *    shared price-store (panels read prices from there, never from chart state)
 *  - draw horizontal price lines for the account's live positions
 *    (entry / SL / TP) — nothing else, no drawings, no indicators, no replay
 *
 * On feed failure it shows an error state with a retry button; it NEVER falls
 * back to synthetic candles.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, CrosshairMode, LineStyle, } from "lightweight-charts";
import { loadFeed, subscribeFeed } from "@/lib/market-data";
import { getInstrument } from "@shared/terminal";
import { priceBusUpdate } from "@/lib/price-store";
import { cn } from "@/lib/utils";
const COLORS = {
    bg: "#0b1220",
    text: "#94a3b8",
    grid: "#1e293b",
    up: "#22c55e",
    down: "#ef4444",
    accent: "#3b82f6",
};
export function PriceChart({ symbol, timeframe, marks, className, height, }) {
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const candleRef = useRef(null);
    const volumeRef = useRef(null);
    const lineHandlesRef = useRef([]);
    const [loaded, setLoaded] = useState({ status: "connecting" });
    const [reloadKey, setReloadKey] = useState(0);
    const inst = useMemo(() => getInstrument(symbol), [symbol]);
    const priceFormat = useMemo(() => ({ type: "price", precision: inst?.digits ?? 2, minMove: Math.pow(10, -(inst?.digits ?? 2)) }), [inst]);
    // ---- create the chart once ---------------------------------------------
    useEffect(() => {
        const el = containerRef.current;
        if (!el)
            return;
        const chart = createChart(el, {
            autoSize: true,
            layout: { background: { type: ColorType.Solid, color: COLORS.bg }, textColor: COLORS.text },
            grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
            crosshair: { mode: CrosshairMode.Normal },
            rightPriceScale: { borderVisible: false },
            timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        });
        const candles = chart.addCandlestickSeries({
            upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
            wickUpColor: COLORS.up, wickDownColor: COLORS.down,
        });
        const volume = chart.addHistogramSeries({
            priceScaleId: "vol",
            priceFormat: { type: "volume" },
            lastValueVisible: false,
            priceLineVisible: false,
        });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        chartRef.current = chart;
        candleRef.current = candles;
        volumeRef.current = volume;
        return () => {
            chart.remove();
            chartRef.current = null;
            candleRef.current = null;
            volumeRef.current = null;
            lineHandlesRef.current = [];
        };
    }, []);
    // ---- load history + subscribe to live updates ----------------------------
    useEffect(() => {
        let disposed = false;
        let unsub = null;
        setLoaded({ status: "connecting" });
        (async () => {
            try {
                const { bars, status, message } = await loadFeed(symbol, timeframe);
                if (disposed)
                    return;
                applyBars(bars);
                setLoaded({ status, message });
                unsub = subscribeFeed(symbol, timeframe, ({ lastBar }) => {
                    candleRef.current?.update(toCandle(lastBar));
                    volumeRef.current?.update(toVolume(lastBar));
                    priceBusUpdate(symbol, lastBar.close); // panels read live prices from the store
                });
            }
            catch (e) {
                if (disposed)
                    return;
                setLoaded({ status: "error", error: String(e?.message || e) });
            }
        })();
        function applyBars(bars) {
            candleRef.current?.applyOptions({ priceFormat });
            candleRef.current?.setData(bars.map(toCandle));
            volumeRef.current?.setData(bars.map(toVolume));
            if (bars.length) {
                priceBusUpdate(symbol, bars[bars.length - 1].close);
                chartRef.current?.timeScale().fitContent();
                chartRef.current?.timeScale().scrollToRealTime();
            }
        }
        return () => {
            disposed = true;
            unsub?.();
        };
        // priceFormat is derived from symbol — safe to omit from deps
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbol, timeframe, reloadKey]);
    // ---- position price lines ------------------------------------------------
    useEffect(() => {
        const candles = candleRef.current;
        if (!candles)
            return;
        for (const line of lineHandlesRef.current) {
            try {
                candles.removePriceLine(line);
            }
            catch { /* series already gone */ }
        }
        lineHandlesRef.current = [];
        for (const m of marks) {
            if (!Number.isFinite(m.price) || m.price <= 0)
                continue;
            lineHandlesRef.current.push(candles.createPriceLine({
                price: m.price,
                color: m.color,
                lineWidth: 1,
                lineStyle: m.dashed ? LineStyle.Dashed : LineStyle.Solid,
                axisLabelVisible: true,
                title: m.title,
            }));
        }
    }, [marks]);
    return (<div className={cn("relative h-full w-full min-h-0", className)} style={height ? { height } : undefined}>
      <div ref={containerRef} className="h-full w-full"/>
      {loaded.status !== "error" && (<div className="absolute left-2 top-2 z-10 flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300 backdrop-blur">
          <span className={cn("inline-block h-2 w-2 rounded-full", loaded.status === "live" && "bg-emerald-400", loaded.status === "polling" && "bg-amber-400", loaded.status === "connecting" && "bg-sky-400 animate-pulse")}/>
          {loaded.status === "live" && "LIVE"}
          {loaded.status === "polling" && (loaded.message || "POLL")}
          {loaded.status === "connecting" && "Loading…"}
        </div>)}
      {loaded.status === "error" && (<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950/80 text-center">
          <p className="max-w-md text-sm text-slate-300">
            Market data unavailable{loaded.error ? `: ${loaded.error}` : ""}. No fake prices are ever shown — retry instead.
          </p>
          <button onClick={() => setReloadKey((k) => k + 1)} className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
            Retry
          </button>
        </div>)}
    </div>);
}
// ---------------------------------------------------------------------------
// Bar → LWC mappers
// ---------------------------------------------------------------------------
function toCandle(b) {
    return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
}
function toVolume(b) {
    const up = b.close >= b.open;
    return {
        time: b.time,
        value: b.volume ?? 0,
        color: up ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
    };
}
