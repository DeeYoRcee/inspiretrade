/**
 * PHASE 67 §8 (MEDIUM-6) — bounded fetch policy shared by authedFetch and
 * testable in isolation. The old authedFetch had NO timeout and NO retry: a
 * hanging serverless cold-start froze the chart's feed callbacks forever,
 * and a transient 503 (a Vercel instance recycling mid-request) surfaced as
 * a hard error even though the same GET succeeds 400ms later.
 *
 * Policy: network-level failures (abort/timeout/DNS/socket) and HTTP 5xx are
 * retried with a short linear backoff; HTTP 4xx NEVER is (the server made a
 * decision — retrying would only hammer it). POSTs default to zero retries:
 * mutations must not double-fire.
 */

export const FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const FETCH_RETRY_BACKOFF_MS = 400;

export function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

export function shouldRetryFetch(attempt: number, maxRetries: number, status: number | null, isNetworkError: boolean): boolean {
  if (attempt >= maxRetries) return false;
  if (isNetworkError) return true;
  return status != null && isRetryableStatus(status);
}
