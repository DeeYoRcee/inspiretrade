import { auth } from "@/lib/firebase";

/**
 * Fetch helper for economy/market API endpoints.
 * Attaches the caller's Firebase ID token so Vercel functions can verify
 * the user with the Admin SDK.
 */
export async function authedFetch<T = any>(path: string, body?: unknown): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  const token = await user.getIdToken();
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data?.message || data?.error || `Request failed (${res.status})`;
    const error = new Error(message) as Error & { code?: string };
    error.code = data?.error;
    throw error;
  }
  return data as T;
}
