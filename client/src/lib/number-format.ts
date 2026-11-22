/**
 * number-format — the "number format" terminal setting applied to quote
 * displays: plain (toFixed) or grouped (thin-space thousands separator).
 * Pure formatting — values themselves are never altered.
 */
/** P39 — INSP balances: fractional amounts stay visible (0.03 INSP, 0.0045
 *  INSP …) while large values stay compact (12.3K / 1.3M). */
export function formatINSP(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(n % 1_000 ? 1 : 0)}K`;
  const digits = n > 0 && n < 0.01 ? 4 : n > 0 && n < 1 ? 3 : 2;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatPriceValue(v: number | null | undefined, digits: number, grouped: boolean): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const fixed = v.toFixed(digits);
  if (!grouped) return fixed;
  const [int, dec] = fixed.split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return dec ? `${g}.${dec}` : g;
}
