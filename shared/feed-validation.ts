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

/**
 * Phase 30b — parse one hist day-shard row. writeShards serializes rows as
 * JSON arrays (JSON.stringify([t,o,h,l,c,v])), but the readers still split
 * plain CSV — every shard row read back as NaN and the chart deep layers
 * stayed EMPTY (live evidence: hist-status count=91197 with earliest=null).
 * Handles JSON-array rows AND legacy CSV rows; null for malformed input.
 */
export function parseShardRow(row: string): [number, number, number, number, number, number] | null {
  if (!row) return null;
  let a: unknown[];
  if (row.charCodeAt(0) === 91 /* [ */) {
    try {
      const v = JSON.parse(row);
      if (!Array.isArray(v)) return null;
      a = v as unknown[];
    } catch { return null; }
  } else {
    const c = row.split(",");
    a = [c[0], c[1], c[2], c[3], c[4], c[5]];
  }
  const t = Number(a[0]), o = Number(a[1]), h = Number(a[2]), l = Number(a[3]), c2 = Number(a[4]);
  if (![t, o, h, l, c2].every(Number.isFinite)) return null;
  if (t <= 0 || o <= 0 || h < Math.max(o, c2) || l > Math.min(o, c2)) return null;
  return [t, o, h, l, c2, Number(a[5]) || 0];
}

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

// ---------------------------------------------------------------------------
// Phase 20 — minute-series "price island" filter (the XAUUSD root cause).
//
// REAL-WORLD FAILURE (verified 2026-11-19): gold-api served a STALE price
// (~3655 vs the real ~3700-3740 market) stamped with a FRESH updatedAt for
// hours. The 1s recorder folded every bad tick into real minute candles, so
// the self-recorded store gained a dense flat run ~2% below the surrounding
// truth — on the chart it rendered as "separate candle groups" with
// unexplained gaps between them. The LIVE tail was already protected (the 2%
// spot-outlier guard), but the recorded history had no such protection.
//
// A provider glitch has a shape no real market produces: a SINGLE-MINUTE
// jump into the wrong level (>jumpPct — gold's worst real minutes stay below
// ~1%), an internally calm run at that level, and a single-minute jump back
// toward the pre-glitch level. A real regime change unfolds GRADUALLY (no
// 2% minute-to-minute jump), so it never creates an island and is never
// touched. Rule: reject the run between two consecutive >jumpPct close
// jumps iff it sits meaningfully away from the pre-run anchor AND the level
// after the run is closer to that anchor than the run itself was, within a
// bounded duration. Everything else passes untouched.
// ---------------------------------------------------------------------------

export interface IslandFilterResult {
  bars: RawBar[];
  /** bars dropped as glitch islands */
  rejected: number;
  /** [from, to] epoch-second ranges of every dropped run — diagnostics */
  ranges: { from: number; to: number }[];
}

export function minuteIslandFilter(
  bars: RawBar[],
  jumpPct = 0.02,
  maxIslandSec = 6 * 3600,
): IslandFilterResult {
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const out: RawBar[] = [];
  const ranges: { from: number; to: number }[] = [];
  let rejected = 0;
  const n = sorted.length;
  if (n < 3) return { bars: sorted, rejected, ranges };

  // a glitch is a STUCK provider price: the whole island stays within ±0.75%
  // of its initial level (the observed gold-api run: 3650-3665 = 0.36%) and
  // its per-minute high-low range is nearly zero — a real traded market never
  // sits that still for hours (gold's quietest real minutes range ~0.013%).
  const PLATEAU_BAND = 0.0075;
  const STUCK_RANGE_PCT = 0.0002; // mean per-minute range < 0.02% of price

  let keepFrom = 0; // first index not yet committed to `out`
  for (let j1 = 1; j1 < n; j1++) {
    const prev = sorted[j1 - 1].close;
    if (!(prev > 0) || Math.abs(sorted[j1].close / prev - 1) <= jumpPct) continue;
    if (j1 < keepFrom) continue; // already inside a rejected island
    // extend the island forward while the close stays on the plateau
    let j2 = j1 + 1; // first index AFTER the island
    while (
      j2 < n &&
      sorted[j2].time - sorted[j1].time <= maxIslandSec &&
      Math.abs(sorted[j2].close / sorted[j1].close - 1) <= PLATEAU_BAND
    ) j2++;
    const island = sorted.slice(j1, j2);
    const anchor = sorted[j1 - 1].close;
    const meanClose = island.reduce((s, x) => s + x.close, 0) / island.length;
    const islandDev = Math.abs(meanClose / anchor - 1);
    const meanRange = island.reduce((s, x) => s + (x.high - x.low), 0) / island.length;
    const stuck = meanRange / meanClose < STUCK_RANGE_PCT;
    const returnDev = j2 < n ? Math.abs(sorted[j2].close / anchor - 1) : Infinity;
    if (stuck && islandDev > jumpPct / 2 && returnDev < islandDev) {
      out.push(...sorted.slice(keepFrom, j1));
      rejected += island.length;
      ranges.push({ from: island[0].time, to: island[island.length - 1].time });
      keepFrom = j2;
      j1 = j2 - 1; // resume scanning right after the island (loop ++ lands on j2)
    }
  }
  out.push(...sorted.slice(keepFrom));
  return { bars: out, rejected, ranges };
}

