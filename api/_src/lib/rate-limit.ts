/**
 * PHASE 62 §7 — lightweight in-process sliding-window rate limiter for the
 * trading/support routes. Per serverless instance only (buckets reset on a
 * cold start and do not sync across instances) — it blunts abuse and
 * runaway loops, it is NOT a hard global quota. Firestore-side costs stay
 * bounded because every mutation is a single transaction.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  // opportunistic cleanup so the map cannot grow with unique keys
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
    }
  }
  return true;
}
