import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { updateProfile } from "firebase/auth";
import { ref, getDatabase } from "firebase/database";
import { MediaLightbox } from "@/components/media-lightbox";
import type { PublicProfileSettings } from "@/lib/public-profile";
import {
  Award, Camera, Clapperboard, Copy, Crown, Globe2, Instagram, Loader2, Package, Pencil, Send, Trash2, Twitter, Video, Activity, Target, TrendingUp, TrendingDown, CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { saveUserProfile, useUserProfile } from "@/hooks/use-premium";
import { useInventory } from "@/hooks/use-economy";
import { ALL_FRAGMENTS } from "@shared/fragments";
import { useTrades } from "@/hooks/use-trades";
import { usePublicProfileSettings, useSavePublicProfile } from "@/hooks/use-public-profile";
import { authedFetch } from "@/lib/api";
import { UsernameDialog } from "@/components/dashboard/UsernameDialog";
import { BackgroundPickerDialog } from "@/components/profile/BackgroundPickerDialog";
import { createPublicProfileSnapshot, createDefaultPublicProfileSettings } from "@/lib/public-profile";
import { ProfilePresentation } from "@/components/public-profile/ProfilePresentation";

const USERNAME_TEST = /^[a-zA-Z0-9_]{3,20}$/;
import { getProfileBackground, PROFILE_BACKGROUNDS } from "@/lib/profile-backgrounds";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * Telegram-style profile screen. Everything lives here now: the edit dialog
 * (avatar upload, bio, username, public-profile toggle) mirrors Telegram's
 * "Edit profile" sheet, so the separate settings page stays optional.
 */

// Telegram's official avatar gradient palette.
const AVATAR_GRADIENTS: [string, string][] = [
  ["#FF885E", "#FF516A"],
  ["#FFCD6A", "#FFA85C"],
  ["#82B1FF", "#665FFF"],
  ["#A0DE7E", "#54CB68"],
  ["#53EDD6", "#28C9B7"],
  ["#72D5FD", "#2A9EF1"],
  ["#E0A2F3", "#D669ED"],
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("");
}

function gradientFor(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

/** Center-crop any image file to a 256px JPEG data URL (small enough for RTDB). */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode-failed"));
    image.src = dataUrl;
  });
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function InfoRow({
  label,
  value,
  valueClass,
  action,
}: {
  label: string;
  value: string;
  valueClass?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("mt-0.5 truncate text-[15px] font-medium", valueClass)}>{value}</p>
      </div>
      {action}
    </div>
  );
}

/** Phase 34: graphical stat card — icon, gradient wash and a mini progress
 * bar (win rate) while keeping the exact same position in the layout. */
