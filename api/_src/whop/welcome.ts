/**
 * P64R user request — the VIP welcome bundle: the three case types
 * (Inspire · Gold · Trading) are granted ONCE, on the first premium grant,
 * so a new VIP member immediately has all three cases to open on the
 * Rewards page.
 *
 * Idempotent: a transaction claims the `profile/vipWelcomeBundle` flag
 * before any economy write, so the webhook and the verify-sync (which can
 * race) can never double-grant. Revoking premium does NOT take the bundle
 * back — it was granted on the first purchase.
 */
import { rtdb, logLedger } from "../lib/firebase";

export async function grantVipWelcomeBundle(uid: string, membershipId: string): Promise<boolean> {
  const db = rtdb();
  const now = Date.now();
  const token = `${uid}-${now}-${Math.floor(Math.random() * 1e9)}`;
  const claimTx = await db
    .ref(`users/${uid}/profile/vipWelcomeBundle`)
    .transaction((current: any) => {
      if (current?.granted === true) return; // already granted — abort
      return { granted: true, at: now, membershipId, token };
    });
  const claimed = claimTx?.committed && claimTx?.snapshot?.val?.()?.token === token;
  if (!claimed) return false;
  await db
    .ref(`economy/${uid}`)
    .transaction((eco: any) => ({
      ...eco,
      cases: (eco?.cases || 0) + 1,
      goldCases: (eco?.goldCases || 0) + 1,
      tradingCases: (eco?.tradingCases || 0) + 1,
      updatedAt: now,
    }));
  await logLedger({ type: "vip_welcome_bundle", uid, membershipId, cases: 3, at: now });
  return true;
}
