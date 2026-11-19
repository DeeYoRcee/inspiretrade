/**
 * Dukascopy free historical datafeed (Phase 17) — pure JS access to their
 * public bi5 candle files. No key, no credits, months-deep 1-minute forex
 * history (verified 2026-11-19: EURUSD 1.09910 and USDJPY 159.228 decode to
 * real prices; metals and index symbols are NOT served by the free feed —
 * XAUUSD/USATECHIDXUSD connections drop, so the map is forex-only).
 *
 * File layout (UTC, publication lag ≈ 1–2 days):
 *   https://datafeed.dukascopy.com/datafeed/{SYM}/{YYYY}/{MM-1:02d}/{DD:02d}/BID_candles_min_1.bi5
 * Each file LZMA-compresses 1440 records of 24 bytes, big-endian:
 *   int32 sec-offset from UTC midnight, int32 o, h, l, c (price × point
 *   factor), float32 volume in lots.
 * Point factors verified: JPY-quote pairs 1e3 (3 decimals), all other forex
 * 1e5 (5 decimals).
 */
import { decompress } from "lzma-native";

/** Catalog forex pairs served by the free Dukascopy datafeed. */
export const DUKA_MAP: Record<string, string> = {
  EURUSD: "EURUSD", GBPUSD: "GBPUSD", USDJPY: "USDJPY", USDCHF: "USDCHF",
  USDCAD: "USDCAD", AUDUSD: "AUDUSD", NZDUSD: "NZDUSD",
  EURGBP: "EURGBP", EURJPY: "EURJPY", EURCHF: "EURCHF", EURAUD: "EURAUD",
  EURNZD: "EURNZD", EURCAD: "EURCAD",
  GBPJPY: "GBPJPY", GBPCHF: "GBPCHF", GBPAUD: "GBPAUD", GBPCAD: "GBPCAD", GBPNZD: "GBPNZD",
  AUDJPY: "AUDJPY", AUDNZD: "AUDNZD", AUDCAD: "AUDCAD", AUDCHF: "AUDCHF",
  NZDJPY: "NZDJPY", NZDCAD: "NZDCAD", NZDCHF: "NZDCHF",
  CADJPY: "CADJPY", CADCHF: "CADCHF", CHFJPY: "CHFJPY",
  USDSGD: "USDSGD", USDNOK: "USDNOK", USDSEK: "USDSEK", USDZAR: "USDZAR",
  USDTRY: "USDTRY", USDMXN: "USDMXN",
};

const JPY_QUOTE = new Set(["USDJPY", "EURJPY", "GBPJPY", "AUDJPY", "NZDJPY", "CADJPY", "CHFJPY"]);

/** Dukascopy price→point factor for a catalog code. */
export function dukaPoints(code: string): number {
  return JPY_QUOTE.has(code) ? 1e3 : 1e5;
}

const DUKA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Fetch one UTC day of BID 1m candles; null when the day has no file yet
 * (weekends, holidays, or the 1–2 day publication lag). */
export async function fetchDukaDay(dukaSym: string, day: Date): Promise<Buffer | null> {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth(); // datafeed months are 0-indexed in the path
  const d = day.getUTCDate();
  const url = `https://datafeed.dukascopy.com/datafeed/${dukaSym}/${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/BID_candles_min_1.bi5`;
  // the datafeed CDN is notoriously flaky per connection — two attempts with
  // a generous timeout beat one hard failure
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": DUKA_UA }, signal: controller.signal });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100) return buf; // tiny bodies are error pages
      }
    } catch {
      // fall through to the retry
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export interface DukaBar { t: number; o: number; h: number; l: number; c: number; v: number }

/** Decompress + parse one day file. Prices are scaled to real values, the
 * minute timestamps are absolute UTC epochs. Flat zero-volume filler minutes
 * (no ticks traded) are dropped — honest gaps stay gaps. */
export async function decodeDukaDay(buf: Buffer, code: string, day: Date): Promise<DukaBar[]> {
  const raw = await new Promise<Buffer>((resolve) => {
    decompress(buf, (result) => {
      if (result == null) return resolve(Buffer.alloc(0)); // invalid stream — lzma-native calls back with null
      resolve(Buffer.isBuffer(result) ? result : Buffer.from(result as string));
    });
  }).catch(() => Buffer.alloc(0));
  if (raw.length < 24) return [];
  const div = dukaPoints(code);
  const dayStart = Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 1000);
  const out: DukaBar[] = [];
  for (let off = 0; off + 24 <= raw.length; off += 24) {
    const t = dayStart + raw.readInt32BE(off);
    const o = raw.readInt32BE(off + 4) / div;
    const h = raw.readInt32BE(off + 8) / div;
    const l = raw.readInt32BE(off + 12) / div;
    const c = raw.readInt32BE(off + 16) / div;
    const v = raw.readFloatBE(off + 20);
    if (![o, h, l, c].every(Number.isFinite) || !Number.isFinite(v)) continue;
    if (h < Math.max(o, c) || l > Math.min(o, c) || h < l || o <= 0) continue;
    if (h === l && v <= 0) continue; // filler minute without a single tick
    if (!Number.isFinite(t) || t % 60 !== 0) continue;
    out.push({ t, o, h, l, c, v: Math.round(v * 100) / 100 });
  }
  return out;
}
