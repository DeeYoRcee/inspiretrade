import { Instagram, Send, Twitter, Crown, Activity, Target, TrendingUp, TrendingDown, CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language-context";
import { formatPublicMoney, type PublicProfileSnapshot } from "@/lib/public-profile";
import { getProfileBackground, BackgroundVideo } from "@/lib/profile-backgrounds";

/**
 * PHASE 62 (user request): the PUBLIC profile must mirror the REAL profile
 * screen — same Telegram-style hero, the same 4-cell stat grid (trades, win
 * rate, net P/L, member since) and the same BIO info card. The old profit
 * factor / drawdown / win-rate cards and the trade history list are gone.
 */
/** Mirrors the own-profile StatCell (ProfilePage) — same classes, same ring. */
function StatCell({ label, value, tone, icon: Icon, iconTone, ring, ringTone }: {
  label: string;
  value: string;
  tone?: string;
  icon?: typeof Crown;
  iconTone?: string;
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

export function ProfilePresentation({ profile }: { profile: PublicProfileSnapshot }) {
  const { t } = useLanguage();
  const initials =
    profile.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "IT";

  const stats = profile.statistics;
  const recent = [...(profile.history || [])].slice(0, 5);
  const background = getProfileBackground(profile.background);
  // looping avatar video: the uploaded one wins, legacy CEO catalog video as fallback
  const videoSrc = profile.avatarVideo || (() => {
    const v = profile.profileVideo;
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    return getProfileBackground(v)?.src || null;
  })();

  return (
    <article
      className={cn(
        "overflow-hidden rounded-3xl border bg-card shadow-[0_24px_90px_rgba(0,0,0,.28)]",
        // Phase 30: CEO = red stroke, VIP (premium) = gold stroke on the public page
        profile.ceo
          ? "border-red-500/70 shadow-[0_0_36px_rgba(239,68,68,0.16)]"
          : profile.vip
            ? "border-amber-400/80 shadow-[0_0_36px_rgba(251,191,36,0.15)]"
            : "border-border/60",
      )}
    >
      {/* Telegram-like mini profile card — Steam-style animated background */}
      <header
        className="relative isolate overflow-hidden bg-gradient-to-b from-emerald-950 via-[#071712] to-slate-950 px-5 pb-7 pt-9 text-center text-white sm:px-8"
        style={background ? { background: background.tint } : undefined}
      >
        {background && (
          <>
            {/* P66 — shared renderer: handles video AND image picks (+ the
                animated fx overlay that comes with image picks) */}
            <BackgroundVideo background={background} opacity={0.55} className="absolute inset-0 -z-10 h-full w-full object-cover" />
            <div className="absolute inset-0 -z-10 bg-gradient-to-t from-slate-950/85 via-slate-950/35 to-slate-950/45" />
          </>
        )}
        <div className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 left-[20%] h-72 w-96 rounded-full bg-cyan-300/[0.06] blur-3xl" />

        <div
          className={cn(
            "relative mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 bg-emerald-100/10 text-2xl font-black text-emerald-50 shadow-[0_8px_40px_-8px_rgba(16,185,129,0.5)]",
            profile.ceo ? "border-red-500" : profile.vip ? "border-amber-400" : "border-emerald-200/30",
          )}
        >
          {videoSrc ? (
            <video
              src={videoSrc}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              className="h-full w-full object-cover"
            />
          ) : profile.avatar ? (
            <img src={profile.avatar} alt={profile.displayName} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            initials
          )}
        </div>

        {/* Phase 32b: Telegram-style badge inline to the right of the name */}
        <div className="relative mt-3 flex items-center justify-center gap-1.5">
          <h2 className="text-2xl font-bold tracking-tight">{profile.displayName}</h2>
          {profile.ceo && (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-red-400/60 bg-red-500/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-red-300" title="CEO">
              <Crown className="h-2.5 w-2.5" />CEO
            </span>
          )}
          {!profile.ceo && profile.vip && (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-400/60 bg-amber-400/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-amber-300" title="VIP">
              <Crown className="h-2.5 w-2.5" />VIP
            </span>
          )}
        </div>
        <p className="relative text-sm text-emerald-50/60">@{profile.username}</p>

        {/* Telegram-collectible style — every handle this profile holds */}
        {(profile.usernames?.length ?? 0) > 1 && (
          <div className="relative mt-2 flex flex-wrap items-center justify-center gap-1.5 px-4">
            {profile.usernames!.slice(0, 10).map((u) => (
              <span
                key={u.key}
                className={
                  u.key === profile.usernameKey
                    ? "inline-flex max-w-[130px] items-center truncate rounded-full border border-white/30 bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold text-white"
                    : "inline-flex max-w-[130px] items-center truncate rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold text-white/60"
                }
              >
                @{u.username}
              </span>
            ))}
          </div>
        )}

        {/* social handles — Instagram / Telegram / X */}
        {(profile.social?.instagram || profile.social?.telegram || profile.social?.x) && (
          <div className="relative mt-2.5 flex items-center justify-center gap-2">
            {profile.social?.instagram && (
              <a
                href={`https://instagram.com/${profile.social.instagram}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Instagram"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <Instagram className="h-4 w-4" />
              </a>
            )}
            {profile.social?.telegram && (
              <a
                href={`https://t.me/${profile.social.telegram}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Telegram"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <Send className="h-4 w-4" />
              </a>
            )}
            {profile.social?.x && (
              <a
                href={`https://x.com/${profile.social.x}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="X"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <Twitter className="h-4 w-4" />
              </a>
            )}
          </div>
        )}

        {/* single-line stats chips — like "12 posts · 4.5K subscribers" */}
        {stats && (
          <div className="relative mt-4 flex flex-wrap items-center justify-center gap-2 text-sm font-semibold">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
              <Activity className="h-3.5 w-3.5 text-sky-300/80" />
              <span className="font-number">{stats.totalTrades}</span>
              <span className="text-[11px] font-normal text-white/55">{t("publicProfileTotalTrades")}</span>
            </span>
            {profile.winRate && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-emerald-300">
                <span className="font-number">{profile.winRate && profile.winRate.total > 0 && Number.isFinite(profile.winRate.rate) ? `${profile.winRate.rate.toFixed(0)}%` : "—"}</span>
                <span className="text-[11px] font-normal text-white/55">{t("winRate")}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
              {stats.netPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5 text-emerald-300/80" /> : <TrendingDown className="h-3.5 w-3.5 text-rose-300/80" />}
              <span className={`font-number ${stats.netPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {formatPublicMoney(stats.netPnl)}
              </span>
              <span className="text-[11px] font-normal text-white/55">{t("publicProfilePnl")}</span>
            </span>
          </div>
        )}

        {/* bio = strategy, one short block */}
        {profile.strategy && (
          <p className="relative mx-auto mt-4 max-w-xl whitespace-pre-wrap text-[13px] leading-5 text-white/70">
            {profile.strategy}
          </p>
        )}
      </header>

      {/* the SAME layout as the own-profile screen: 4 stat cells + BIO card */}
      <div className="space-y-4 p-4 sm:p-6">
        {stats && (
          <section className="grid grid-cols-4 gap-2">
            <StatCell label={t("totalTrades")} value={String(stats.totalTrades)} icon={Activity} iconTone="text-sky-400" />
            <StatCell
              label={t("winRate")}
              value={profile.winRate && profile.winRate.total > 0 && Number.isFinite(profile.winRate.rate) ? `${profile.winRate.rate.toFixed(0)}%` : "—"}
              icon={Target}
              iconTone="text-emerald-400"
              ring={profile.winRate && profile.winRate.total > 0 ? profile.winRate.wins / profile.winRate.total : 0}
              ringTone="hsl(var(--success))"
            />
            <StatCell
              label={t("netPnl")}
              value={formatPublicMoney(stats.netPnl)}
              tone={stats.netPnl >= 0 ? "text-emerald-400" : "text-red-400"}
              icon={stats.netPnl >= 0 ? TrendingUp : TrendingDown}
              iconTone={stats.netPnl >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <StatCell
              label={t("profileMemberSince")}
              value={profile.createdAt ? new Date(profile.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"}
              icon={CalendarDays}
              iconTone="text-violet-400"
            />
          </section>
        )}

        {/* Telegram-style BIO card — identical to the own-profile info card */}
        <section className="divide-y divide-border/50 rounded-3xl border border-border/50 bg-card/60">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("profileBio")}</span>
          </div>
          <div className="px-4 py-3">
            <p className={profile.strategy ? "whitespace-pre-wrap text-[13px] leading-6" : "text-[13px] text-muted-foreground"}>
              {profile.strategy || t("profileBioEmpty")}
            </p>
          </div>
        </section>
      </div>
    </article>
  );
}
