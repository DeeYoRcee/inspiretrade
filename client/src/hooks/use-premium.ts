import { useQuery } from "@tanstack/react-query";
import { ref, get, set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
import { parseWhopSubscription, type WhopSubscription } from "@/lib/whop";

export interface UserProfile {
  uid: string;
  username: string | null;
  isPremium: boolean;
  premiumPlan?: string;
  premiumSince?: number;
  /** display name (nick) — mirrors the Firebase Auth displayName so the
   *  server/public snapshot can read it without an Auth round-trip */
  displayName?: string | null;
  /** Small data-URL avatar uploaded from the profile page (RTDB stores it fine). */
  avatar?: string | null;
  /** Steam-style animated profile background — one of PROFILE_BACKGROUNDS ids. */
  background?: string | null;
  /** platform owner badge (stamped by the server on set-username) */
  ceo?: boolean;
  /** Telegram-collectible style: every handle this account holds */
  usernames?: Record<string, { username: string; at: number }>;
  /** profile video (CEO-only for now) — catalog id or a direct video URL */
  profileVideo?: string | null;
  /** uploaded avatar video (Telegram-style looping profile video) — data URL */
  avatarVideo?: string | null;
  /** social handles shown on the profile + public profile */
  social?: { instagram?: string; telegram?: string; x?: string };
}

export function useUserProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["userProfile", user?.uid],
    queryFn: async (): Promise<UserProfile | null> => {
      if (!user) return null;
      const r = ref(db, `users/${user.uid}/profile`);
      const snap = await get(r);
      if (!snap.exists()) {
        return { uid: user.uid, username: null, isPremium: false };
      }
      return snap.val() as UserProfile;
    },
    enabled: !!user,
  });
}

/** P45 §5/§6 — full subscription detail from the server-side verify endpoint.
 *  The server matches Whop memberships by verified ID-token identity and
 *  persists/syncs the Firebase entitlement; the client NEVER self-declares. */
export function useWhopSubscription() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["premiumStatus", user?.uid],
    queryFn: async (): Promise<WhopSubscription> => {
      if (!user) return { isPremium: false, plan: null, status: null, currentPeriodEnd: null, manageUrl: null, source: null };
      const res = await fetch("/api/whop?action=verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firebaseUid: user.uid }),
      });
      if (res.status === 401) {
        return { isPremium: false, plan: null, status: null, currentPeriodEnd: null, manageUrl: null, source: null };
      }
      if (!res.ok) throw new Error("Premium status request failed");
      return parseWhopSubscription(await res.json());
    },
    enabled: !!user,
    staleTime: 60 * 1000,
    retry: 1,
  });
}

/** boolean premium gate (same cache as useWhopSubscription) — the signature
 *  every existing consumer relies on stays a plain boolean */
export function usePremiumStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["premiumStatus", user?.uid],
    queryFn: async (): Promise<WhopSubscription> => {
      if (!user) return { isPremium: false, plan: null, status: null, currentPeriodEnd: null, manageUrl: null, source: null };
      const res = await fetch("/api/whop?action=verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firebaseUid: user.uid }),
      });
      if (res.status === 401) {
        return { isPremium: false, plan: null, status: null, currentPeriodEnd: null, manageUrl: null, source: null };
      }
      if (!res.ok) throw new Error("Premium status request failed");
      return parseWhopSubscription(await res.json());
    },
    enabled: !!user,
    staleTime: 60 * 1000,
    retry: 1,
    select: (d: WhopSubscription) => d.isPremium === true,
  });
}

export function useLeaderboard(period: string = "allTime") {
  return useQuery({
    queryKey: ["leaderboard", period],
    queryFn: async () => {
      const statsRef = ref(db, "siteStats/users");
      const statsSnap = await get(statsRef);
      if (!statsSnap.exists()) return [];

      const allStats = statsSnap.val() as Record<string, any>;

      const entries = await Promise.all(
        Object.entries(allStats).map(async ([uid, stats]) => {
          const profileRef = ref(db, `users/${uid}/profile`);
          const profileSnap = await get(profileRef);
          const profile: UserProfile | null = profileSnap.exists() ? profileSnap.val() : null;

          const periodStats = stats[period] || stats["allTime"] || { totalTrades: 0, wins: 0 };
          const winRate = periodStats.totalTrades > 0
            ? ((periodStats.wins / periodStats.totalTrades) * 100).toFixed(1)
            : "0.0";

          return {
            uid,
            username: profile?.username || null,
            isPremium: profile?.isPremium || false,
            totalTrades: periodStats.totalTrades || 0,
            wins: periodStats.wins || 0,
            winRate,
          };
        })
      );

      return entries
        .filter(e => e.totalTrades > 0)
        .sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate))
        .slice(0, 10);
    },
    refetchInterval: 60000,
  });
}

export async function saveUserProfile(uid: string, profile: Partial<UserProfile>) {
  const r = ref(db, `users/${uid}/profile`);
  const snap = await get(r);
  const existing = snap.exists() ? snap.val() : {};
  // RTDB rejects undefined values — drop them at every depth before set()
  const strip = (v: any): any =>
    Array.isArray(v) ? v.map(strip)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]))
    : v === undefined ? null : v;
  await set(r, { ...strip(existing), ...strip(profile), uid });
}

export async function checkUsernameAvailable(username: string): Promise<boolean> {
  const r = ref(db, "usernames/" + username.toLowerCase());
  const snap = await get(r);
  return !snap.exists();
}

export async function claimUsername(uid: string, username: string): Promise<boolean> {
  const available = await checkUsernameAvailable(username);
  if (!available) return false;
  const { update } = await import("firebase/database");
  const updates: Record<string, any> = {};
  updates[`usernames/${username.toLowerCase()}`] = uid;
  updates[`users/${uid}/profile/username`] = username;
  const { ref: dbRef, getDatabase } = await import("firebase/database");
  const { db } = await import("@/lib/firebase");
  await update(ref(db, "/"), updates);
  return true;
}
