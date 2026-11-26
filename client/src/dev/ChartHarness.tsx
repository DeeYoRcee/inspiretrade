/**
 * Dev-only chart harness (never shipped): mounts the REAL PriceChart on a
 * URL-chosen symbol/timeframe so the full market-data pipeline (feed load,
 * live spot ticker, recorded-spot assembly, tail painting) can be measured
 * in a real browser without the auth gate. /chart-harness.html?symbol=XAUUSD&tf=5m
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PriceChart } from "@/components/terminal/PriceChart";
import type { Timeframe } from "@shared/terminal";
import "../index.css";

const qs = new URLSearchParams(location.search);
const sym0 = (qs.get("symbol") || "XAUUSD").toUpperCase();
const tf0 = (qs.get("tf") || "5m") as Timeframe;

function ChartHarness() {
  const [symbol, setSymbol] = useState(sym0);
  const [tf, setTf] = useState<Timeframe>(tf0);
  const [log, setLog] = useState<string[]>(["boot"]);
  const push = (m: string) => setLog((p) => [...p.slice(-6), m]);

  return (
    <div className="flex h-[100dvh] w-full flex-col gap-1 p-1">
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => { setSymbol(symbol === "XAUUSD" ? "EURUSD" : "XAUUSD"); push("symbol swap"); }} className="rounded bg-sky-600 px-2 py-1 text-white">sym</button>
        <button onClick={() => { setTf(tf === "5m" ? "1m" : tf === "1m" ? "15m" : "5m"); push(`tf → ${tf}`); }} className="rounded bg-sky-600 px-2 py-1 text-white">tf</button>
        <span data-testid="sym">{symbol}@{tf}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-slate-800 bg-[#0b1220]">
        <PriceChart
          symbol={symbol}
          timeframe={tf}
          marks={[]}
          accountId={null}
          positions={[]}
          onModifyPosition={async () => undefined}
          onSymbolChange={(s) => { setSymbol(s); }}
          onTimeframeChange={(t) => { setTf(t); }}
        />
      </div>
      <div id="log" className="text-[10px] text-slate-500">{log.join(" | ")}</div>
    </div>
  );
}

// P78 — react-query provider required by PriceChart's VIP-gated toolbar
const harnessQc = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={harnessQc}>
    <ChartHarness />
  </QueryClientProvider>,
);
