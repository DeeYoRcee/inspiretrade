/**
 * feed-validation — Phase 10 candle data integrity (PURE, no I/O).
 *
 * Canonical module: used by the client (market-data.ts) at every provider
 * entry point, by the server quotes proxy (api/_src/quotes.ts, bundled by
 * esbuild) and by the test suite (tests/feed-validation.test.ts, validated
 * against a REAL captured Yahoo GC=F dataset).
 *
 * The rules (from the phase spec):
 *   - High ≥ max(Open, Close)
 *   - Low  ≤ min(Open, Close)
 *   - High ≥ Low
 *   - Open/Close are valid numerical prices (> 0, finite)
 *
 * Policy: bars that violate a REPAIRABLE invariant (H/L vs body) are fixed
 * to the widest legal envelope; bars with non-finite or non-positive prices
 * or an inverted High/Low are REJECTED — never silently corrected into fake
 * candles. Genuine market prices are never narrowed: repair only ever WIDENS
 * High or LOWERS Low to cover the body, which can only ever make the
 * rendered candle MORE truthful, not less.
 */

export interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  // extra provider fields (takerBuy, …) are preserved by spread — no index
  // signature so client Bar interfaces remain structurally assignable
}

export type BarProblem =
  | "non-finite-price"
  | "non-positive-price"
  | "high-low-inverted"
  | "high-below-body"
  | "low-above-body";

export interface BarCheck {
  /** false → the bar must be rejected outright */
  ok: boolean;
  /** true → the bar was fine but High/Low were widened to cover the body */
  repaired: boolean;
  reason?: BarProblem;
}

const finitePositive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Validate one bar against the OHLC rules. Never mutates the input. */
export function checkBar(b: RawBar): BarCheck {
  const { open: o, high: h, low: l, close: c } = b;
  if (![o, h, l, c].every(finitePositive)) {
    return { ok: false, repaired: false, reason: "non-finite-price" };
  }
  if (h < l) return { ok: false, repaired: false, reason: "high-low-inverted" };
  if (h < Math.max(o, c)) return { ok: true, repaired: true, reason: "high-below-body" };
  if (l > Math.min(o, c)) return { ok: true, repaired: true, reason: "low-above-body" };
  return { ok: true, repaired: false };
}

export interface ValidateResult {
  bars: RawBar[];
  /** bars dropped outright (non-finite / non-positive / inverted H<L) */
  invalid: number;
  /** bars kept but High/Low widened to cover the body */
  repaired: number;
}

/** Validate a whole series, preserving order. Rejects broken bars, repairs H/L envelope violations. */
export function validateBars(bars: RawBar[]): ValidateResult {
  const out: RawBar[] = [];
  let invalid = 0;
  let repaired = 0;
  for (const b of bars) {
    const check = checkBar(b);
    if (!check.ok) {
      invalid++;
      continue;
    }
    if (check.repaired) {
      repaired++;
      out.push({
        ...b,
        high: Math.max(b.high, b.open, b.close),
        low: Math.min(b.low, b.open, b.close),
      });
      continue;
    }
    out.push(b);
  }
  return { bars: out, invalid, repaired };
}

/**
 * Align every bar to its interval bucket, then drop duplicates within a
 * bucket — keep the most informative bar.
 *
 * REAL-WORLD TRIGGER #2 (Yahoo GC=F 1m, 2026-11-17): Yahoo appends a final
 * NOT-minute-aligned tick (e.g. 16:19:24 with O=H=L=C, volume 0). It is 24
 * seconds past the real 16:19:00 bar, so it renders as an EXTRA sliver
 * candle at the right edge — a zero-width vertical line that does not match
 * its neighbours. Normalizing to the interval bucket makes it collide with
 * the real bar and lose (the real envelope is wider); M1..H1 aggregation
 * then sees exactly one clean candle per bucket.
 */
export function alignAndDedupe(bars: RawBar[], sec: number): { bars: RawBar[]; dropped: number; aligned: number } {
  const byTime = new Map<number, RawBar>();
  let dropped = 0;
  let aligned = 0;
  for (const b of bars) {
    const bucket = bucketStart(b.time, sec);
    const time = bucket !== b.time ? bucket : b.time;
    if (bucket !== b.time) aligned++;
    const bar = time === b.time ? b : { ...b, time };
    const prev = byTime.get(time);
    if (!prev) {
      byTime.set(time, bar);
      continue;
    }
    dropped++;
    const range = (x: RawBar) => x.high - x.low;
    const vol = (x: RawBar) => (typeof x.volume === "number" && x.volume > 0 ? 1 : 0);
    if (range(bar) > range(prev)) byTime.set(time, bar);
    else if (range(bar) === range(prev) && vol(bar) > vol(prev)) byTime.set(time, bar);
  }
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { bars: out, dropped, aligned };
}

