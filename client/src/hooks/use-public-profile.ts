import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, ref, update } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import type { Trade } from "@/hooks/use-trades";
import {
  createPublicProfileSnapshot,
  createDefaultPublicProfileSettings,
  normalizePublicProfileSettings,
  type PublicProfileSettings,
  type PublicProfileSnapshot,
} from "@/lib/public-profile";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function usePublicProfileSettings() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["publicProfileSettings", user?.uid],
    queryFn: async (): Promise<PublicProfileSettings> => {
      if (!user) return createDefaultPublicProfileSettings();

      const snapshot = await get(ref(db, `privatePublicProfileSettings/${user.uid}`));
      return normalizePublicProfileSettings(snapshot.exists() ? snapshot.val() : null);
    },
    enabled: !!user,
  });
}

export function usePublicProfile(username: string) {
  const usernameKey = username.trim().toLowerCase();
  const validUsername = USERNAME_PATTERN.test(username);

  return useQuery({
    queryKey: ["publicProfile", usernameKey],
    queryFn: async (): Promise<PublicProfileSnapshot | null> => {
      const snapshot = await get(ref(db, `publicProfiles/${usernameKey}`));
      if (!snapshot.exists()) return null;

      const profile = snapshot.val() as PublicProfileSnapshot;
      if (profile.usernameKey !== usernameKey || typeof profile.uid !== "string") return null;
      return profile;
    },
    enabled: validUsername,
    retry: 1,
    staleTime: 30_000,
  });
}

export function useSavePublicProfile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      username,
      displayName,
      trades,
      settings,
    }: {
      username: string;
      displayName: string;
      trades: Trade[];
      settings: PublicProfileSettings;
    }) => {
      if (!user) throw new Error("Sign in to update your public profile.");
      if (!USERNAME_PATTERN.test(username)) throw new Error("Choose a valid username before publishing.");

      const usernameKey = username.toLowerCase();
      const previousUsernameKey = settings.publishedUsername?.toLowerCase() || null;
      const updates: Record<string, unknown> = {
        [`privatePublicProfileSettings/${user.uid}`]: {
          ...settings,
          publishedUsername: settings.enabled ? usernameKey : null,
          updatedAt: Date.now(),
        },
      };

      if (previousUsernameKey && previousUsernameKey !== usernameKey) {
        updates[`publicProfiles/${previousUsernameKey}`] = null;
      }

      if (settings.enabled) {
        updates[`publicProfiles/${usernameKey}`] = createPublicProfileSnapshot({
          uid: user.uid,
          username,
          displayName,
          trades,
          settings,
        });
      } else if (previousUsernameKey) {
        updates[`publicProfiles/${previousUsernameKey}`] = null;
      }

      await update(ref(db), updates);
      return { usernameKey, enabled: settings.enabled };
    },
    onSuccess: async ({ usernameKey }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["publicProfileSettings", user?.uid] }),
        queryClient.invalidateQueries({ queryKey: ["publicProfile", usernameKey] }),
      ]);
    },
  });
}
