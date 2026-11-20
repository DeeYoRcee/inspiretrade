/**
 * Stooq PoW probe — the free endpoint fronts a browser proof-of-work
 * challenge (SHA-256, find n with hash prefix). Solve it the same way a
 * browser does, keep the session cookie, and MEASURE the real historical
 * depth of xauusd for i=d / i=60 / i=15 / i=5.
 * Output → download/PHASE23_STOOQ_DEPTH.md
 */
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function curlFetch(url) {
  // -s silent, --compressed, hard timeouts, cookie jar for the PoW session
  try {
    const txt = execFileSync("curl", ["-s", "--compressed", "--max-time", "20", "-A", UA, "-b", "jar.txt", "-c", "jar.txt", "-H", "Referer: https://stooq.com/", url], { encoding: "utf8", timeout: 25000 });
    return txt;
  } catch (e) { return `CURL_ERR ${String(e?.status ?? "")}`; }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
let cookie = "";

async function solvePoW(html) {
  const m = html.match(/const c="([^"]+)",d=(\d+)/);
  if (!m) return false;
  const [, c, dStr] = m;
  const d = Number(dStr);
  const target = "0".repeat(d);
  const enc = new TextEncoder();
  let n = 0;
  while (true) {
    const h = crypto.createHash("sha256").update(enc.encode(c + n)).digest("hex");
    if (h.startsWith(target)) break;
    n++;
  }
  try {
    const body = `c=${encodeURIComponent(c)}&n=${n}`;
    execFileSync("curl", ["-s", "--max-time", "20", "-A", UA, "-b", "jar.txt", "-c", "jar.txt", "-H", "Content-Type: application/x-www-form-urlencoded", "-H", "Referer: https://stooq.com/", "--data", body, "https://stooq.com/__verify"], { encoding: "utf8", timeout: 25000 });
    // the session cookie lands in jar.txt; every curlFetch re-applies it
    return true;
  } catch { return false; }
}

async function getCsv(sym, iv) {
  const url = `https://stooq.com/q/d/l/?s=${sym}&i=${iv}`;
  for (let a = 0; a < 2; a++) {
    const txt = curlFetch(url);
    if (!txt || txt.startsWith("CURL_ERR")) continue; // transient connect fail — retry once
    return { status: 200, txt, isChallenge: txt.startsWith("<!DOCTYPE") };
  }
  return { status: 0, txt: "", isChallenge: true };
}

const out = [];
const log = (s = "") => { out.push(s); console.log(s); };

// 1st request → challenge; solve → retry
let first = await getCsv("xauusd", "d");
if (first.isChallenge) {
  const ok = await solvePoW(first.txt);
  log(`PoW challenge solved: ${ok}`);
  for (let i = 0; i < 3 && first.isChallenge; i++) first = await getCsv("xauusd", "d");
}
log(`\n# PHASE 23 — stooq measured historical depth (spot xauusd)`);
log(`measured: ${new Date().toISOString()}`);
for (const iv of ["d", "60", "15", "5"]) {
  const r = await getCsv("xauusd", iv);
  if (r.isChallenge) { log(`\ni=${iv}: STILL CHALLENGED (cookie not accepted)`); continue; }
  const lines = r.txt.trim().split("\n").filter((l) => l && !l.startsWith("Date"));
  const firstRow = lines[0]?.split(",")[0];
  const lastRow = lines[lines.length - 1]?.split(",");
  log(`\n## interval ${iv}`);
  log(`- rows: ${lines.length}`);
  log(`- earliest: ${firstRow}`);
  log(`- latest: ${lastRow?.[0]} ${lastRow?.[1] ?? ""} close=${lastRow?.[6] ?? "?"}`);
  log(`- header: ${r.txt.split("\n")[0]?.trim().slice(0, 60)}`);
  if (iv !== "d") {
    // sample gap structure: are sessions continuous (weekends closed)?
    log(`- sample: ${lines[lines.length - 2]}`);
  }
}
// also probe EURUSD (fx deep daily) and xagusd
for (const [sym, iv] of [["eurusd", "d"], ["xagusd", "d"], ["xauusd", "w"], ["xauusd", "m"]]) {
  const r = await getCsv(sym, iv);
  if (r.isChallenge) { log(`\n${sym} i=${iv}: CHALLENGED`); continue; }
  const lines = r.txt.trim().split("\n").filter((l) => l && !l.startsWith("Date"));
  log(`\n## ${sym} i=${iv}: rows=${lines.length} earliest=${lines[0]?.split(",")[0]} latest=${lines[lines.length - 1]?.split(",")[0]}`);
}
writeFileSync("/home/z/my-project/download/PHASE23_STOOQ_DEPTH.md", out.join("\n") + "\n");
console.log("\nsaved → download/PHASE23_STOOQ_DEPTH.md");
