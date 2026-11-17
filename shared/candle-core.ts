/**
 * candle-core — Phase 10 pure candle-series operations (no I/O, no React).
 *
 * Canonical implementations used by the client market-data feed AND the
 * test suite. Extracted from market-data.ts so the hot-path semantics
 * (in-place same-bucket updates, safe out-of-order inserts, reconnect
 * backoff) can be unit-tested directly against real-world scenarios.
 */

export interface CoreBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  // extra provider fields (takerBuy, …) survive via copy — no index signature
  // so client Bar interfaces stay structurally assignable
}

export interface UpsertHooks {
  /** a delivery carried the exact same OHLC for the current bucket (idempotent repeat) */
  onDuplicate?: () => void;
  /** a tick arrived OLDER than the newest bar (late resync frame) */
  onOutOfOrder?: () => void;
}

/**
 * Upsert one bar into the live series. Hot path: called on EVERY tick.
 *
 * Semantics (must hold for every timeframe):
 *  - same bucket as the newest bar → replace it IN PLACE (no copy, no sort);
 *    the current candle keeps updating until its timeframe closes;
 *  - newer bucket → append (exactly one new candle per timeframe transition);
 *  - older bucket → safe copy+insert (an out-of-order resync frame can never
 *    corrupt the tail or jump the chart backwards);
 *  - series is capped at `maxBars` from the LEFT (memory bound).
 */
export function upsertBar(
  bars: CoreBar[],
  bar: CoreBar,
  hooks?: UpsertHooks,
  maxBars = 6000,
): CoreBar[] {
  const last = bars.length ? bars[bars.length - 1] : null;
  if (last && bar.time === last.time) {
    if (
      last.open === bar.open && last.high === bar.high &&
      last.low === bar.low && last.close === bar.close
    ) {
      hooks?.onDuplicate?.();
    }
    bars[bars.length - 1] = bar;
    return bars;
  }
  if (last && bar.time < last.time) hooks?.onOutOfOrder?.();
  if (!last || bar.time > last.time) {
    bars.push(bar);
    if (bars.length > maxBars) bars.splice(0, bars.length - maxBars);
    return bars;
  }
  // rare out-of-order insert (resync path) — keep the safe copy+sort
  const out = bars.slice();
  const i = out.findIndex((b) => b.time === bar.time);
  if (i >= 0) out[i] = bar;
  else {
    out.push(bar);
    out.sort((a, b) => a.time - b.time);
    if (out.length > maxBars) out.splice(0, out.length - maxBars);
  }
  return out;
}

/**
 * Reconnect backoff for the market WebSocket: 1s → 2s → 4s → … capped at 15s.
 * Pure so the reconnection ladder is testable without sockets.
 */
export function wsBackoffDelay(previousMs: number, maxMs = 15000): number {
  return Math.min((previousMs <= 0 ? 1000 : previousMs) * 2, maxMs);
}

/**
 * Build the next WS endpoint index: an endpoint that never delivered a frame
 * is effectively blocked → rotate to the next mirror; a working endpoint
 * stays (transient disconnects must not flip hosts).
 */
export function nextEndpointIndex(currentIdx: number, count: number, endpointDelivered: boolean): number {
  if (endpointDelivered || count <= 0) return currentIdx;
  return (currentIdx + 1) % count;
}
