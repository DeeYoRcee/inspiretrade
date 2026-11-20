/**
 * PHASE 24 §9 — visual-test data builder. Produces the harness dataset from
 * REAL provider responses through the REAL shared pipeline:
 *   · EURUSD m1: Dukascopy BID_candles_min_1.bi5 (two recent trading days)
 *     → decodeDukaDay-equivalent → validateBars → alignAndDedupe → m3/m5
 *   · XAUUSD m1: same Dukascopy path (spot gold BID)
 *   · BTCUSDT 1s: Binance klines (3 pages) → aggregateToSeconds → 15s
 *   · "before" series: closes-only (O=H=L=C) — a faithful reproduction of the
 *     Yahoo close-only 1m feed (Phase 20 verified 6712/6712 flat), i.e. the
 *     diagnosed defect, rendered for comparison
 * Output → client/visual-harness/harness-data.json
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { decompress } from "lzma-native";
import { validateBars, alignAndDedupe } from "../shared/feed-validation.ts";
import { aggregateBars } from "../shared/terminal.ts";
import { aggregateToSeconds } from "../shared/candle-core.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDuka(sym, day) {
  const [y, m, d] = day.split("-").map(Number);
  const url = `https://datafeed.dukascopy.com/datafeed/${sym}/${y}/${String(m - 1).padStart(2, "0")}/${String(d).padStart(2, "0")}/BID_candles_min_1.bi5`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 100) return buf;
      }
      if (r.status === 503) { await sleep(2500); continue; } // CDN rate-limit — longer backoff
    } catch { await sleep(1000); }
  }
  return null;
}

function decodeDuka(buf, dayStartSec, div) {
  return new Promise((resolve) => {
    decompress(buf, (result) => {
      if (!result) return resolve([]);
      const raw = Buffer.isBuffer(result) ? result : Buffer.from(result);
      const bars = [];
      for (let off = 0; off + 24 <= raw.length; off += 24) {
        const t = dayStartSec + raw.readInt32BE(off);
        const o = raw.readInt32BE(off + 4) / div, h = raw.readInt32BE(off + 8) / div;
        const l = raw.readInt32BE(off + 12) / div, c = raw.readInt32BE(off + 16) / div;
        const v = raw.readFloatBE(off + 20);
        if (h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l && o > 0 && !(h === l && v <= 0)) bars.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
      }
      resolve(bars);
    });
  });
}

const run = async () => {
  const data = {};
  // days 3-5 back: the last 1-2 days' CDN files are still being written
  // (publication lag) — probing Nov 12 returned 1440/1440 records with 1336
  // genuine movers for XAUUSD, vs partial 12-24 for Nov 18/19
  const recent = ["2026-11-12", "2026-11-13"];

  // ---- EURUSD + XAUUSD genuine m1 via the real validation pipeline ----------
  for (const [sym, div, digits] of [["EURUSD", 1e5, 5], ["XAUUSD", 1e3, 2]]) {
    const all = [];
    for (const day of recent) {
      const buf = await fetchDuka(sym, day);
      if (!buf) { console.log(`${sym} ${day}: no file`); continue; }
      const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
      const decoded = await decodeDuka(buf, dayStart, div);
      console.log(`${sym} ${day}: ${decoded.length} raw 1m bars`);
      all.push(...decoded);
    }
    const checked = alignAndDedupe(validateBars(all).bars, 60);
    const m1 = checked.bars;
    const m5 = aggregateBars(m1, 5);
    data[`${sym.toLowerCase()}M1After`] = m1.slice(-720);
    data[`${sym.toLowerCase()}M5After`] = m5.slice(-400);
    // diagnosed "before": Yahoo close-only 1m — O=H=L=C from the genuine closes
    data[`${sym.toLowerCase()}M1Before`] = m1.slice(-720).map((b) => ({ time: b.time, open: b.close, high: b.close, low: b.close, close: b.close, volume: 0 }));
    data[`${sym.toLowerCase()}M5Before`] = m5.slice(-400).map((b) => ({ time: b.time, open: b.close, high: b.close, low: b.close, close: b.close, volume: 0 }));
    await sleep(800); // CDN courtesy between symbols
  }

  // ---- BTCUSDT native 1s → seconds aggregates (Bug 2 fix demo) ---------------
  try {
    const pages = [];
    let end;
    for (let p = 0; p < 3; p++) {
      const q = end ? `&endTime=${end}` : "";
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1000${q}`);
      const raw = await r.json();
      if (!Array.isArray(raw) || !raw.length) break;
      pages.unshift(...raw.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })));
      end = pages[0].time * 1000 - 1;
    }
    const checked = validateBars(pages).bars;
    data.btc15s = aggregateToSeconds(checked, 15).slice(-300);
    data.btc30s = aggregateToSeconds(checked, 30).slice(-200);
    data.btc1s = checked.slice(-600);
    console.log(`BTCUSDT 1s pages: ${checked.length} bars → 15s/30s aggregates`);
  } catch (e) { console.log("binance:", String(e)); }

  writeFileSync("client/visual-harness/harness-data.json", JSON.stringify(data));
  console.log("saved → client/visual-harness/harness-data.json");
};
run();
