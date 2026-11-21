#!/usr/bin/env node
/**
 * PHASE 30 — XAUUSD (metals/forex) DEEP HISTORY INGEST — runs on a CLEAN network.
 *
 * WHY THIS EXISTS
 * The production functions run on datacenter IPs that Dukascopy's datafeed CDN
 * rate-limits hard (429/503) — the server-side `backfill-metals` walk never
 * advanced, so the chart wall sat at the recorder start (~2026-10-22). This
 * script is the repository's own ingest contract applied to metals: it fetches
 * the SAME genuine provider day files from YOUR machine (a clean IP), decodes
 * them, validates every bar, and pushes them into the shared day-shard store
 * via `POST /api/quotes?action=import-hist` (admin-only, validated server-side
 * by writeShards). Nothing synthetic — every bar comes from the provider file.
 *
 * USAGE
 *   1. Get a Firebase ID token (any admin account): open the app, DevTools
 *      console, paste:
 *        import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js")
 *          .then(m => m.getAuth().currentUser.getIdToken()).then(console.log)
 *   2. node scripts/phase30_metals_ingest.mjs --token <TOKEN> \
 *        [--symbol XAUUSD] [--tf 1m] [--to 2015-01-01] [--max-days 240] [--once]
 *   3. Repeat the command (or drop --once) — the cursor file resumes deeper
 *      exactly where the last run stopped. Progress never restarts.
 *
 * The token expires after ~1h — grab a fresh one for long runs. State lives in
 * scripts/phase30-cursor-<SYMBOL>-<tf>.json (gitignored).
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { decompress } from "lzma-native";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const TOKEN = arg("token", process.env.INSPIRE_TOKEN || "");
const BASE = arg("base", "https://freetradejournal.gt.tc");
const SYMBOL = String(arg("symbol", "XAUUSD")).toUpperCase();
const TF = String(arg("tf", "1m"));
const TO_DATE = arg("to", "2015-01-01"); // how deep to walk (genuine provider depth: metals go back ~2003)
const MAX_DAYS = Number(arg("max-days", 240));
const ONCE = flag("once");

if (!TOKEN) {
  console.error("Missing --token <Firebase ID token> (see header comment).");
  process.exit(1);
}
const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400 }[TF];
if (!TF_SEC) { console.error("unsupported --tf"); process.exit(1); }
// minutes walk the Duka minute day files; 5m/15m/30m/1h/1d fold from the 1m
// shards server-side (the walk-time fold writes 1h/1d automatically) — so the
// ingest stays on the one record layout that is verified against real files
if (TF !== "1m") { console.error("use --tf 1m — higher TFs fold from the 1m shards server-side"); process.exit(1); }
const DUKA_TF = "BID_candles_min_1";

const DIV = SYMBOL === "XAUUSD" || SYMBOL === "XAGUSD" ? 1e3 : 1e5;
const BANDS = { XAUUSD: [100, 12000], XAGUSD: [5, 200] };
const [bandLo, bandHi] = BANDS[SYMBOL] ?? [0.2, 600];
import { join } from "node:path";
const CURSOR_FILE = join(process.cwd(), "scripts", `phase30-cursor-${SYMBOL}-${TF}.json`);

const cursor = existsSync(CURSOR_FILE) ? JSON.parse(readFileSync(CURSOR_FILE, "utf8")) : { oldest: null, batches: 0, written: 0 };
const nowSec = Math.floor(Date.now() / 1000);
const toSec = Math.floor(new Date(arg("from", "") || Date.now() - 2 * 86400e3).getTime() / 1000) || nowSec - 2 * 86400;
const stopSec = Math.floor(new Date(`${TO_DATE}T00:00:00Z`).getTime() / 1000);
let startSec = cursor.oldest ? Math.min(cursor.oldest, toSec) : toSec;

log(`Ingest ${SYMBOL} ${TF} — walking from ${iso(startSec)} down to ${iso(stopSec)}`);

async function fetchDay(daySec) {
  const d = new Date(daySec * 1000);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth()).padStart(2, "0"), dd = String(d.getUTCDate()).padStart(2, "0");
  const url = `https://datafeed.dukascopy.com/datafeed/${SYMBOL}/${y}/${m}/${dd}/${DUKA_TF}.bi5`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: c.signal });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 100) return buf;
      }
      if (r.status === 429 || r.status === 503) await sleep(1500 + attempt * 1800);
    } catch { /* retry */ } finally { clearTimeout(t); }
    await sleep(400);
  }
  return null;
}