function StatCell({
  label, value, tone, icon: Icon, iconTone, ring, ringTone,
}: {
  label: string;
  value: string;
  tone?: string;
  icon?: typeof Crown;
  iconTone?: string;
  /** 0..1 — renders a mini progress bar under the value */
  ring?: number;
  ringTone?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-b from-primary/[0.06] to-transparent px-2 py-3 text-center transition-colors hover:border-primary/40">
      {Icon && (
        <div className="mx-auto mb-1 flex h-7 w-7 items-center justify-center rounded-lg border border-border/50 bg-card/70">
          <Icon className={cn("h-3.5 w-3.5", iconTone)} />
        </div>
      )}
      <p className={cn("font-number text-lg font-bold leading-tight", tone)}>{value}</p>
      <p className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground">{label}</p>
      {ring != null && (
        <div className="mx-auto mt-1.5 h-1 w-4/5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-[width] duration-700"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, ring)) * 100)}%`, background: ringTone || "hsl(var(--primary))" }}
          />
        </div>
      )}
    </div>
  );
}

export default function ProfilePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data: profile } = useUserProfile();
  const { data: inventory } = useInventory();
  const ownedFragments = useMemo(
    () => Object.entries(inventory || {}).filter(([, n]) => (n ?? 0) > 0) as [string, number][],
    [inventory],
  );
  const { data: trades } = useTrades();
  const { data: settings } = usePublicProfileSettings();
  const savePublicProfile = useSavePublicProfile();

  const [editOpen, setEditOpen] = useState(false);
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);
  const [bioDraft, setBioDraft] = useState("");
  // Phase 20: the display name (nick) is editable in the same dialog —
  // saved to Firebase Auth (updateProfile) AND the RTDB profile
  const [nameDraft, setNameDraft] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  // Telegram-style: tap the avatar photo/video → full-screen viewer
  const [mediaView, setMediaView] = useState<{ src: string; kind: "image" | "video" } | null>(null);
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  const [igDraft, setIgDraft] = useState("");
  const [tgDraft, setTgDraft] = useState("");
  const [xDraft, setXDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayName = user?.displayName || profile?.displayName || profile?.username || user?.email?.split("@")[0] || "Trader";
  const username = profile?.username || null;

  // Phase 31: the profile page mirrors the published public profile — one
  // live snapshot built with the SAME builder the public page gets written
  // with, so "what I see here" == "what everyone sees at /@handle".
  const publicSnapshot = useMemo(() => {
    if (!settings?.enabled || !username || !user) return null;
    return createPublicProfileSnapshot({
      uid: user.uid,
      username,
      displayName,
      trades: trades ?? [],
      settings,
      avatar: profile?.avatar ?? null,
      profile: {
        ceo: profile?.ceo,
        vip: !!(profile?.isPremium || profile?.premiumPlan),
        usernames: profile?.usernames,
        social: profile?.social,
        profileVideo: profile?.profileVideo,
        avatarVideo: profile?.avatarVideo,
      },
    });
  }, [settings, username, user, displayName, trades, profile]);

  // visibility chips — flip one flag and REPUBLISH (the public snapshot and
  // this mirror must move together; the save flow handles redirect stubs)
  const [pubBusy, setPubBusy] = useState(false);
  const toggleVisibility = (flag: "statistics" | "winRate" | "history" | "notes") => {
    if (!settings || !username || pubBusy) return;
    const next = { ...settings, visibility: { ...settings.visibility, [flag]: !settings.visibility[flag] } };
    setPubBusy(true);
    savePublicProfile
      .mutateAsync({ username, displayName, trades: trades ?? [], settings: next })
      .catch(() => { /* the toast lives inside the save flow */ })
      .finally(() => setPubBusy(false));
  };
  const gradient = useMemo(() => gradientFor(user?.uid || displayName), [user?.uid, displayName]);
  const initials = useMemo(() => initialsOf(displayName), [displayName]);
  const avatarSrc = profile?.avatar || user?.photoURL || null;
  // uploaded looping avatar video (Telegram-style) — wins over everything.
  // Phase 33: `media:{hash}` ids (VIP uploads) resolve to the public media endpoint.
  const avatarVideoSrc = useMemo(() => {
    const v = profile?.avatarVideo;
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    const m = /^media:([a-f0-9]{8,64})$/.exec(v);
    if (m) return `/api/admin?action=media-get&id=${m[1]}`;
    return v; // legacy data URL
  }, [profile?.avatarVideo]);
  // Phase 33: video avatars are a VIP feature (server-enforced on media-upload)
  const canUploadVideo = !!(profile?.ceo || profile?.isPremium || profile?.premiumPlan);
  // Telegram-collectible style: every handle this account holds
  const heldUsernames = useMemo(
    () => Object.entries(profile?.usernames || {})
      .map(([key, v]) => ({ key: key.toLowerCase(), username: v?.username || key }))
      .sort((a, b) => (a.key === username?.toLowerCase() ? -1 : b.key === username?.toLowerCase() ? 1 : 0)),
    [profile?.usernames, username],
  );
  // profile video (CEO-only): catalog id or a direct video URL
  const profileVideoSrc = useMemo(() => {
    const v = profile?.profileVideo;
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    return PROFILE_BACKGROUNDS.find((b) => b.id === v)?.src || null;
  }, [profile?.profileVideo]);

  const memberSince = useMemo(() => {
    const ts = user?.metadata?.creationTime;
    if (!ts) return "—";
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  }, [user?.metadata?.creationTime]);

  const stats = useMemo(() => {
    const list = trades ?? [];
    const wins = list.filter((tr) => tr.profit > 0).length;
    const netPnl = list.reduce((sum, tr) => sum + tr.profit, 0);
    return {
      total: list.length,
      winRate: list.length ? `${Math.round((wins / list.length) * 100)}%` : "—",
      netPnl,
      wins, // Phase 34: win-rate mini bar
    };
  }, [trades]);

  const publishedUsername = settings?.publishedUsername;
  const isEnabled = settings?.enabled === true;
  const publicUrl = publishedUsername && typeof window !== "undefined"
    ? `${window.location.origin}/@${publishedUsername}`
    : "";
  const bio = (settings?.strategy || "").trim();
  const profileBackground = getProfileBackground(profile?.background);

  const copyLink = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast({ title: t("publicProfileLinkCopied") });
    } catch {
      toast({ title: t("error"), description: publicUrl, variant: "destructive" });
    }
  };

  const openEdit = () => {
    setBioDraft(bio);
    // prefill the social handles + the display name (nick)
    setIgDraft(profile?.social?.instagram || "");
    setTgDraft(profile?.social?.telegram || "");
    setXDraft(profile?.social?.x || "");
    setNameDraft(user?.displayName || profile?.displayName || "");
    setEditOpen(true);
  };

  const onAvatarPicked = async (file?: File | null) => {
    if (!file || !user) return;
    // Telegram-style avatar: the SAME picker accepts a photo OR a short
    // looping video — the video plays muted inside the avatar circle.
    if (file.type.startsWith("video/")) {
      if (!canUploadVideo) {
        toast({ title: t("profileVideoVipOnly"), variant: "destructive" });
        return;
      }
      if (file.size > 6 * 1024 * 1024) {
        toast({ title: t("fileTooLarge"), description: t("profileVideoTooLarge"), variant: "destructive" });
        return;
      }
      setAvatarBusy(true);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("read-failed"));
          reader.readAsDataURL(file);
        });
        // avatar and avatarVideo are mutually exclusive — a video replaces the photo.
        // Phase 33: CEO/VIP upload content-addressed (media:{hash}) — RTDB rules
        // cap avatarVideo at 300 chars, so data URLs only work for tiny files.
        let stored: string = dataUrl;
        try {
          const res = await authedFetch<{ ok?: boolean; id?: string; error?: string }>("/api/admin?action=media-upload", { data: dataUrl });
          if (res?.ok && res.id) stored = `media:${res.id}`;
        } catch {
          // not VIP-shaped / network — fall back to the direct write (rules decide)
        }
        await saveUserProfile(user.uid, { avatarVideo: stored, avatar: null });
        queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
        await republishIfEnabled();
        toast({ title: t("profileSaved") });
      } catch {
        toast({ title: t("error"), variant: "destructive" });
      } finally {
        setAvatarBusy(false);
      }
      return;
    }
    if (!file.type.startsWith("image/")) return;
    if (file.size > 3 * 1024 * 1024) {
      toast({ title: t("fileTooLarge"), description: t("max3mbAllowed"), variant: "destructive" });
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      await saveUserProfile(user.uid, { avatar: dataUrl, avatarVideo: null });
      queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
      await republishIfEnabled();
      toast({ title: t("profileSaved") });
    } catch {
      toast({ title: t("error"), variant: "destructive" });
    } finally {
      setAvatarBusy(false);
    }
  };

  const onAvatarRemove = async () => {
    if (!user || avatarBusy) return;
    setAvatarBusy(true);
    try {
      await saveUserProfile(user.uid, { avatar: null, avatarVideo: null });
      queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
      await republishIfEnabled();
      toast({ title: t("profileSaved") });
    } catch {
      toast({ title: t("error"), variant: "destructive" });
    } finally {
      setAvatarBusy(false);
    }
  };

  /** Persist the picked background into the private public-profile settings
   *  and re-publish the public snapshot so visitors see it immediately. */
  const publishBackgroundSettings = async (background: string | null) => {
    const base = settings ?? createDefaultPublicProfileSettings();
    const merged = { ...base, background };
    if (merged.enabled && username) {
      await savePublicProfile.mutateAsync({
        username,
        displayName: user?.displayName || username,
        trades: trades ?? [],
        settings: merged,
      });
    } else {
      const { update } = await import("firebase/database");
      const { db } = await import("@/lib/firebase");
      await update(ref(db, "/"), {
        [`privatePublicProfileSettings/${user!.uid}`]: { ...merged, updatedAt: Date.now() },
      });
      await queryClient.invalidateQueries({ queryKey: ["publicProfileSettings"] });
    }
  };

  /** Re-publish the public snapshot after avatar/video/social changed — the
   *  snapshot only carries these AT publish time, so without this the public
   *  page would show stale assets until the user toggled something. */
  const republishIfEnabled = async () => {
    if (!user || !isEnabled || !publishedUsername) return;
    await savePublicProfile.mutateAsync({
      username: publishedUsername,
      displayName: user?.displayName || publishedUsername,
      trades: trades ?? [],
      settings: settings ?? createDefaultPublicProfileSettings(),
    });
  };

  const onBackgroundSaved = (background: string | null) => {
    if (!user) return;
    queryClient.setQueryData(["userProfile", user.uid], (old: any) =>
      old ? { ...old, background } : old);
    queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
  };

  const saveBio = async () => {
    if (!user) return;
    // Phase 20: the nick saves FIRST and independently of the public profile —
    // it must never be blocked by the username requirement. Firebase Auth
    // (updateProfile) is what the whole UI reads; the RTDB profile mirrors it
    // for the server/public snapshot. updateProfile never needs a fresh login.
    const cleanName = nameDraft.trim().replace(/\s+/g, " ").slice(0, 40);
    const prevName = user.displayName || profile?.displayName || "";
    let effectiveName = prevName;
    if (cleanName && cleanName !== prevName) {
      try {
        await updateProfile(user, { displayName: cleanName });
        await saveUserProfile(user.uid, { displayName: cleanName });
        queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
        effectiveName = cleanName;
      } catch {
        toast({ title: t("error"), variant: "destructive" });
      }
    }
    if (!username) {
      setEditOpen(false);
      setUsernameDialogOpen(true);
      toast({ title: t("publicProfileUsernameRequired") });
      return;
    }
    try {
      // social handles + profile video persist to the private profile first
      const clean = (v: string) => v.trim().replace(/^@/, "").slice(0, 40);
      // only defined keys — RTDB set() rejects undefined values outright
      // (this is what made "some error" toast appear for every bio save with
      // an empty social field)
      const social: Record<string, string> = {};
      if (clean(igDraft)) social.instagram = clean(igDraft);
      if (clean(tgDraft)) social.telegram = clean(tgDraft);
      if (clean(xDraft)) social.x = clean(xDraft);
      await saveUserProfile(user.uid, { social });
      queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });

      // Phase 18: the bio is PRIVATE by default — it lives in the user's own
      // settings node and saves WITHOUT a public username. The public
      // snapshot only updates when the profile is actually published, so a
      // bio can never again be blocked by username/redirect problems.
      const base = settings ?? createDefaultPublicProfileSettings();
      const strategy = bioDraft.trim();
      const nextSettings: PublicProfileSettings = {
        ...base,
        strategy,
        visibility: { ...base.visibility, strategy: strategy ? true : base.visibility.strategy },
      };
      const { update: rtdbUpdate } = await import("firebase/database");
      await rtdbUpdate(ref(getDatabase(), `privatePublicProfileSettings/${user.uid}`), {
        ...nextSettings,
        updatedAt: Date.now(),
      });
      if (nextSettings.enabled && username && USERNAME_TEST.test(username)) {
        await savePublicProfile.mutateAsync({
          username,
          // the freshly typed nick wins — the Auth user object may not have
          // re-emitted yet at this point
          displayName: effectiveName || username,
          trades: trades ?? [],
          settings: nextSettings,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["publicProfileSettings", user.uid] });
      toast({ title: t("profileSaved") });
    } catch (error) {
      toast({
        title: t("error"),
        description: error instanceof Error ? error.message : t("publicProfileSaveFailed"),
        variant: "destructive",
      });
    }
  };

  const togglePublic = async (next: boolean) => {
    if (!user) return;
    if (next && !username) {
      setUsernameDialogOpen(true);
      toast({ title: t("publicProfileUsernameRequired") });
      return;
    }
    const current = settings ?? createDefaultPublicProfileSettings();
    // First publish: share the interesting sections so the public page is not empty.
    const visibility = next && !Object.values(current.visibility).some(Boolean)
      ? { statistics: true, strategy: true, winRate: true, history: true, notes: false }
      : current.visibility;
    try {
      await savePublicProfile.mutateAsync({
        username: username as string,
        displayName: user.displayName || (username as string),
        trades: trades ?? [],
        settings: { ...current, enabled: next, visibility },
      });
      toast({ title: next ? t("publicProfileUpdated") : t("profileSaved") });
    } catch (error) {
      toast({
        title: t("error"),
        description: error instanceof Error ? error.message : t("publicProfileSaveFailed"),
        variant: "destructive",
      });
    }
  };

  // Phase 30: CEO = RED stroke/badge (platform owner), VIP = GOLD stroke/badge
  // (paid premium membership). A CEO who is also premium shows both badges.
  const isVip = !!(profile?.isPremium || profile?.premiumPlan);
  const strokeTone = profile?.ceo
    ? { border: "border-red-500", section: "border-red-500/70 shadow-[0_0_28px_rgba(239,68,68,0.18)]", avatar: "border-red-500 shadow-[0_0_18px_rgba(239,68,68,0.35)]" }
    : isVip
      ? { border: "border-amber-400", section: "border-amber-400/80 shadow-[0_0_28px_rgba(251,191,36,0.18)]", avatar: "border-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.35)]" }
      : { border: "border-background", section: "border-border/50", avatar: "border-background" };
  const pnlTone = stats.netPnl > 0 ? "text-emerald-500" : stats.netPnl < 0 ? "text-red-500" : undefined;
  const pnlText = stats.total
    ? `${stats.netPnl >= 0 ? "+" : "-"}$${Math.abs(stats.netPnl).toFixed(2)}`
    : "—";

  return (
    <div className="container mx-auto max-w-md space-y-4 px-4 py-6">
      {/* Telegram-style banner — animated background like Steam */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className={cn(
          "relative isolate overflow-hidden rounded-3xl border pb-6 pt-10 text-center",
          // Phase 19: CEO accounts get a permanent gold stroke on their profile
          strokeTone.section,
        )}
        style={profileBackground ? { background: profileBackground.tint } : undefined}
      >
        {profileBackground && (
          <>
            <video
              src={profileBackground.src}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              aria-hidden
              className="absolute inset-0 -z-10 h-full w-full object-cover opacity-55"
            />
            <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background/80 via-background/20 to-background/40" />
          </>
        )}
        {!profileBackground && (
          <div
            className="absolute inset-0 opacity-20"
            style={{ background: `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})` }}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={openEdit}
          aria-label={t("profileEdit")}
          className="absolute right-3 top-3 z-10 gap-1.5 rounded-full text-muted-foreground"
        >
          <Pencil className="h-4 w-4" />
          <span className="text-xs">{t("profileEdit")}</span>
        </Button>
        <div className="relative">
          {avatarVideoSrc || profileVideoSrc ? (
            <video
              src={avatarVideoSrc || profileVideoSrc!}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              onClick={() => setMediaView({ src: avatarVideoSrc || profileVideoSrc!, kind: "video" })}
              className={cn(
                "mx-auto h-24 w-24 cursor-zoom-in rounded-full border-4 object-cover shadow-lg",
                strokeTone.avatar,
              )}
            />
          ) : avatarSrc ? (
            <img
              src={avatarSrc}
              alt={displayName}
              onClick={() => setMediaView({ src: avatarSrc, kind: "image" })}
              className={cn(
                "mx-auto h-24 w-24 cursor-zoom-in rounded-full border-4 object-cover shadow-lg",
                strokeTone.avatar,
              )}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              className={cn(
                "mx-auto flex h-24 w-24 items-center justify-center rounded-full border-4 text-3xl font-bold text-white shadow-lg",
                strokeTone.border,
              )}
              style={{ background: `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})` }}
            >
              {initials}
            </div>
          )}
          <h1 className="mt-4 text-xl font-bold tracking-tight">{displayName}</h1>
          {/* Phase 32b: Telegram-style badge to the RIGHT of the handle */}
          <div className="mt-0.5 flex items-center justify-center gap-1.5">
            <p className="text-[15px] font-medium text-[#3390ec]">
              {username ? `@${username}` : t("profileNoUsername")}
            </p>
            {profile?.ceo && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-red-500/60 bg-red-500/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-red-400" title="CEO">
                <Crown className="h-2.5 w-2.5" />CEO
              </span>
            )}
            {!profile?.ceo && isVip && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-400/60 bg-amber-400/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-amber-300" title="VIP">
                <Crown className="h-2.5 w-2.5" />VIP
              </span>
            )}
          </div>
          {/* Telegram-collectible style — every handle this account holds */}
          {heldUsernames.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 px-6">
              {heldUsernames.slice(0, 10).map((u) => (
                <span
                  key={u.key}
                  className={cn(
                    "inline-flex max-w-[130px] items-center truncate rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                    u.key === username?.toLowerCase()
                      ? "border-[#3390ec]/40 bg-[#3390ec]/15 text-[#3390ec]"
                      : "border-border/60 bg-black/25 text-white/70",
                  )}
                >
                  @{u.username}
                </span>
              ))}
            </div>
          )}
          {/* social handles — Instagram / Telegram / X */}
          {(profile?.social?.instagram || profile?.social?.telegram || profile?.social?.x) && (
            <div className="mt-2.5 flex items-center justify-center gap-2">
              {profile?.social?.instagram && (
                <a
                  href={`https://instagram.com/${profile.social.instagram}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white/80 transition-colors hover:bg-black/50 hover:text-white"
                >
                  <Instagram className="h-4 w-4" />
                </a>
              )}
              {profile?.social?.telegram && (
                <a
                  href={`https://t.me/${profile.social.telegram}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Telegram"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white/80 transition-colors hover:bg-black/50 hover:text-white"
                >
                  <Send className="h-4 w-4" />
                </a>
              )}
              {profile?.social?.x && (
                <a
                  href={`https://x.com/${profile.social.x}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="X"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white/80 transition-colors hover:bg-black/50 hover:text-white"
                >
                  <Twitter className="h-4 w-4" />
                </a>
              )}
            </div>
          )}
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {profile?.isPremium && <Crown className="h-3.5 w-3.5 text-amber-400" />}
            {profile?.isPremium ? t("profilePremium") : t("profileStatus")}
          </p>
        </div>
      </motion.section>

      {/* Stat chips — streak replaced by registration date */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="grid grid-cols-4 gap-2"
      >
        <StatCell label={t("totalTrades")} value={String(stats.total)} icon={Activity} iconTone="text-sky-400" />
        <StatCell
          label={t("winRate")}
          value={stats.winRate}
          icon={Target}
          iconTone="text-emerald-400"
          ring={stats.total ? stats.wins / stats.total : 0}
          ringTone="hsl(var(--success))"
        />
        <StatCell
          label={t("netPnl")}
          value={pnlText}
          tone={pnlTone}
          icon={stats.netPnl >= 0 ? TrendingUp : TrendingDown}
          iconTone={stats.netPnl >= 0 ? "text-emerald-400" : "text-red-400"}
          ring={stats.total ? Math.min(1, Math.abs(stats.netPnl) / Math.max(1, Math.abs(stats.netPnl))) : 0}
          ringTone={stats.netPnl >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))"}
        />
        <StatCell label={t("profileMemberSince")} value={memberSince} icon={CalendarDays} iconTone="text-violet-400" />
      </motion.div>

      {/* Phase 31: Telegram-style public-profile mirror — when the public
          profile is published, the profile page renders the EXACT same
          presentation everyone else sees, driven by the same visibility
          toggles (statistics / winRate / history / notes). Profit & loss
          details stay hideable: turning Statistics or History off here
          removes them from BOTH this view and the public page. */}
      {settings?.enabled && username && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.08 }}
          className="space-y-2"
        >
          <div className="flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("profilePublicPreview")}
            </p>
            <div className="flex items-center gap-1">
              {([["statistics", t("publicProfileStatistics")], ["winRate", t("publicProfileWinRate")], ["history", t("publicProfileHistory")], ["notes", t("publicProfileNotes")]] as const).map(([flag, lbl]) => (
                <button
                  key={flag}
                  disabled={pubBusy}
                  title={t("publicProfileVisibility")}
                  onClick={() => toggleVisibility(flag)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-50",
                    settings.visibility[flag]
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                      : "border-border/60 bg-black/25 text-muted-foreground",
                  )}
                >
                  {lbl.replace(/Description$/, "")}
                </button>
              ))}
            </div>
          </div>
          <ProfilePresentation profile={publicSnapshot!} />
        </motion.section>
      )}

      {/* Telegram-style info card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="divide-y divide-border/50 rounded-3xl border border-border/50 bg-card/60"
      >
        <InfoRow
          label={t("profileBio")}
          value={bio || t("profileBioEmpty")}
          valueClass={bio ? undefined : "text-muted-foreground"}
        />
        {/* INSP balance + Cases rows removed per user request — not shown on
            the profile card anymore */}
        <InfoRow
          label={t("publicProfileLink")}
          value={publicUrl ? publicUrl.replace(/^https?:\/\//, "") : t("profileNotPublished")}
          valueClass={publicUrl ? "text-[#3390ec]" : "text-muted-foreground"}
          action={publicUrl ? (
            <Button variant="ghost" size="icon" onClick={copyLink} aria-label={t("publicProfileShare")} className="h-9 w-9 shrink-0 rounded-full text-[#3390ec]">
              <Copy className="h-4 w-4" />
            </Button>
          ) : undefined}
        />
      </motion.div>

      {/* Actions */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.15 }}
        className="grid gap-2 sm:grid-cols-2"
      >
        <Button className="rounded-xl" onClick={openEdit}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("profileEditPublic")}
        </Button>
        {publishedUsername ? (
          <Button variant="outline" className="rounded-xl" onClick={() => navigate(`/@${publishedUsername}`)}>
            <Globe2 className="mr-2 h-4 w-4" />
            {t("profileViewPublic")}
          </Button>
        ) : (
          <Button variant="outline" className="rounded-xl" onClick={() => navigate("/certificate")}>
            <Award className="mr-2 h-4 w-4" />
            {t("certificate")}
          </Button>
        )}
      </motion.div>

      {/* Telegram-style Edit Profile dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="glass-panel max-w-sm border-border/60">
          <DialogHeader className="items-center text-center">
            <DialogTitle className="font-display">{t("profileEdit")}</DialogTitle>
            <DialogDescription>{t("publicProfileEnabledDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            {/* Avatar picker */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="group relative rounded-full"
              aria-label={t("profileChangePhoto")}
            >
              {avatarVideoSrc || profileVideoSrc ? (
                <video src={avatarVideoSrc || profileVideoSrc!} autoPlay loop muted playsInline className="h-20 w-20 rounded-full border-2 border-border object-cover" />
              ) : avatarSrc ? (
                <img src={avatarSrc} alt={displayName} className="h-20 w-20 rounded-full border-2 border-border object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span
                  className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold text-white"
                  style={{ background: `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})` }}
                >
                  {initials}
                </span>
              )}
              <span className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                {avatarBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={canUploadVideo ? "image/*,video/mp4,image/gif" : "image/*"}
              className="hidden"
              onChange={(e) => {
                onAvatarPicked(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <span className="text-xs text-muted-foreground">{t("profileMediaHint")}</span>
            {avatarSrc && (
              <button
                type="button"
                onClick={onAvatarRemove}
                disabled={avatarBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {avatarBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {t("profileRemovePhoto")}
              </button>
            )}

            {/* Name (nick) — Phase 20: the missing basic detail */}
            <div className="w-full space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("profileName")}</p>
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={t("profileNamePlaceholder")}
                className="rounded-xl text-sm"
                maxLength={40}
              />
            </div>

            {/* Bio */}
            <div className="w-full space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("profileBio")}</p>
              <textarea
                value={bioDraft}
                onChange={(e) => setBioDraft(e.target.value)}
                maxLength={1200}
                rows={4}
                placeholder={t("profileBioEmpty")}
                className="w-full resize-none rounded-xl border border-input bg-background/60 px-3 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {/* Username — Telegram style row */}
            <button
              type="button"
              onClick={() => {
                setEditOpen(false);
                setUsernameDialogOpen(true);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-left transition hover:bg-accent/40"
            >
              <span className="text-sm font-medium">{t("setUsername")}</span>
              <span className="truncate text-sm font-medium text-[#3390ec]">
                {username ? `@${username}` : t("profileNoUsername")}
              </span>
            </button>

            {/* Steam-style animated profile background */}
            <button
              type="button"
              onClick={() => {
                setEditOpen(false);
                setBgPickerOpen(true);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-left transition hover:bg-accent/40"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Clapperboard className="h-4 w-4 text-primary" />
                {t("profileBackground")}
              </span>
              <span className="truncate text-sm font-medium text-[#3390ec]">
                {profileBackground ? profileBackground.name : t("profileBackgroundNone")}
              </span>
            </button>

            {/* Social handles — Instagram / Telegram / X */}
            <div className="w-full space-y-2 rounded-xl border border-border/60 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("socialLinks")}</p>
              <div className="flex items-center gap-2">
                <Instagram className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  value={igDraft}
                  onChange={(e) => setIgDraft(e.target.value)}
                  placeholder="instagram"
                  className="h-8 rounded-lg text-sm"
                  maxLength={40}
                />
              </div>
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  value={tgDraft}
                  onChange={(e) => setTgDraft(e.target.value)}
                  placeholder="telegram"
                  className="h-8 rounded-lg text-sm"
                  maxLength={40}
                />
              </div>
              <div className="flex items-center gap-2">
                <Twitter className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  value={xDraft}
                  onChange={(e) => setXDraft(e.target.value)}
                  placeholder="x / twitter"
                  className="h-8 rounded-lg text-sm"
                  maxLength={40}
                />
              </div>
            </div>

            {/* Public profile toggle */}
            <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2.5">
              <span className="text-sm font-medium">{t("publicProfileEnabled")}</span>
              <Switch
                checked={isEnabled}
                onCheckedChange={togglePublic}
                disabled={savePublicProfile.isPending}
                aria-label={t("publicProfileEnabled")}
              />
            </div>

            {isEnabled && publicUrl && (
              <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-[#3390ec]/30 bg-[#3390ec]/5 px-3 py-2">
                <span className="truncate text-xs font-medium text-[#3390ec]">{publicUrl.replace(/^https?:\/\//, "")}</span>
                <Button variant="ghost" size="icon" onClick={copyLink} aria-label={t("publicProfileShare")} className="h-8 w-8 shrink-0 rounded-full text-[#3390ec]">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            )}

            <Button className="w-full rounded-xl" onClick={saveBio} disabled={savePublicProfile.isPending}>
              {savePublicProfile.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Account → Inventory (fragments summary + link to the full page) */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-panel rounded-2xl border-border/50 p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold"><Package className="h-5 w-5 text-primary" />{t("inventory")}</h2>
          <Button variant="outline" size="sm" className="rounded-xl" onClick={() => navigate("/inventory")}>{t("openInventory")}</Button>
        </div>
        {ownedFragments.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {ownedFragments.map(([id, count]) => {
              const frag = ALL_FRAGMENTS.find((f) => f.id === id);
              return (
                <span key={id} className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs">
                  <b>{frag?.name ?? id}</b>
                  <span className="font-number text-muted-foreground">×{count}</span>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("inventoryEmptyHint")}</p>
        )}
      </motion.section>

      {/* Set username dialog (moved here from the Account menu) */}
      <UsernameDialog
        open={usernameDialogOpen}
        currentUsername={username}
        isPremium={profile?.isPremium}
        onClose={() => setUsernameDialogOpen(false)}
      />

      {/* Steam-style animated background picker */}
      {user && (
        <BackgroundPickerDialog
          open={bgPickerOpen}
          onOpenChange={setBgPickerOpen}
          uid={user.uid}
          profile={profile ?? null}
          onSaved={onBackgroundSaved}
          publishPublic={(bg) => publishBackgroundSettings(bg).then(() => undefined)}
        />
      )}
          <MediaLightbox
        src={mediaView?.src ?? null}
        kind={mediaView?.kind}
        caption={displayName}
        onClose={() => setMediaView(null)}
      />
    </div>
  );
}
