import { auth } from "@/lib/firebase";
import {
  FETCH_DEFAULT_TIMEOUT_MS,
  FETCH_RETRY_BACKOFF_MS,
  shouldRetryFetch,
} from "@shared/fetch-policy";

export interface AuthedFetchOpts {
  /** per-attempt abort timeout (default 15s — the old fetch could hang forever) */
  timeoutMs?: number;
  /** bounded retries for network errors / HTTP 5xx; defaults to 1 for GETs
   *  and 0 for POSTs (mutations must never double-fire) */
  retries?: number;
}

/**
 * Fetch helper for economy/market API endpoints.
 * Attaches the caller's Firebase ID token so Vercel functions can verify
 * the user with the Admin SDK.
 *
 * PHASE 67 (MEDIUM-6): every attempt is bounded by an AbortController
 * timeout, and idempotent GETs retry once on network errors / 5xx with a
 * short backoff — a hanging cold-start or a recycling instance no longer
 * freezes the feed path that renders the chart.
 */
export async function authedFetch<T = any>(path: string, body?: unknown, opts?: AuthedFetchOpts): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  const token = await user.getIdToken();
  const maxRetries = opts?.retries ?? (body === undefined ? 1 : 0);
  const timeoutMs = opts?.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, FETCH_RETRY_BACKOFF_MS * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | null = null;
    let networkError = false;
    try {
      const res = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      status = res.status;
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const message = data?.message || data?.error || `Request failed (${res.status})`;
        const error = new Error(message) as Error & { code?: string; status?: number };
        error.code = data?.error;
        error.status = res.status;
        lastErr = error;
        // 4xx = the server decided — never retried; 5xx may be a transient
        // instance recycle, one bounded retry is safe for idempotent GETs
        if (!shouldRetryFetch(attempt, maxRetries, res.status, false)) throw error;
        continue;
      }
      return data as T;
    } catch (e) {
      if ((e as any)?.status != null) throw e; // already-decided HTTP error rethrown above
      networkError = true; // abort (timeout) / DNS / socket — retryable for GETs
      lastErr = e;
      if (!shouldRetryFetch(attempt, maxRetries, null, networkError)) {
        const wrapped = new Error(
          e instanceof DOMException && e.name === "AbortError"
            ? `Request timed out after ${timeoutMs}ms`
            : String((e as Error)?.message || e),
        ) as Error & { code?: string };
        throw wrapped;
      }
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