/** Phase 25 §4 — share of close-only bars (O=H=L=C) in a series, 0..1.
 * Yahoo's FX 1m feed is close-only; a high share means the payload carries
 * observations, not genuine candles. Pure + framework-free so the server
 * chain, the client loader and the tests all share one definition. */
export function flatShare(bars: { open: number; high: number; low: number; close: number }[]): number {
  if (!bars.length) return 0;
  let flat = 0;
  for (const b of bars) {
    if (b.open === b.high && b.high === b.low && b.low === b.close) flat++;
  }
  return flat / bars.length;
}

// ---------------------------------------------------------------------------
// Phase 28 — foreign-price wick repair (the EURUSD D1 root cause).
//
// REAL-WORLD FAILURE (verified 2026-11-21): EURUSD's daily candle rendered
// with H=1.16023 while O/L/C all sat at the real ~1.0965 level. 1.16023 is a
// mid-2025 EUR/USD price — a truncated TrueFX big-figure row ("1.1"+"6023"
// string-concats to 1.16023) or a poisoned store bar inflated the live
// bucket's high, and max() is MONOTONIC: once painted, the fake wick stays
// forever. Every existing check passes such a bar (H ≥ max(O,C) holds — it
// is internally valid OHLC), and dedupe's widest-range-wins PREFERS it over
// the clean provider row.
//
// A corrupted extreme has a shape no real market produces: the WICK sits
// multiple robust-volatility units beyond BOTH neighbours' extremes while
// the BODY (open/close) agrees with the neighbourhood. A genuine crash day
// fails the body-agreement test (its close is far from the neighbours too)
// and is never touched. The repair narrows the impossible wick back to the
// bar's own body — the same "make the rendered candle MORE truthful" policy
// as the H/L envelope repair above, in the opposite direction: the wick
// never happened in reality, so removing it removes fabrication, not data.
// ---------------------------------------------------------------------------

export interface OutlierRepairResult {
  bars: RawBar[];
  /** bars whose High was narrowed to the body (foreign wick removed) */
  repairedHigh: number;
  /** bars whose Low was raised to the body (foreign wick removed) */
  repairedLow: number;
}

/**
 * Remove impossible wicks from a merged candle series. Robust scale =
 * median adjacent |Δclose| (a single wild bar cannot shift the median);
 * threshold K = max(1.2%, 6×median). Only repairs when the bar's whole body
 * sits inside the neighbourhood envelope — real volatility is never touched.
 */
export function repairOutlierExtremes(bars: RawBar[], minBars = 5): OutlierRepairResult {
  const out = bars.map((b) => ({ ...b }));
  let repairedHigh = 0;
  let repairedLow = 0;
  if (out.length < minBars) return { bars: out, repairedHigh, repairedLow };
  const diffs: number[] = [];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1].close;
    const b = out[i].close;
    if (a > 0 && b > 0) diffs.push(Math.abs(b / a - 1));
  }
  diffs.sort((x, y) => x - y);
  const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  const K = Math.max(0.012, med * 6);
  const finitePos = (x: number | undefined): x is number =>
    typeof x === "number" && Number.isFinite(x) && x > 0;
  for (let i = 0; i < out.length; i++) {
    const prev = out[i - 1];
    const next = out[i + 1];
    const hiRefs = [prev?.high, next?.high].filter(finitePos);
    const loRefs = [prev?.low, next?.low].filter(finitePos);
    if (!hiRefs.length || !loRefs.length) continue;
    const refHi = Math.max(...hiRefs);
    const refLo = Math.min(...loRefs);
    const b = out[i];
    const bodyHi = Math.max(b.open, b.close);
    const bodyLo = Math.min(b.open, b.close);
    const bodyInsideNeighbourhood = bodyHi <= refHi * (1 + K) && bodyLo >= refLo * (1 - K);
    if (!bodyInsideNeighbourhood) continue;
    if (b.high > refHi * (1 + K)) {
      b.high = bodyHi;
      repairedHigh++;
    }
    if (b.low < refLo * (1 - K)) {
      b.low = bodyLo;
      repairedLow++;
    }
  }
  return { bars: out, repairedHigh, repairedLow };
}

