/**
 * Sanity test for terminal indicator math + bar transforms.
 * Run: node scripts/test-terminal-math.mjs
 */
import { build } from "esbuild";
import { createRequire } from "module";

await build({
  entryPoints: ["scripts/_terminal-math-entry.ts"],
  bundle: true,
  format: "cjs",
  outfile: "/tmp/terminal-math.cjs",
  alias: { "@shared": "./shared", "@": "./client/src" },
  logLevel: "silent",
  external: ["firebase/*", "firebase", "react", "react-dom"],
});

const require2 = createRequire(import.meta.url);
const ind = require2("/tmp/terminal-math.cjs");

const bars = [];
let p = 100;
for (let i = 0; i < 120; i++) {
  const o = p, c = p * (1 + Math.sin(i / 7) * 0.01);
  bars.push({ time: 1700000000 + i * 60, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1000 + i });
  p = c;
}

const rsi = ind.rsi(bars, 14), macd = ind.macd(bars), adx = ind.adx(bars), st = ind.supertrend(bars), ich = ind.ichimoku(bars);
const rows = [
  ["rsi", rsi.length, rsi[rsi.length - 1]?.value.toFixed(1)],
  ["macd", macd.macd.length, macd.signal.length, macd.hist.length],
  ["adx", adx.adx.length, "psar", ind.parabolicSar(bars).length],
  ["bb", ind.bollinger(bars).upper.length, "keltner", ind.keltner(bars).upper.length, "donchian", ind.donchian(bars).lower.length],
  ["supertrend", st.line.length, "ichimoku A/B", ich.spanA.length, ich.spanB.length],
  ["heikin", ind.toHeikinAshi(bars).length, "renko", ind.toRenko(bars).length, "agg3m", ind.aggregateBars(bars, 3).length],
  ["vwap", ind.vwap(bars).length, "obv", ind.obv(bars).length, "mfi", ind.mfi(bars).length],
  ["cci", ind.cci(bars).length, "willr", ind.williamsR(bars).length, "roc", ind.roc(bars).length, "mom", ind.momentum(bars).length],
  ["stoch", ind.stochastic(bars).k.length, "vwma", ind.vwma(bars, 20).length, "wma", ind.wma(bars, 20).length],
  ["atr", ind.atr(bars).length, "aroon", ind.aroon(bars).up.length, "hma", ind.hma(bars, 21).length],
  ["volProfile", ind.volumeProfile(bars).length],
];
for (const r of rows) console.log(...r);

// quick correctness spot-checks
const sma20 = ind.sma(bars, 20);
const manual = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
console.log("sma check:", Math.abs(sma20[sma20.length - 1].value - manual) < 1e-6 ? "OK" : "FAIL");
const ha = ind.toHeikinAshi(bars);
console.log("ha check:", ha.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)) ? "OK" : "FAIL");
