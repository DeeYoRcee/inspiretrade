/**
 * P64R4 — single VIP predicate for server gates. Owner grants now expire:
 * a profile with premiumUntil in the past is NOT VIP even if isPremium is
 * still true (the verify endpoint clears it reactively, but gates must not
 * trust a stale flag between visits). Whop/lifetime/admin rows without
 * premiumUntil stay unlimited.
 */
export function isVipActive(p: Record<string, unknown> | null | undefined): boolean {
  if (!p) return false;
  if (p.ceo === true) return true;
  if (p.isPremium !== true) return false;
  const until = typeof p.premiumUntil === "number" ? p.premiumUntil : 0;
  return until === 0 || until > Date.now();
}
