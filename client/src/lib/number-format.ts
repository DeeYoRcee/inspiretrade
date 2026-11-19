/**
 * number-format — the "number format" terminal setting applied to quote
 * displays: plain (toFixed) or grouped (thin-space thousands separator).
 * Pure formatting — values themselves are never altered.
 */
export function formatPriceValue(v: number | null | undefined, digits: number, grouped: boolean): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const fixed = v.toFixed(digits);
  if (!grouped) return fixed;
  const [int, dec] = fixed.split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return dec ? `${g}.${dec}` : g;
}
