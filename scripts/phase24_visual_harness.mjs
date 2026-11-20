/**
 * PHASE 24 §9 — visual harness page generator (dev-only artifact, never
 * shipped): renders REAL provider data through lightweight-charts with the
 * terminal's EXACT series configuration, so the rendered candle appearance —
 * the thing §3/§9 demand — is inspected on genuine OHLC.
 * Panels: EURUSD M1/M5 before-vs-after · BTCUSDT seconds (Bug 2 fix).
 * open → client/visual-harness/index.html
 */
import { readFileSync, writeFileSync } from "node:fs";
const data = readFileSync("client/visual-harness/harness-data.json", "utf8");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PHASE 24 visual audit — real provider data, terminal series config</title>
<script src="file:///home/z/my-project/InspireTrade/node_modules/lightweight-charts/dist/lightweight-charts.standalone.development.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1220; color: #e2e8f0; font: 13px/1.4 Inter, system-ui, sans-serif; }
  header { padding: 12px 16px; border-bottom: 1px solid #1e293b; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .sub { color: #94a3b8; font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; padding: 12px; }
  .card { border: 1px solid #1e293b; border-radius: 8px; background: #0d1526; overflow: hidden; }
  .card h2 { font-size: 12px; margin: 0; padding: 8px 10px; border-bottom: 1px solid #1e293b; color: #cbd5e1; font-weight: 600; }
  .chart { height: 240px; }
  .tag { float: right; font-weight: 400; padding: 1px 7px; border-radius: 999px; font-size: 10px; }
  .bad { background: #7f1d1d55; color: #fca5a5; }
  .good { background: #14532d55; color: #86efac; }
  @media (max-width: 640px) { .chart { height: 200px; } }
</style>
</head>
<body>
<header>
  <h1>PHASE 24 — rendered-candle visual audit <span class="tag good">REAL provider data</span></h1>
  <div class="sub">EURUSD: Dukascopy BID_candles_min_1 (2026-11-12, point×1e5) decoded and run through the terminal's real pipeline (validateBars → alignAndDedupe → aggregateBars).
  BTCUSDT: Binance native 1s klines → aggregateToSeconds (15s/30s). "BEFORE" panels reproduce the diagnosed defect: Yahoo close-only 1m (O=H=L=C, verified 6712/6712 flat, Phase 20) rendered exactly as the chart drew it. Series config = PriceChart.tsx (#0b1220 canvas, digits-precision price format).</div>
</header>
<div class="grid" id="grid"></div>
<script>
const LWC = window.LightweightCharts;
const D = ${data};

const panels = [
  { title: "EURUSD M1 — BEFORE (Yahoo close-only dots)", key: "eurusdM1Before", digits: 5, tag: "bad" },
  { title: "EURUSD M1 — AFTER (Dukascopy genuine OHLC)", key: "eurusdM1After", digits: 5, tag: "good" },
  { title: "EURUSD M5 — BEFORE (flat aggregates of close-only)", key: "eurusdM5Before", digits: 5, tag: "bad" },
  { title: "EURUSD M5 — AFTER (genuine m1 → aggregateBars)", key: "eurusdM5After", digits: 5, tag: "good" },
  { title: "BTCUSDT 15S — seconds TFs fixed (native 1s → aggregateToSeconds)", key: "btc15s", digits: 2, tag: "good" },
  { title: "BTCUSDT 30S — seconds TFs fixed", key: "btc30s", digits: 2, tag: "good" },
];

const grid = document.getElementById("grid");
for (const p of panels) {
  const bars = D[p.key] || [];
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = \`<h2>\${p.title} <span class="tag \${p.tag}">\${bars.length} bars</span></h2><div class="chart"></div>\`;
  grid.appendChild(card);
  const host = card.querySelector(".chart");
  const chart = LWC.createChart(host, {
    autoSize: true,
    layout: { background: { type: "solid", color: "#0b1220" }, textColor: "#94a3b8", fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: "#16213a" }, horzLines: { color: "#16213a" } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: p.key.startsWith("btc"), rightOffset: 6 },
  });
  // v4 API — the SAME call PriceChart.tsx uses (line 114)
  const series = chart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#ef4444", borderUpColor: "#22c55e", borderDownColor: "#ef4444",
    wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    priceFormat: { type: "price", precision: p.digits, minMove: Math.pow(10, -p.digits) },
  });
  series.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  chart.timeScale().fitContent();
}
</script>
</body>
</html>`;
writeFileSync("client/visual-harness/index.html", html);
console.log("harness → client/visual-harness/index.html");
