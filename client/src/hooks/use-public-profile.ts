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

      // Phase 20: resolve a redirect chain FIRST. Owner-grade username moves
      // (set-username) leave { redirect } stubs at old handles, and the
      // publish settings can still name a handle that has since moved — the
      // save then targeted a stub key, which the RTDB rules deny (the
      // data.uid check fails on a uid-less record) and died with the
      // "Profile handle is locked" error. The honest save target is the key
      // where the caller's OWN live snapshot actually sits.
      const followOwnChain = async (startKey: string): Promise<string> => {
        let key = startKey;
        for (let hops = 0; hops < 3; hops++) {
          const val = (await get(ref(db, `publicProfiles/${key}`))).val() as any;
          if (val && typeof val === "object" && val.uid === user.uid) return key; // live own snapshot
          if (val && typeof val === "object" && !val.uid && typeof val.redirect === "string") {
            key = String(val.redirect).toLowerCase(); // follow the redirect
            continue;
          }
          return startKey; // dead end — nothing of ours here
        }
        return startKey;
      };
      const saveKey = await followOwnChain(usernameKey);

      // Phase 18/19 self-heal (kept for stubs the redirect chain cannot
      // resolve): admin username moves leave redirect records with no uid at
      // old handles — the security rules then deny the OWNER any write there
      // (data.uid check fails on a uid-less stub), so bio saves and the
      // public toggle die with PERMISSION_DENIED. Any user repairs their OWN
      // handle via repair-profile-stub; the admin purge stays as the fallback.
      const saveSnap = (await get(ref(db, `publicProfiles/${saveKey}`))).val();
      if (saveSnap && typeof saveSnap === "object" && !(saveSnap as any).uid) {
        const locked = "Profile handle is locked by an incomplete rename — press Save again. If it still fails, contact support.";
        try {
          const res = await authedFetch<any>("/api/admin?action=repair-profile-stub", { key: saveKey });
          if (!res?.ok) throw new Error("repair failed");
          const still = (await get(ref(db, `publicProfiles/${saveKey}`))).val();
          if (still && typeof still === "object" && !still.uid) {
            // self-service repair did not clear it — try the admin purge path
            try {
              const adminRes = await authedFetch<any>("/api/admin?action=purge-profile-stubs", {});
              if (!adminRes?.ok) throw new Error("purge failed");
              const after = (await get(ref(db, `publicProfiles/${saveKey}`))).val();
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
          publishedUsername: settings.enabled ? saveKey : null,
          updatedAt: Date.now(),
        },
      };

      // clear a PREVIOUS published snapshot only when it is the caller's own
      // real record — a { redirect } stub stays put so old URLs keep working
      if (previousUsernameKey && previousUsernameKey !== saveKey) {
        const prevVal = (await get(ref(db, `publicProfiles/${previousUsernameKey}`))).val() as any;
        if (prevVal && typeof prevVal === "object" && prevVal.uid === user.uid) {
          updates[`publicProfiles/${previousUsernameKey}`] = null;
        }
      }

      if (settings.enabled) {
        // carry the look & feel into the public snapshot: custom avatar
        // (users/{uid}/profile/avatar) with the auth photoURL as fallback,
        // plus held usernames / profile video / social handles
        let avatar: string | null = null;
        let profileFields: { ceo?: boolean; usernames?: Record<string, { username: string }>; social?: { instagram?: string; telegram?: string; x?: string }; profileVideo?: string | null; avatarVideo?: string | null } = {};
        try {
          const { get: rtdbGet } = await import("firebase/database");
          const profileSnap = await rtdbGet(ref(db, `users/${user.uid}/profile`));
          const p = (profileSnap.val() || {}) as Record<string, any>;
          if (typeof p.avatar === "string" && p.avatar) avatar = p.avatar;
          if (p.ceo === true) profileFields.ceo = true;
          if (p.usernames && typeof p.usernames === "object") profileFields.usernames = p.usernames;
          if (p.social && typeof p.social === "object") profileFields.social = p.social;
          if (typeof p.profileVideo === "string") profileFields.profileVideo = p.profileVideo;
          if (typeof p.avatarVideo === "string" && p.avatarVideo) profileFields.avatarVideo = p.avatarVideo;
        } catch { /* profile read is best-effort */ }
        if (!avatar) avatar = user.photoURL || null;

        updates[`publicProfiles/${saveKey}`] = createPublicProfileSnapshot({
          uid: user.uid,
          // the snapshot must carry the KEY it is stored under — when the
          // settings handle moved (redirect-followed above), usernameKey has
          // to match saveKey or the public page's consistency check breaks
          username: saveKey,
          displayName,
          trades,
          settings,
          avatar,
          profile: profileFields,
        });
      } else if (previousUsernameKey) {
        // disabling — clear the LIVE published snapshot (follow the chain if
        // the settings handle has since moved), stubs stay for old URLs
        const liveKey = await followOwnChain(previousUsernameKey);
        const liveVal = (await get(ref(db, `publicProfiles/${liveKey}`))).val() as any;
        if (liveVal && typeof liveVal === "object" && liveVal.uid === user.uid) {
          updates[`publicProfiles/${liveKey}`] = null;
        }
      }

      await update(ref(db), updates);
      return { usernameKey: saveKey, enabled: settings.enabled };
    },
    onSuccess: async ({ usernameKey }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["publicProfileSettings", user?.uid] }),
        queryClient.invalidateQueries({ queryKey: ["publicProfile", usernameKey] }),
      ]);
    },
  });
}
