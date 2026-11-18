/**
 * Live spot tail (Phase 15) — connect a delayed history to the real-time
 * spot bucket without fabricating movement or timestamps.
 *
 * Standalone pure module (no imports) so both the app bundler and
 * `node --test` can load it directly.
 *
 * Guards, in order:
 *  1. spot-outlier: |spot/lastClose − 1| > 2% → reject (corrupted tick;
 *     metals cannot move 2% inside a few buckets)
 *  2. the gap between the delayed tail and the current bucket is bridged
 *     with FLAT bars (o=h=l=c=prev close, volume 0, real timestamps) — no
 *     price is invented, the market data we simply don't have yet renders as
 *     continuation, and the next REST resync replaces fills with real bars
 *  3. the current bucket is painted with the spot (open = prev close — body
 *     stays continuous, no seam jump beyond the genuine spot/futures basis)
 *
 * Only intraday buckets are supported (the 1s poller never runs for 1d),
 * matching shared/feed-validation bucketStart's intraday formula.
 */
export interface SpotTailBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function mergeSpotTail(
  bars: SpotTailBar[],
  spot: number,
  sec: number,
): SpotTailBar[] | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  if (last.close > 0 && Math.abs(spot / last.close - 1) > 0.02) return null; // outlier
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / sec) * sec;
  if (bucket <= last.time) {
    // same bucket — paint the live spot onto the current bar (clone, never
    // mutate the cached array: React/chart refs rely on identity changes)
    const tail: SpotTailBar = { ...last, close: spot, high: Math.max(last.high, spot), low: Math.min(last.low, spot) };
    return [...bars.slice(0, -1), tail];
  }
  const fills: SpotTailBar[] = [];
  let t = last.time + sec;
  while (t < bucket && fills.length < 90) {
    fills.push({ time: t, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 });
    t += sec;
  }
  if (t < bucket) return null; // history hopelessly stale (>90 buckets) — leave untouched
  const live: SpotTailBar = { time: bucket, open: last.close, high: Math.max(last.close, spot), low: Math.min(last.close, spot), close: spot, volume: 0 };
  return [...bars, ...fills, live];
}
