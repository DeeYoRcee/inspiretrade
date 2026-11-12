/**
 * DEV-ONLY visual test harness for TerminalChart (not part of the app bundle;
 * served manually via `vite dev` at /chart-harness.html). Feeds the chart
 * REAL Binance BTCUSD data (public, no auth) plus one overlay + one pane
 * indicator, so rendering, resizing, indicators and drawing overlay can be
 * verified in a real browser.
 */
import { createRoot } from "react-dom/client";
import "@/index.css"; // real app styles (Tailwind) — mandatory for layout classes
import { TerminalChart, DEFAULT_COLORS } from "@/components/terminal/TerminalChart";
import type { Drawing } from "@/lib/terminal/drawings";

function Harness() {
  const drawings: Drawing[] = [];
  // ?tool=trendline|fib|fibext|channel|rect|measure… — activate a drawing tool
  const tool = (new URLSearchParams(location.search).get("tool") ?? "cursor") as any;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, boxSizing: "border-box", gap: 10 }}>
      <div style={{ color: "#9aa4b2", fontSize: 12 }}>
        Chart harness — BTCUSD (live Binance) · 15m · EMA overlay + RSI pane + volume · tool={tool}
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
          colors={DEFAULT_COLORS}
          drawings={drawings}
          onDrawingsChange={() => {}}
          activeTool={tool}
          height={600}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
