import { useMemo } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Award, Copy, Crown, Globe2, Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useUserProfile } from "@/hooks/use-premium";
import { useEconomy } from "@/hooks/use-economy";
import { useTrades } from "@/hooks/use-trades";
import { usePublicProfileSettings } from "@/hooks/use-public-profile";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * Telegram-style profile screen: gradient banner, big centered avatar with
 * initials (or photo), name + blue @username, stat chips and iOS-like info
 * rows (small gray label above the value). The heavy public-profile settings
 * stay on their own page, linked from here.
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
  const [, navigate] = useLocation();
  const { data: profile } = useUserProfile();
  const { data: economy } = useEconomy();
  const { data: trades } = useTrades();
  const { data: settings } = usePublicProfileSettings();

  const displayName = user?.displayName || profile?.username || user?.email?.split("@")[0] || "Trader";
  const username = profile?.username;
  const gradient = useMemo(() => gradientFor(user?.uid || displayName), [user?.uid, displayName]);
  const initials = useMemo(() => initialsOf(displayName), [displayName]);

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
        <div className="relative">
          {user?.photoURL ? (
            <img
              src={user.photoURL}
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

      {/* Stat chips */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="grid grid-cols-4 gap-2"
      >
        <StatCell label={t("totalTrades")} value={String(stats.total)} />
        <StatCell label={t("winRate")} value={stats.winRate} />
        <StatCell label={t("netPnl")} value={pnlText} tone={pnlTone} />
        <StatCell label={t("streakLabel")} value={String(economy?.streak ?? 0)} />
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
        <Button className="rounded-xl" onClick={() => navigate("/public-profile")}>
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
    </div>
  );
}