function decode(buf, daySec) {
  return new Promise((resolve) => {
    decompress(buf, (result) => {
      const raw = result == null ? Buffer.alloc(0) : (Buffer.isBuffer(result) ? result : Buffer.from(result));
      if (raw.length < 24) return resolve([]);
      const bars = [];
      for (let off = 0; off + 24 <= raw.length; off += 24) {
        const t = daySec + raw.readInt32BE(off);
        const o = raw.readInt32BE(off + 4) / DIV;
        const c = raw.readInt32BE(off + 8) / DIV;
        const l = raw.readInt32BE(off + 12) / DIV;
        const h = raw.readInt32BE(off + 16) / DIV;
        const v = raw.readFloatBE(off + 20);
        if (![o, h, l, c].every(Number.isFinite) || !Number.isFinite(v)) continue;
        if (h < Math.max(o, c) || l > Math.min(o, c) || h < l || o <= 0) continue;
        if (h === l && v <= 0) continue; // filler minute without a single tick
        if (t % TF_SEC !== 0 || t > nowSec || t < stopSec) continue;
        if (o < bandLo || o > bandHi) continue;
        bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Math.round(v * 100) / 100 });
      }
      resolve(bars);
    });
  });
}

async function push(bars) {
  const res = await fetch(`${BASE}/api/quotes?action=import-hist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ symbol: SYMBOL, tf: TF, provider: `dukascopy-bid-local`, bars }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("401 — token expired; grab a fresh ID token and rerun (cursor keeps progress)");
  if (!res.ok || !body.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

let filesFetched = 0;
let barsPending = [];
let oldestPending = null;
const t0 = Date.now();
for (let day = startSec; day >= stopSec && filesFetched < MAX_DAYS; day -= 86400) {
  if (Date.now() - t0 > 55 * 60 * 1000) { log("55-minute wall reached — rerun to continue (cursor resumes deeper)"); break; }
  const buf = await fetchDay(day);
  if (!buf) continue; // weekend/holiday/publication lag — honest gap
  filesFetched++;
  const bars = await decode(buf, Math.floor(day / TF_SEC) * TF_SEC);
  if (!bars.length) continue;
  barsPending.push(...bars);
  oldestPending = Math.min(oldestPending ?? Infinity, bars[0].time);
  // batches of ~48k bars ≈ 33 days of minutes
  while (barsPending.length >= 48000) {
    const chunk = barsPending.splice(0, 48000);
    const res = await push(chunk);
    cursor.batches++; cursor.written += res.written || 0;
    cursor.oldest = res.oldest ?? cursor.oldest;
    save(cursor);
    log(`batch ${cursor.batches}: received ${res.received} → written ${res.written} (skipped ${res.skipped}) · oldest ${iso(res.oldest)} · sample O=${chunk[0].open} H=${chunk[0].high} L=${chunk[0].low} C=${chunk[0].close}`);
    if (ONCE) process.exit(0);
  }
  for (const b of barsPending) if (b.time < oldestPending) oldestPending = b.time;
}
if (barsPending.length) {
  const res = await push(barsPending);
  cursor.batches++; cursor.written += res.written || 0;
  cursor.oldest = res.oldest ?? cursor.oldest;
  save(cursor);
  log(`final batch ${cursor.batches}: written ${res.written} (skipped ${res.skipped}) · oldest ${iso(res.oldest)} · sample O=${barsPending[0].open} H=${barsPending[0].high} L=${barsPending[0].low} C=${barsPending[0].close}`);
}
log(`DONE: ${filesFetched} day files fetched · ${cursor.written} bars stored in ${cursor.batches} batches · store oldest now ${iso(cursor.oldest)} (target ${TO_DATE})${cursor.oldest > stopSec ? " — RERUN to continue deeper" : " — target reached"}`);

function iso(s) { return s ? new Date(s * 1000).toISOString().slice(0, 10) : "?"; }
function save(c) { writeFileSync(CURSOR_FILE, JSON.stringify(c, null, 2)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(s) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); }
