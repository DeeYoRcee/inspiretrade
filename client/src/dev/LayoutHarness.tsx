/**
 * DEV-ONLY harness replicating the EXACT TerminalPage layout chain (the
 * "blank chart" bug): flex row workspace + md:flex chart wrapper + h-full
 * grid. Verifies the production fix renders charts with real height.
 */
import { createRoot } from "react-dom/client";
import "@/index.css";
import { TerminalChart, DEFAULT_COLORS } from "@/components/terminal/TerminalChart";
import type { Drawing, DrawingTool } from "@/lib/terminal/drawings";

function Harness() {
  const drawings: Drawing[] = [];
  const chart = (sym: string) => (
    <TerminalChart
      symbol={sym}
      timeframe="1h"
      chartType="candles"
      indicators={[{ id: "rsi", params: { period: 14 } }]}
      showVolume
      colors={DEFAULT_COLORS}
      drawings={drawings}
      onDrawingsChange={() => {}}
      activeTool={"cursor" as DrawingTool}
      height={420}
    />
  );
  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[520px] flex-col gap-1.5">
      <div className="flex min-h-0 flex-1 gap-1.5">
        {/* drawing toolbar */}
        <div className="flex w-11 shrink-0 flex-col items-center rounded-xl border border-border/50 bg-card/60 py-1.5" />
        {/* charts (desktop) — the fixed wrapper */}
        <div className="hidden min-h-0 min-w-0 flex-1 md:flex md:flex-col">
          <div className="grid h-full min-h-0 w-full flex-1 gap-1.5 grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
            {chart("BTCUSD")}
            {chart("ETHUSD")}
          </div>
        </div>
        {/* side panel */}
        <div className="hidden w-80 shrink-0 md:block">
          <div className="h-full rounded-xl border border-border/50 bg-card/60" />
        </div>
      </div>
      <div className="hidden h-40 shrink-0 rounded-xl border border-border/50 bg-card/60 md:block" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