/**
 * Drop duplicate timestamps — keep the most informative bar per time.
 *
 * REAL-WORLD TRIGGER (found in the live Yahoo GC=F 1m stream, 2026-11-17):
 * Yahoo appends a phantom second bar with the same timestamp where
 * O=H=L=C=last-close and volume=0. Rendered, it is a zero-width body (a
 * vertical line) that does not match its neighbours — exactly the
 * "last candles look like vertical lines" defect.
 *
 * Winner selection per timestamp: the bar with the WIDEST high−low range;
 * ties prefer volume > 0, then the first occurrence. Yahoo's real bar
 * always carries the true OHLC envelope, the phantom never widens it.
 */
export function dedupeBars(bars: RawBar[]): { bars: RawBar[]; dropped: number } {
  const byTime = new Map<number, RawBar>();
  let dropped = 0;
  for (const b of bars) {
    const prev = byTime.get(b.time);
    if (!prev) {
      byTime.set(b.time, b);
      continue;
    }
    dropped++;
    const range = (x: RawBar) => x.high - x.low;
    const vol = (x: RawBar) => (typeof x.volume === "number" && x.volume > 0 ? 1 : 0);
    if (range(b) > range(prev)) byTime.set(b.time, b);
    else if (range(b) === range(prev) && vol(b) > vol(prev)) byTime.set(b.time, b);
  }
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { bars: out, dropped };
}

/**
 * UTC-aligned bucket start (epoch seconds) for a candle period.
 * D1 → UTC midnight. W1 (604800) → Monday 00:00 UTC (epoch 0 is a Thursday,
 * so the plain floor would anchor weeks to Thursday — real weekly candles
 * open on Monday, and the candle-close countdown must match that boundary).
 */
export function bucketStart(nowSec: number, sec: number): number {
  if (sec === 604800) {
    const MONDAY_ANCHOR = 345600; // Mon 1970-01-05 00:00 UTC
    return Math.floor((nowSec - MONDAY_ANCHOR) / sec) * sec + MONDAY_ANCHOR;
  }
  if (sec >= 86400) return Math.floor(nowSec / 86400) * 86400;
  return Math.floor(nowSec / sec) * sec;
}

export interface SpotMergeGuard {
  /** the target candle period in seconds (1m → 60, 1h → 3600) */
  sec: number;
  /** max allowed distance between the spot price and the last close (fraction, 0.02 = 2%) */
  maxDeviationPct?: number;
  /** now, epoch seconds (injectable for tests) */
  nowSec?: number;
}

export type SpotMergeVerdict =
  | { ok: true }
  | { ok: false; reason: "empty-bars" | "stale-history" | "spot-outlier" };

/**
 * Guard for painting a live spot price onto REST candle history.
 *
 * REAL-WORLD FAILURE (Phase 10 root cause, Yahoo GC=F 2026-11-17): the REST
 * history's last bar can be ~9–15 MINUTES old (Yahoo futures data is
 * delayed). Painting the current spot bucket then produced a fabricated bar
 * whose envelope spans `|spot − 9-minute-old close|` — an abnormally long
 * wick that does not match its neighbours — plus a visible gap of empty
 * buckets on the time axis.
 *
 * Rules:
 *  - history must be at most ONE bucket behind "now" (no fabricated candles
 *    spanning missing buckets — honest "delayed" display instead);
 *  - the spot price must sit within `maxDeviationPct` of the last close
 *    (metals futures-vs-spot basis is ~0.1–0.3%; >2% means a corrupted tick,
 *    gold cannot move 2% inside one candle) — reject the outlier tick.
 */
export function spotMergeGuard(
  bars: RawBar[],
  spot: number,
  g: SpotMergeGuard,
): SpotMergeVerdict {
  if (!bars.length) return { ok: false, reason: "empty-bars" };
  const now = g.nowSec ?? Math.floor(Date.now() / 1000);
  const bucket = bucketStart(now, g.sec);
  const last = bars[bars.length - 1];
  // the spot bucket may lag/lead by at most one period — anything wider means
  // the REST history is stale and painting would fabricate a giant-range bar
  if (Math.abs(bucket - last.time) > g.sec) return { ok: false, reason: "stale-history" };
  const maxDev = g.maxDeviationPct ?? 0.02;
  if (last.close > 0 && Math.abs(spot / last.close - 1) > maxDev) {
    return { ok: false, reason: "spot-outlier" };
  }
  return { ok: true };
}


/**
 * Phase 13 — feed-identity guard: a response whose prices sit outside the
 * instrument's sanity band is ANOTHER instrument's data (wrong cache,
 * mislabeled upstream response) — refuse it loudly instead of rendering it
 * silently. Pure and shared: the chart calls it after every load.
 */
export function assertPriceIdentity(
  inst: { symbol: string; priceBand?: [number, number] },
  bars: { close: number }[],
): void {
  if (!bars.length || !inst.priceBand) return;
  const [lo, hi] = inst.priceBand;
  const last = bars[bars.length - 1].close;
  if (!Number.isFinite(last) || last < lo || last > hi) {
    throw new Error(`FEED_IDENTITY: ${last} is outside ${inst.symbol}'s price band [${lo}, ${hi}] — refusing another instrument's data`);
  }
}
