import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Award, Camera, Copy, Crown, Globe2, Loader2, Pencil, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { saveUserProfile, useUserProfile } from "@/hooks/use-premium";
import { useEconomy } from "@/hooks/use-economy";
import { useTrades } from "@/hooks/use-trades";
import { usePublicProfileSettings, useSavePublicProfile } from "@/hooks/use-public-profile";
import { UsernameDialog } from "@/components/dashboard/UsernameDialog";
import { createDefaultPublicProfileSettings } from "@/lib/public-profile";
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

function StatCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card/60 px-2 py-3 text-center">
      <p className={cn("font-number text-lg font-bold leading-tight", tone)}>{value}</p>
      <p className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground">{label}</p>
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
  const { data: economy } = useEconomy();
  const { data: trades } = useTrades();
  const { data: settings } = usePublicProfileSettings();
  const savePublicProfile = useSavePublicProfile();

  const [editOpen, setEditOpen] = useState(false);
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);
  const [bioDraft, setBioDraft] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayName = user?.displayName || profile?.username || user?.email?.split("@")[0] || "Trader";
  const username = profile?.username || null;
  const gradient = useMemo(() => gradientFor(user?.uid || displayName), [user?.uid, displayName]);
  const initials = useMemo(() => initialsOf(displayName), [displayName]);
  const avatarSrc = profile?.avatar || user?.photoURL || null;

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
    };
  }, [trades]);

  const publishedUsername = settings?.publishedUsername;
  const isEnabled = settings?.enabled === true;
  const publicUrl = publishedUsername && typeof window !== "undefined"
    ? `${window.location.origin}/@${publishedUsername}`
    : "";
  const bio = (settings?.strategy || "").trim();

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
    setEditOpen(true);
  };

  const onAvatarPicked = async (file?: File | null) => {
    if (!file || !user) return;
    if (!file.type.startsWith("image/")) return;
    if (file.size > 3 * 1024 * 1024) {
      toast({ title: t("fileTooLarge"), description: t("max3mbAllowed"), variant: "destructive" });
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      await saveUserProfile(user.uid, { avatar: dataUrl });
      queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
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
      await saveUserProfile(user.uid, { avatar: null });
      queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
      toast({ title: t("profileSaved") });
    } catch {
      toast({ title: t("error"), variant: "destructive" });
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveBio = async () => {
    if (!user) return;
    if (!username) {
      setEditOpen(false);
      setUsernameDialogOpen(true);
      toast({ title: t("publicProfileUsernameRequired") });
      return;
    }
    try {
      await savePublicProfile.mutateAsync({
        username,
        displayName: user.displayName || username,
        trades: trades ?? [],
        settings: { ...(settings ?? createDefaultPublicProfileSettings()), strategy: bioDraft.trim() },
      });
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

  const pnlTone = stats.netPnl > 0 ? "text-emerald-500" : stats.netPnl < 0 ? "text-red-500" : undefined;
  const pnlText = stats.total
    ? `${stats.netPnl >= 0 ? "+" : "-"}$${Math.abs(stats.netPnl).toFixed(2)}`
    : "—";

  return (
    <div className="container mx-auto max-w-md space-y-4 px-4 py-6">
      {/* Telegram-style banner */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="relative overflow-hidden rounded-3xl border border-border/50 pb-6 pt-10 text-center"
      >
        <div
          className="absolute inset-0 opacity-20"
          style={{ background: `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})` }}
        />
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
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt={displayName}
              className="mx-auto h-24 w-24 rounded-full border-4 border-background object-cover shadow-lg"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              className="mx-auto flex h-24 w-24 items-center justify-center rounded-full text-3xl font-bold text-white shadow-lg"
              style={{ background: `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})` }}
            >
              {initials}
            </div>
          )}
          <h1 className="mt-4 text-xl font-bold tracking-tight">{displayName}</h1>
          <p className="mt-0.5 text-[15px] font-medium text-[#3390ec]">
            {username ? `@${username}` : t("profileNoUsername")}
          </p>
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
        <StatCell label={t("totalTrades")} value={String(stats.total)} />
        <StatCell label={t("winRate")} value={stats.winRate} />
        <StatCell label={t("netPnl")} value={pnlText} tone={pnlTone} />
        <StatCell label={t("profileMemberSince")} value={memberSince} />
      </motion.div>

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
        <InfoRow
          label={t("inspireBalance")}
          value={`${economy?.coins ?? 0} INSP`}
          valueClass="text-amber-400"
        />
        <InfoRow
          label={t("casesTitle")}
          value={String(economy?.cases ?? 0)}
          valueClass="text-primary"
        />
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
              {avatarSrc ? (
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
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                onAvatarPicked(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <span className="text-xs text-muted-foreground">{t("profileChangePhoto")}</span>
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

      {/* Set username dialog (moved here from the Account menu) */}
      <UsernameDialog
        open={usernameDialogOpen}
        currentUsername={username}
        isPremium={profile?.isPremium}
        onClose={() => setUsernameDialogOpen(false)}
      />
    </div>
  );
}
