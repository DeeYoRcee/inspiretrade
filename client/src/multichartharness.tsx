/**
 * Dev-only multi-chart harness (never shipped): mounts the REAL
 * MultiChartWorkspace with two panels of REAL market data — verifies
 * layouts, resizable dividers, sync toggles and per-panel independence in a
 * headless browser.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MultiChartWorkspace } from "@/components/terminal/MultiChartWorkspace";
import type { Timeframe } from "@shared/terminal";
import "./index.css";

function Harness() {
  const [symbol, setSymbol] = useState("BTCUSD");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [log, setLog] = useState<string[]>(["boot"]);
  const push = (m: string) => setLog((p) => [...p.slice(-6), m]);

  return (
    <div className="flex h-[100dvh] w-full flex-col gap-1 p-1">
      <div className="flex items-center gap-2 text-xs">
        <button id="h-2h" onClick={() => { document.querySelector<HTMLButtonElement>('[title="Two horizontal"]')?.click(); push("layout 2h"); }} className="rounded bg-sky-600 px-2 py-1 text-white">2H</button>
        <button id="h-4" onClick={() => { document.querySelector<HTMLButtonElement>('[title="Four (2×2)"]')?.click(); push("layout 4"); }} className="rounded bg-sky-600 px-2 py-1 text-white">4</button>
        <button id="h-6" onClick={() => { document.querySelector<HTMLButtonElement>('[title="Six (2×3)"]')?.click(); push("layout 6"); }} className="rounded bg-sky-600 px-2 py-1 text-white">6</button>
        <button id="h-1" onClick={() => { document.querySelector<HTMLButtonElement>('[title="Single"]')?.click(); push("layout 1"); }} className="rounded bg-slate-700 px-2 py-1 text-white">1</button>
        <button id="h-xcross" onClick={() => { document.querySelector<HTMLButtonElement>('[title="Synchronize crosshair across panels"]')?.click(); push("sync crosshair"); }} className="rounded bg-slate-700 px-2 py-1 text-white">XSync</button>
        <button id="h-tsync" onClick={() => { document.querySelector<HTMLButtonElement>('[title="Synchronize time axis / visible range across panels"]')?.click(); push("sync time"); }} className="rounded bg-slate-700 px-2 py-1 text-white">TSync</button>
        <span data-testid="sym">{symbol}@{tf}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-slate-800 bg-[#0b1220]">
        <MultiChartWorkspace
          symbol={symbol}
          timeframe={tf}
          onSymbolChange={(s) => { setSymbol(s); push(`primary symbol → ${s}`); }}
          onTimeframeChange={(t) => { setTf(t); push(`primary tf → ${t}`); }}
          orders={[]}
          positions={[]}
          accountId={null}
          onModifyPosition={async () => undefined}
          accountBalance={100000}
          onOpenAlerts={() => push("alerts")}
          onOpenReplay={() => push("replay")}
        />
      </div>
      <div id="log" className="text-[10px] text-slate-500">{log.join(" | ")}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
