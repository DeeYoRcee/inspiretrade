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
        let key = usernameKey;
        let snapshot = await get(ref(db, `publicProfiles/${key}`));
        // a moved profile leaves a redirect record at the old handle — follow it
        for (let hops = 0; hops < 2 && snapshot.exists(); hops++) {
          const val = snapshot.val() as PublicProfileSnapshot;
          if (val?.redirect && !val?.uid) {
            key = val.redirect;
            snapshot = await get(ref(db, `publicProfiles/${key}`));
          } else break;
        }
        if (!snapshot.exists()) return null;

        const profile = snapshot.val() as PublicProfileSnapshot;
        if (profile.usernameKey !== key || typeof profile.uid !== "string") return null;
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
        // carry the look & feel into the public snapshot: custom avatar
        // (users/{uid}/profile/avatar) with the auth photoURL as fallback,
        // plus held usernames / profile video / social handles
        let avatar: string | null = null;
        let profileFields: { usernames?: Record<string, { username: string }>; social?: { instagram?: string; telegram?: string; x?: string }; profileVideo?: string | null; avatarVideo?: string | null } = {};
        try {
          const { get: rtdbGet } = await import("firebase/database");
          const profileSnap = await rtdbGet(ref(db, `users/${user.uid}/profile`));
          const p = (profileSnap.val() || {}) as Record<string, any>;
          if (typeof p.avatar === "string" && p.avatar) avatar = p.avatar;
          if (p.usernames && typeof p.usernames === "object") profileFields.usernames = p.usernames;
          if (p.social && typeof p.social === "object") profileFields.social = p.social;
          if (typeof p.profileVideo === "string") profileFields.profileVideo = p.profileVideo;
          if (typeof p.avatarVideo === "string" && p.avatarVideo) profileFields.avatarVideo = p.avatarVideo;
        } catch { /* profile read is best-effort */ }
        if (!avatar) avatar = user.photoURL || null;

        updates[`publicProfiles/${usernameKey}`] = createPublicProfileSnapshot({
          uid: user.uid,
          username,
          displayName,
          trades,
          settings,
          avatar,
          profile: profileFields,
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
