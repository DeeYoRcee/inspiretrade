import { useQuery } from "@tanstack/react-query";
import { ref, get, set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";

export interface UserProfile {
  uid: string;
  username: string | null;
  isPremium: boolean;
  premiumPlan?: string;
  premiumSince?: number;
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
    refetchInterval: 30000,
  });
}

export async function saveUserProfile(uid: string, profile: Partial<UserProfile>) {
  const r = ref(db, `users/${uid}/profile`);
  const snap = await get(r);
  const existing = snap.exists() ? snap.val() : {};
  await set(r, { ...existing, ...profile, uid });
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
