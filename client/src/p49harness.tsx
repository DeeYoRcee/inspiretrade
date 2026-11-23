/**
 * Dev-only P49 latency harness (never shipped): measures the REAL feed→chart
 * pipeline latency for (a) BTCUSD M1 — Binance WS, live 24/7, and (b) XAUUSD
 * M1 — gold-api 1s poller, plus the raw provider-stamp staleness. Weekend
 * note: gold spot is closed Sun<22:00 UTC — the honest gate keeps candles
 * frozen; the pipeline mechanics are still fully observable.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadFeed, subscribeFeed, getSpotState } from "@/lib/market-data";
import "./index.css";

function Harness() {
  const [log, setLog] = useState<string[]>(["boot"]);
  const push = (m: string) => setLog((p) => [...p.slice(-11), m]);
  const stats = useRef({ binTicks: 0, binLatSum: 0, binLatMax: 0, xauTicks: 0, xauStampLagSum: 0, xauStampLagMax: 0, distinct: 0, gapSum: 0, gapMax: 0, lastDistinctAt: 0 });

  useEffect(() => {
    void (async () => {
      // ---- BTCUSD M1: load + subscribe, measure tick → subscriber latency
      const btc = await loadFeed("BTCUSD", "1m");
      push(`BTCUSD load: ${btc.bars.length} bars, last ${new Date((btc.bars.at(-1)?.time ?? 0) * 1000).toISOString()}`);
      let prevClose = 0;
      const offB = subscribeFeed("BTCUSD", "1m", (u) => {
        const st = stats.current;
        st.binTicks++;
        // P49 metric: how fresh is the painted candle vs the wall clock
        // (bucket start must be the CURRENT minute while live), plus the
        // inter-arrival gap between DISTINCT price updates (tick cadence).
        const nowSec = Math.floor(Date.now() / 1000);
        const age = nowSec - (u.lastBar?.time ?? 0);
        st.binLatSum += age; st.binLatMax = Math.max(st.binLatMax, age);
        if (u.lastBar?.close && u.lastBar.close !== prevClose) {
          const gap = prevClose ? Date.now() - st.lastDistinctAt : 0;
          if (gap > 0) { st.distinct++; st.gapSum += gap; st.gapMax = Math.max(st.gapMax, gap); }
          prevClose = u.lastBar.close; st.lastDistinctAt = Date.now();
        }
      });
      push(`BTCUSD subscribed (off=${typeof offB})`);

      // ---- XAUUSD M1: pipeline mechanics (market closed on Sun < 22:00 UTC)
      const xau = await loadFeed("XAUUSD", "1m");
      push(`XAUUSD load: ${xau.bars.length} bars, last ${new Date((xau.bars.at(-1)?.time ?? 0) * 1000).toISOString()}, delay ${xau.delaySec ?? "-"}s`);
      const offX = subscribeFeed("XAUUSD", "1m", (u) => {
        const st = stats.current;
        st.xauTicks++;
        const delay = getSpotState().providerDelaySec;
        if (delay != null) { st.xauStampLagSum += delay; st.xauStampLagMax = Math.max(st.xauStampLagMax, delay); }
      });
      push(`XAUUSD subscribed (off=${typeof offX})`);

      // periodic report
      const rep = setInterval(() => {
        const st = stats.current;
        const s = getSpotState();
        push(`t=${Math.floor(Date.now() / 1000) % 1000} bin=${st.binTicks} candleAgeAvg=${st.binTicks ? Math.round(st.binLatSum / st.binTicks) : "-"}s max=${st.binLatMax}s distinctUpd=${st.distinct} gapAvg=${st.distinct ? Math.round(st.gapSum / st.distinct) : "-"}ms max=${st.gapMax}ms | xau=${st.xauTicks} stampLag=${st.xauTicks ? Math.round(st.xauStampLagSum / st.xauTicks) : "-"}s max=${st.xauStampLagMax}s spot=${s.state}`);
      }, 15000);
      return () => { clearInterval(rep); offB(); offX(); };
    })();
  }, []);

  return (
    <div className="p-3 text-xs text-slate-300" data-testid="p49">
      <h1 className="mb-2 text-sm font-bold">P49 feed-latency harness</h1>
      <div id="log" className="space-y-1 font-mono text-[11px] text-emerald-300">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
