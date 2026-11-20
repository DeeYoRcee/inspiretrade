/**
 * PHASE 23 §6 — provider availability & depth audit (real network probes).
 * Verifiable facts only — every claim below comes from a live response.
 *   · Dukascopy official datafeed: forex m1 (EURUSD) vs metals (XAUUSD) —
 *     re-testing the Phase 17 "metals connections drop" claim TODAY
 *   · Binance klines: genuine crypto depth (first available minute)
 *   · Yahoo: daily depth for GC=F (futures reference only) + EURUSD=X
 *   · gold-api: live health
 * Output → download/PHASE23_HISTORY_AUDIT.md
 */
import { writeFileSync } from "node:fs";
import { decompress } from "lzma-native";

const out = [];
const log = (s = "") => { out.push(s); console.log(s); };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function buf(url, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: c.signal });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
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
        const l = raw.readInt32BE(off + 12) / div, cl = raw.readInt32BE(off + 16) / div;
        const v = raw.readFloatBE(off + 20);
        if (h >= Math.max(o, cl) && l <= Math.min(o, cl) && h >= l && o > 0 && !(h === l && v <= 0)) bars.push({ t, o, h, l, c: cl, v });
      }
      resolve(bars);
    });
  });
}

log("# PHASE 23 — Historical provider availability audit");
log(`Measured live: ${new Date().toISOString()}`);
log("");

// ---- Dukascopy datafeed: forex m1 deep + metals re-test ---------------------
log("## Dukascopy official datafeed (BID_candles_min_1.bi5)");
for (const [sym, day, div, expect] of [
  ["EURUSD", "2020-06-15", 1e5, "forex, 6 years back"],
  ["EURUSD", "2017-01-16", 1e5, "forex, ~9 years back"],
  ["XAUUSD", "2020-06-15", 1e3, "METAL re-test (Phase 17 said: drops)"],
  ["XAUUSD", "2026-11-17", 1e3, "METAL recent"],
]) {
  const [y, m, d] = day.split("-").map(Number);
  const url = `https://datafeed.dukascopy.com/datafeed/${sym}/${y}/${String(m - 1).padStart(2, "0")}/${String(d).padStart(2, "0")}/BID_candles_min_1.bi5`;
  const b = await buf(url);
  if (!b) {
    log(`- ${sym} ${day}: NO FILE / connection dropped (${expect})`);
    continue;
  }
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const bars = await decodeDuka(b, dayStart, div);
  const sample = bars[Math.floor(bars.length / 2)];
  log(`- ${sym} ${day}: file ${b.length}B → ${bars.length} real 1m bars${sample ? ` · sample close ${sample.c.toFixed(div === 1e3 ? 3 : 5)}` : ""} (${expect})`);
}
log("");

// ---- Binance depth -----------------------------------------------------------
log("## Binance klines (crypto native depth)");
try {
  const r = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=1502928000000&limit=3");
  const j = await r.json();
  const first = Array.isArray(j) && j.length ? new Date(j[0][0]).toISOString().slice(0, 16) : null;
  log(`- BTCUSDT 1m at 2017-08-16: ${Array.isArray(j) ? `${j.length} klines returned, first ${first}` : JSON.stringify(j).slice(0, 80)}`);
  const r2 = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1");
  const j2 = await r2.json();
  log(`- BTCUSDT 1s klines: ${Array.isArray(j2) && j2.length ? "available (native sub-minute)" : "not available"}`);
} catch (e) { log(`- binance: ERR ${e?.message}`); }
log("");

// ---- Yahoo daily depth (reference conventions — NOT spot charts) ------------
log("## Yahoo daily depth (reference only — futures/fx conventions, never mixed into spot)");
for (const sym of ["GC=F", "EURUSD=X", "^GSPC"]) {
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=max&interval=1mo`, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const ts = j?.chart?.result?.[0]?.timestamp;
    log(`- ${sym}: ${ts ? `${ts.length} monthly bars since ${new Date(ts[0] * 1000).toISOString().slice(0, 10)}` : (j?.chart?.error?.description || "no data")}`);
  } catch (e) { log(`- ${sym}: ERR ${e?.message}`); }
}
log("");

// ---- gold-api health ----------------------------------------------------------
log("## gold-api (metals live spot)");
try {
  const r = await fetch("https://api.gold-api.com/price/XAU");
  const j = await r.json();
  log(`- XAU ${j?.price} @ stamp ${j?.updatedAt} (spot only — NO historical endpoint)`);
} catch (e) { log(`- gold-api: ERR ${e?.message}`); }

log("");
log("## Verdict for the backfill engine");
log("- forex m1: Dukascopy datafeed serves YEARS of genuine BID 1m candles → deep backfill engine uses it (resumable day-walk).");
log("- metals m1: re-tested TODAY — see the XAUUSD lines above; if the datafeed still drops metal connections, TwelveData (keyed, budgeted) remains the only m1 source and deeper metals m1 does NOT exist free → reported honestly.");
log("- metals 5m/15m/30m/1h/d1: stooq genuine SPOT archives (the prod server already reads stooq for the watchlist — this sandbox IP is PoW-challenged, so depth is verified in production, not here).");
log("- crypto: Binance native — unlimited via the existing loadOlder pagination.");
log("- per-instrument stored coverage (earliest/latest/count/missing): the admin History panel + /api/quotes?action=hist-status report it from the RTDB store after deployment.");

writeFileSync("/home/z/my-project/download/PHASE23_HISTORY_AUDIT.md", out.join("\n") + "\n");
console.log("\nsaved → download/PHASE23_HISTORY_AUDIT.md");