// ---------------------------------------------------------------------------
// Phase 29 — "frozen provider" run filter (the XAUUSD 1H/1M plateaus).
//
// REAL-WORLD FAILURE (verified 2026-11-21, user screenshots): gold-api froze
// at one level with a FRESH stamp for hours (a 3875 plateau on the 1H chart,
// a whole-day dot band on 1M). The Phase 20 island filter can't catch this
// shape: the provider froze AT the true level and the market LEFT — the run
// never "returns" to its anchor, which is that filter's core condition.
//
// The frozen run's shape (recorded-dot data): every bar near-zero range AND
// every per-bar step near-zero (the provider publishes one constant price),
// the run is LONG (≥ minRunSec — a real market never sits perfectly still
// that long), and it ENDS with a single-minute STEP (≥ stepPct) after which
// the price never comes back to the run's level within confirmSec. A smooth
// dot-drift day never produces the exit step, a provider-OHLC series never
// produces the flat run — both pass untouched. Rejecting the run leaves an
// honest gap where the provider lied, instead of a flat line that never
// happened.
// ---------------------------------------------------------------------------

export interface StaleRunResult {
  bars: RawBar[];
  /** bars dropped as frozen-provider runs */
  rejected: number;
  /** [from, to] epoch-second ranges of every dropped run — diagnostics */
  ranges: { from: number; to: number }[];
}

export interface StaleRunOpts {
  /** minimum run duration in seconds to qualify (default 45 min) */
  minRunSec?: number;
  /** per-bar range AND per-bar step bound that keeps a run "flat" (default 0.05%) */
  flatPct?: number;
  /** single-minute exit step that ends the run (default 0.1%) */
  stepPct?: number;
  /** after the exit step, the price must stay away this long (default 30 min) */
  confirmSec?: number;
}

export function staleRunFilter(bars: RawBar[], opts?: StaleRunOpts): StaleRunResult {
  const minRunSec = opts?.minRunSec ?? 45 * 60;
  const flatPct = opts?.flatPct ?? 0.0005;
  const stepPct = opts?.stepPct ?? 0.001;
  const confirmSec = opts?.confirmSec ?? 30 * 60;
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const ranges: { from: number; to: number }[] = [];
  let rejected = 0;
  const n = sorted.length;
  if (n < 8) return { bars: sorted, rejected, ranges };
  const drop = new Set<number>();
  let i = 1;
  while (i < n) {
    // A run starts at i only if i is itself flat (its STEP-IN from the
    // previous bar and its own range are ≤ flatPct) — a moving bar that
    // merely precedes the freeze is genuine data and stays in the chart.
    const stepIn = sorted[i - 1].close > 0 ? Math.abs(sorted[i].close / sorted[i - 1].close - 1) : 0;
    const rngIn = sorted[i].close > 0 ? (sorted[i].high - sorted[i].low) / sorted[i].close : 0;
    if (stepIn > flatPct || rngIn > flatPct) { i++; continue; }
    const start = i;
    let j = i + 1;
    while (j < n) {
      const prev = sorted[j - 1];
      const cur = sorted[j];
      const step = prev.close > 0 ? Math.abs(cur.close / prev.close - 1) : 0;
      const rng = cur.close > 0 ? (cur.high - cur.low) / cur.close : 0;
      if (step > flatPct || rng > flatPct) break;
      j++;
    }
    const runSec = j - 1 > start ? sorted[j - 1].time - sorted[start].time : 0;

    if (runSec >= minRunSec && j < n) {
      const run = sorted.slice(start, j);
      const runMean = run.reduce((s, x) => s + x.close, 0) / run.length;
      // the exit STEP that ends the run
      const exitStep = sorted[j - 1].close > 0
        ? Math.abs(sorted[j].close / sorted[j - 1].close - 1)
        : 0;
      // the market must have been ALIVE shortly before the freeze (a real
      // market moves around a genuine quiet stretch; a frozen feed replaces
      // a moving one) — some pre-run step within 60 min > 2×flatPct
      let aliveBefore = false;
      for (let k = start; k > 0 && sorted[start].time - sorted[k - 1].time <= 3600; k--) {
        const a = sorted[k - 1].close;
        const b = sorted[k].close;
        if (a > 0 && Math.abs(b / a - 1) > flatPct * 2) { aliveBefore = true; break; }
      }
      // the price must NOT return to the run's level within the confirm window
      const band = runMean * flatPct;
      let returned = false;
      for (let k = j; k < n && sorted[k].time - sorted[j - 1].time <= confirmSec; k++) {
        if (Math.abs(sorted[k].close - runMean) <= band) { returned = true; break; }
      }
      const postShift = runMean > 0 ? Math.abs(sorted[n - 1].close / runMean - 1) : 0;
      if (aliveBefore && exitStep >= stepPct && !returned && postShift >= stepPct) {
        for (let k = start; k < j; k++) drop.add(k);
        rejected += run.length;
        ranges.push({ from: run[0].time, to: run[run.length - 1].time });
        i = j + 1;
        continue;
      }
    }
    i = j > i ? j + 1 : i + 1;
  }
  if (!rejected) return { bars: sorted, rejected, ranges };
  return { bars: sorted.filter((_, k) => !drop.has(k)), rejected, ranges };
}
