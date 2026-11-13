/**
 * Client-side referral helpers.
 *
 * Flow: a visitor lands on `/?ref=CODE` → the code is captured into
 * localStorage (and cleaned from the URL). After the visitor creates a NEW
 * account (< 15 min old) the ReferralApplier posts it to
 * /api/referral?action=apply, which only RECORDS who invited whom —
 * no INSP or cases are granted (rewards disabled by product decision).
 */

const REF_KEY = "inspire_ref";
const CODE_RE = /^[A-Za-z0-9]{4,10}$/;

/** Read ?ref=CODE from the URL into localStorage (once, on app mount). */
export function captureRefFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const refCode = params.get("ref");
    if (!refCode || !CODE_RE.test(refCode)) return;
    localStorage.setItem(REF_KEY, refCode.toUpperCase());
    params.delete("ref");
    const qs = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  } catch {
    // private mode / storage disabled — referral silently unavailable
  }
}

/** Take the stored referral code out of localStorage (leaves it on failure). */
export function popStoredRef(): string | null {
  try {
    return localStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
}

export function clearStoredRef(): void {
  try {
    localStorage.removeItem(REF_KEY);
  } catch {}
}

export function referralLink(code: string): string {
  return `${window.location.origin}/?ref=${code}`;
}
