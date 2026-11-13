/**
 * DEV-ONLY visual test harness for TerminalChart (not part of the app bundle;
 * served manually via `vite dev` at /chart-harness.html). Feeds the chart
 * REAL Binance BTCUSD data (public, no auth) plus one overlay + one pane
 * indicator, so rendering, resizing, indicators and drawing overlay can be
 * verified in a real browser.
 */
import { createRoot } from "react-dom/client";
import "@/index.css"; // real app styles (Tailwind) — mandatory for layout classes
import { TerminalChart, DEFAULT_COLORS, CHART_THEMES } from "@/components/terminal/TerminalChart";
import type { Drawing } from "@/lib/terminal/drawings";

function Harness() {
  const drawings: Drawing[] = [];
  const params = new URLSearchParams(location.search);
  // ?tool=trendline|fib|fibext|channel|rect|measure… — activate a drawing tool
  const tool = (params.get("tool") ?? "cursor") as any;
  // ?replay=200 — bar replay mode showing the first 200 real bars
  const replayN = Number(params.get("replay") ?? 0) || null;
  // ?overlay=1 — session boxes + prev day/week levels + volume profile
  const overlay = params.has("overlay");
  // ?theme=paper|tvdark|nord|carbon|ocean — chart theme preset
  const colors = CHART_THEMES.find((th) => th.id === params.get("theme"))?.colors ?? DEFAULT_COLORS;
  // ?scale=log|percent — price scale mode; ?magnet=1 — magnet crosshair
  const scale = (params.get("scale") ?? "normal") as "normal" | "log" | "percent";
  const magnet = params.has("magnet");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, boxSizing: "border-box", gap: 10 }}>
      <div style={{ color: "#9aa4b2", fontSize: 12 }}>
        Chart harness — BTCUSD (live Binance) · 15m · EMA overlay + RSI pane + volume · tool={tool}{replayN ? ` · replay=${replayN}` : ""}{overlay ? " · overlay=on" : ""}{scale !== "normal" ? ` · scale=${scale}` : ""}{magnet ? " · magnet=on" : ""}
      </div>
      {/* definite height container mirrors the fixed terminal layout chain */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <TerminalChart
          symbol="BTCUSD"
          timeframe="15m"
          chartType="candles"
          indicators={[
            { id: "ema", params: { period: 20 }, color: "#60a5fa" },
            { id: "rsi", params: { period: 14 }, color: "#a78bfa" },
          ]}
          showVolume
          colors={colors}
          drawings={drawings}
          onDrawingsChange={() => {}}
          activeTool={tool}
          height={600}
          priceScaleMode={scale}
          magnet={magnet}
          replay={replayN ? { active: true, upToTime: Math.floor(Date.now() / 1000) - replayN * 900 } : null}
          tradeMarkers={replayN ? [
            { time: Math.floor(Date.now() / 1000) - (replayN + 30) * 900, side: "buy", kind: "entry" },
            { time: Math.floor(Date.now() / 1000) - (replayN + 10) * 900, side: "buy", kind: "exit", profit: 240 },
          ] : undefined}
          priceLines={replayN ? [
            { id: "pos", price: 74800, color: "#22c55e", title: "LONG 0.5", width: 2 },
            { id: "sl", price: 74200, color: "#ef4444", title: "SL", dashed: true },
            { id: "tp", price: 75800, color: "#22c55e", title: "TP", dashed: true },
            { id: "ord", price: 74500, color: "#f59e0b", title: "BUY LIMIT 0.2", dashed: true },
          ] : undefined}
          overlayCfg={overlay ? { sessions: ["london", "newyork"], prevLevels: { day: true, week: true }, volumeProfile: { mode: "visible", sessionId: "london", bins: 24, levels: true } } : null}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
