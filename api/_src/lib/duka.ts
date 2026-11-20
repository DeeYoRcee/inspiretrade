/**
 * Dukascopy free historical datafeed (Phase 17) — pure JS access to their
 * public bi5 candle files. No key, no credits, years-deep 1-minute forex AND
 * metals history (Phase 25 verification: XAUUSD serves genuine SPOT BID
 * candles back to at least 2010; 2020-06-15 decodes to O 1732.628 → C 1733.068,
 * the real June-2020 spot price).
 *
 * File layout (UTC, publication lag ≈ 1–2 days):
 *   https://datafeed.dukascopy.com/datafeed/{SYM}/{YYYY}/{MM-1:02d}/{DD:02d}/BID_candles_min_1.bi5
 * Each file LZMA-compresses up to 1440 records of 24 bytes, big-endian:
 *   int32 sec-offset from UTC midnight, int32 O, int32 C, int32 L, int32 H
 *   (price × point factor), float32 volume in lots.
 * Phase 25 CRITICAL FIX: the field order is (O, C, L, H) — verified against
 * a clean 2020-06-15 XAUUSD file where only that order satisfies the
 * envelope (rec0: O=1732628 C=1733058 L=1732248 H=1733068; the previously
 * assumed (O,H,L,C) made H<C on ~94% of bars, so validateBars rejected
 * everything and the Dukascopy stores stayed thin — the real root cause of
 * the EURUSD "dot candle" era and the thin-fx-store symptoms).
 * Point factors verified: JPY-quote pairs 1e3 (3 decimals), all other forex
 * 1e5 (5 decimals), metals 1e3.
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
  // Phase 23: metals re-test — the datafeed DOES serve XAUUSD/XAGUSD again
  // (verified live 2026-11-20: 2020-06-15 close 1710.758, 2026-11-17 close
  // 3856.176 — genuine spot gold). Gold/silver quote 3 decimals.
  if (code === "XAUUSD" || code === "XAGUSD") return 1e3;
  return JPY_QUOTE.has(code) ? 1e3 : 1e5;
}

/** Phase 23: metals on the Dukascopy datafeed (hist engine only — the live
 * chains keep their explicit maps). Genuine SPOT BID candles, years deep. */
export const DUKA_METALS: Record<string, string> = { XAUUSD: "XAUUSD", XAGUSD: "XAGUSD" };

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
 * minute timestamps are absolute UTC epochs. Record layout (Phase 25 fix,
 * verified against clean real files): [t, O, C, L, H, vol]. Flat zero-volume
 * filler minutes (no ticks traded) are dropped — honest gaps stay gaps. */
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
    const c = raw.readInt32BE(off + 8) / div;
    const l = raw.readInt32BE(off + 12) / div;
    const h = raw.readInt32BE(off + 16) / div;
    const v = raw.readFloatBE(off + 20);
    if (![o, h, l, c].every(Number.isFinite) || !Number.isFinite(v)) continue;
    if (h < Math.max(o, c) || l > Math.min(o, c) || h < l || o <= 0) continue;
    if (h === l && v <= 0) continue; // filler minute without a single tick
    if (!Number.isFinite(t) || t % 60 !== 0) continue;
    out.push({ t, o, h, l, c, v: Math.round(v * 100) / 100 });
  }
  return out;
}
