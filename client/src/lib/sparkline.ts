/**
 * Phase 35 — tiny sparkline helpers (pure, dependency-free, node-testable).
 *
 * Watchlist rows show a mini daily-close line built ONLY from real provider
 * data: the shared quotes snapshot already fetches the daily bars for its
 * day-change math, so the sparkline series rides along at zero extra request
 * cost (see market-data.ts fetchQuotesSnapshot). No synthetic values ever.
 */

/** Extract a bounded close-series for a sparkline from real daily bars. */
export function extractSpark(bars: { close: number }[] | null | undefined, cap = 30): number[] | undefined {
  const closes = (bars || [])
    .map((b) => Number(b?.close))
    .filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 2) return undefined;
  if (closes.length <= cap) return closes;
  // downsample with a stride, then swap the last sampled point for the true
  // final close — the most recent price must survive and stay within cap
  const step = Math.ceil(closes.length / cap);
  const idxs: number[] = [];
  for (let i = 0; i < closes.length - 1; i += step) idxs.push(i);
  idxs[idxs.length - 1] = closes.length - 1;
  return idxs.map((i) => closes[i]);
}
