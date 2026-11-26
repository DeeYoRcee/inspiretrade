/**
 * Dev-only render harness (never shipped — vite build input is index.html
 * only): mounts the REAL PriceChart unauthenticated so UI changes can be
 * verified in a headless browser — bottom TF bar, hidden status badge, no
 * admin diagnostics, grid default off, General settings gear. Feeds are the
 * live production ones (real data only, no mocks).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PriceChart } from "@/components/terminal/PriceChart";
import type { Timeframe } from "@shared/terminal";
import "./index.css";

function Harness() {
  const [symbol, setSymbol] = useState("BTCUSD");
  const [tf, setTf] = useState<Timeframe>("1h");
  return (
    <div className="h-[100dvh] w-full">
      <PriceChart
        symbol={symbol}
        timeframe={tf}
        marks={[]}
        accountId={null}
        positions={[]}
        onModifyPosition={async () => undefined}
        onSymbolChange={setSymbol}
        onTimeframeChange={setTf}
        height={640}
      />
      <div id="harness-state" data-symbol={symbol} data-tf={tf} className="p-2 text-xs text-slate-400">
        state: {symbol} @ {tf}
      </div>
    </div>
  );
}

// P78 — ChartToolbar's VIP gating (usePremiumStatus) needs react-query:
// wrap the harness so the real PriceChart mounts without the auth gate
const harnessQc = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={harnessQc}>
    <Harness />
  </QueryClientProvider>,
);
