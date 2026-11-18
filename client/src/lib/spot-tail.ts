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
  maxFill = 90,
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
  while (t < bucket && fills.length < maxFill) {
    fills.push({ time: t, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 });
    t += sec;
  }
  if (t < bucket) return null; // history hopelessly stale (>maxFill buckets) — leave untouched
  const live: SpotTailBar = { time: bucket, open: last.close, high: Math.max(last.close, spot), low: Math.min(last.close, spot), close: spot, volume: 0 };
  return [...bars, ...fills, live];
}

// ---------------------------------------------------------------------------
// Phase 16 — self-recorded spot candles. There is NO free keyless provider of
// genuine XAUUSD-SPOT 1m OHLC history (Yahoo spot symbols delisted, stooq
// behind a browser PoW challenge, TwelveData/OANDA/Polygon need API keys), so
// the terminal records its own: every 1s gold-api tick observed by a chart is
// folded into a real minute candle (o=first, h=max, l=min, c=last, s=samples).
// Candles only ever come from actually-observed ticks — gaps stay gaps, no
// fabricated minutes. The server merges observations across devices with the
// same deterministic rules (see mergeSpotCandles).
// ---------------------------------------------------------------------------

/** One recorded spot minute (m1). s = number of observed samples. */
export interface SpotCandle {
  t: number; // minute bucket start (UNIX seconds, minute-aligned)
  o: number;
  h: number;
  l: number;
  c: number;
  s: number;
}

/** Fold one observed spot price into the in-progress minute candle. */
export function recordSpotTick(minute: SpotCandle | null, price: number, nowSec: number): SpotCandle {
  const bucket = Math.floor(nowSec / 60) * 60;
  if (minute && minute.t === bucket) {
    return { t: bucket, o: minute.o, h: Math.max(minute.h, price), l: Math.min(minute.l, price), c: price, s: minute.s + 1 };
  }
  // minute rolled over (or first tick): open a fresh candle at the real price
  return { t: bucket, o: price, h: price, l: price, c: price, s: 1 };
}

/**
 * Deterministic merge of two observations of the same minute (multi-device /
 * server vs local): the open belongs to the earlier writer, the close to the
 * later one, high/low envelope both, samples take the max (a rough count).
 */
export function mergeSpotCandles(a: SpotCandle, b: SpotCandle): SpotCandle {
  const first = a.t <= b.t ? a : b;
  const last = a.t <= b.t ? b : a;
  return {
    t: first.t,
    o: first.o,
    h: Math.max(a.h, b.h),
    l: Math.min(a.l, b.l),
    c: last.c,
    s: Math.max(a.s, b.s),
  };
}

/** Union-merge two recorded m1 series (both minute-aligned). */
export function mergeSpotSeries(base: SpotCandle[], incoming: SpotCandle[]): SpotCandle[] {
  const byTime = new Map<number, SpotCandle>();
  for (const c of base) byTime.set(c.t, c);
  for (const c of incoming) {
    const ex = byTime.get(c.t);
    byTime.set(c.t, ex ? mergeSpotCandles(ex, c) : c);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * Reject anything that is not a plausible real spot candle: minute-aligned
 * timestamp, sane OHLC envelope (h ≥ max(o,c), l ≤ min(o,c), h ≥ l > 0),
 * bounded freshness (no forged history) and a physically possible sample
 * count (≤ 60 one-second observations per minute).
 */
export function validSpotCandle(c: SpotCandle, nowSec: number): boolean {
  if (!c || typeof c.t !== "number" || !Number.isFinite(c.t)) return false;
  if (c.t % 60 !== 0) return false;
  if (c.t > Math.floor(nowSec / 60) * 60 || c.t < nowSec - 8 * 86400) return false; // no forged history
  const { o, h, l, cc } = { o: c.o, h: c.h, l: c.l, cc: c.c };
  for (const v of [o, h, l, cc]) if (!Number.isFinite(v) || v <= 0) return false;
  if (h < Math.max(o, cc) || l > Math.min(o, cc) || h < l) return false;
  if (!Number.isFinite(c.s) || c.s < 1 || c.s > 60) return false;
  return true;
}
