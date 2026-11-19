import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, ref, update } from "firebase/database";
import { db } from "@/lib/firebase";
import { authedFetch } from "@/lib/api";
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

      // Phase 18/19 self-heal: admin username moves leave redirect records
      // with no uid at old handles — the security rules then deny the OWNER
      // any write there (data.uid check fails on a uid-less stub), so bio
      // saves and the public toggle die with PERMISSION_DENIED. Phase 19:
      // any user can now repair their OWN handle via repair-profile-stub
      // (server proves ownership against usernames/ + the held-username map);
      // the admin purge stays as the fallback for admins.
      const targetSnap = await get(ref(db, `publicProfiles/${usernameKey}`));
      const targetVal = targetSnap.val();
      if (targetSnap.exists() && targetVal && typeof targetVal === "object" && !targetVal.uid) {
        const locked = "Profile handle is locked by an incomplete rename — press Save again. If it still fails, contact support.";
        try {
          const res = await authedFetch<any>("/api/admin?action=repair-profile-stub", { key: usernameKey });
          if (!res?.ok) throw new Error("repair failed");
          const still = (await get(ref(db, `publicProfiles/${usernameKey}`))).val();
          if (still && typeof still === "object" && !still.uid) {
            // self-service repair did not clear it — try the admin purge path
            try {
              const adminRes = await authedFetch<any>("/api/admin?action=purge-profile-stubs", {});
              if (!adminRes?.ok) throw new Error("purge failed");
              const after = (await get(ref(db, `publicProfiles/${usernameKey}`))).val();
              if (after && typeof after === "object" && !after.uid) throw new Error("still locked");
            } catch {
              throw new Error(locked);
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Profile handle")) throw e;
          throw new Error(locked);
        }
      }
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
