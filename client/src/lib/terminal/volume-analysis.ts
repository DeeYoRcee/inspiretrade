/**
 * Advanced volume analysis — volume profiles, POC/VAH/VAL, anchored VWAP and
 * volume delta. All numbers come from the REAL OHLCV bars of the feed.
 *
 * Volume semantics by asset class (never fabricated):
 *  - crypto (Binance): real traded base-asset volume per candle + REAL taker
 *    buy volume (kline field 9) → true buy/sell delta.
 *  - indices/metals via futures (Yahoo): real contracted volume of the front
 *    futures contract.
 *  - forex (Yahoo): no central exchange exists — the feed reports aggregated
 *    TICK volume. The UI must label it "tick volume".
 */
import type { Bar } from "@shared/terminal";

export interface VolumeRow { price: number; buy: number; sell: number; volume: number; }
export interface VolumeProfileResult {
  rows: VolumeRow[];
  poc: number;
  vah: number;
  val: number;
  total: number;
  hi: number;
  lo: number;
}

/**
 * Volume-at-price profile. buy/sell split uses REAL takerBuy volume when the
 * feed provides it (Binance crypto); otherwise buy≈sell≈volume/2 is NOT
 * assumed — split stays 0/0 and the UI shows total only.
 */
export function buildVolumeProfile(bars: Bar[], bins = 24): VolumeProfileResult | null {
  if (!bars.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
  if (!Number.isFinite(hi) || hi <= lo) return null;
  const step = (hi - lo) / bins;
  const rows: VolumeRow[] = Array.from({ length: bins }, (_, i) => ({
    price: lo + step * (i + 0.5), buy: 0, sell: 0, volume: 0,
  }));
  for (const b of bars) {
    // distribute the bar's volume across the price bins its range spans
    const from = Math.max(0, Math.floor((b.low - lo) / step));
    const to = Math.min(bins - 1, Math.floor((b.high - lo) / step));
    const span = to - from + 1;
    const per = (b.volume ?? 0) / span;
    const buyPer = b.takerBuy != null ? (b.takerBuy) / span : 0;
    const sellPer = b.takerBuy != null ? ((b.volume ?? 0) - b.takerBuy) / span : 0;
    for (let i = from; i <= to; i++) {
      rows[i].volume += per;
      rows[i].buy += buyPer;
      rows[i].sell += sellPer;
    }
  }
  const total = rows.reduce((s, r) => s + r.volume, 0);
  if (total <= 0) return null;
  // POC = highest-volume row
  let pocIdx = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].volume > rows[pocIdx].volume) pocIdx = i;
  // Value area: expand from POC until ≥70% of total volume (classic algorithm)
  const target = total * 0.7;
  let acc = rows[pocIdx].volume;
  let loIdx = pocIdx, hiIdx = pocIdx;
  while (acc < target && (loIdx > 0 || hiIdx < rows.length - 1)) {
    const downVol = loIdx > 0 ? rows[loIdx - 1].volume : -1;
    const upVol = hiIdx < rows.length - 1 ? rows[hiIdx + 1].volume : -1;
    if (upVol >= downVol) { hiIdx++; acc += rows[hiIdx].volume; }
    else { loIdx--; acc += rows[loIdx].volume; }
  }
  return {
    rows, total, hi, lo,
    poc: rows[pocIdx].price,
    vah: rows[hiIdx].price + step / 2,
    val: rows[loIdx].price - step / 2,
  };
}

/** Fixed-range profile over an explicit [fromTime, toTime] slice. */
export function rangeProfile(allBars: Bar[], fromTime: number, toTime: number, bins = 24): VolumeProfileResult | null {
  return buildVolumeProfile(allBars.filter((b) => b.time >= fromTime && b.time <= toTime), bins);
}

/** Visible-range profile over the currently displayed slice. */
export function visibleProfile(displayBars: Bar[], bins = 24): VolumeProfileResult | null {
  return buildVolumeProfile(displayBars, bins);
}

/** Session volume profile — bars inside the given session window. */
export function sessionProfile(allBars: Bar[], inWindow: (t: number) => boolean, bins = 24): VolumeProfileResult | null {
  return buildVolumeProfile(allBars.filter((b) => inWindow(b.time)), bins);
}

/** Anchored VWAP: cumulative (TP×vol / vol) from the anchor bar onward. */
export function anchoredVwap(bars: Bar[], anchorTime: number): { time: number; value: number }[] {
  let pv = 0, vv = 0;
  const out: { time: number; value: number }[] = [];
  for (const b of bars) {
    if (b.time < anchorTime) continue;
    const v = b.volume ?? 0;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vv += v;
    out.push({ time: b.time, value: vv ? pv / vv : b.close });
  }
  return out;
}

export interface DeltaPoint { time: number; delta: number; cum: number; }

/**
 * Volume delta. REAL for crypto (takerBuy from Binance klines); for feeds
 * without taker data returns null — the UI states "not available for this
 * feed" instead of estimating.
 */
export function volumeDelta(bars: Bar[]): DeltaPoint[] | null {
  if (!bars.length || bars.every((b) => b.takerBuy == null)) return null;
  let cum = 0;
  const out: DeltaPoint[] = [];
  for (const b of bars) {
    const v = b.volume ?? 0;
    const delta = b.takerBuy != null ? 2 * b.takerBuy - v : 0;
    cum += delta;
    out.push({ time: b.time, delta, cum });
  }
  return out;
}

export type VolumeSource = "traded" | "tick";

/** Honest label of what the feed's volume represents. */
export function volumeSource(assetClass: string): VolumeSource {
  return assetClass === "forex" ? "tick" : "traded";
}
