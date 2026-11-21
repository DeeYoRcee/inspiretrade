import { ArrowDownRight, ArrowUpRight, Instagram, Send, Twitter } from "lucide-react";
import { cn } from "@/lib/utils";
import { TitleStrip, titlesForProfile } from "@/pages/TitlesPage";
import { useLanguage } from "@/lib/language-context";
import { formatPublicMoney, type PublicProfileSnapshot } from "@/lib/public-profile";
import { getProfileBackground } from "@/lib/profile-backgrounds";

/**
 * Telegram-style compact profile: centered avatar card, a single stats line,
 * short bio, recent activity. Long disclaimers and verbose sections removed.
 */
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
            <video
              src={background.src}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              aria-hidden
              className="absolute inset-0 -z-10 h-full w-full object-cover opacity-55"
            />
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

        <h2 className="relative mt-3 text-2xl font-bold tracking-tight">{profile.displayName}</h2>
        {/* Phase 30: CEO (red) / VIP (gold) badges — mirror the profile stroke */}
        {(profile.ceo || profile.vip) && (
          <div className="relative mt-1.5 flex items-center justify-center gap-1.5">
            {profile.ceo && (
              <span className="inline-flex items-center rounded-full border border-red-400/60 bg-red-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300">
                CEO
              </span>
            )}
            {profile.vip && (
              <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-400/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                VIP
              </span>
            )}
        <TitleStrip titles={titlesForProfile(profile)} size="sm" />
          </div>
        )}
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
              <span className="font-number">{stats.totalTrades}</span>
              <span className="text-[11px] font-normal text-white/55">{t("publicProfileTotalTrades")}</span>
            </span>
            {profile.winRate && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-emerald-300">
                <span className="font-number">{profile.winRate.total > 0 ? `${profile.winRate.rate.toFixed(0)}%` : "—"}</span>
                <span className="text-[11px] font-normal text-white/55">{t("winRate")}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
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

      <div className="space-y-5 p-4 sm:p-6">
        {/* detailed stats — compact grid */}
        {stats && (
          <section className="grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-border/60 bg-background/45 p-3.5 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("publicProfileProfitFactor")}</p>
              <p className="mt-1 text-lg font-bold">{stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)}</p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/45 p-3.5 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("publicProfileDrawdown")}</p>
              <p className="mt-1 text-lg font-bold text-rose-300">
                {stats.maxDrawdown > 0 ? formatPublicMoney(-stats.maxDrawdown) : "$0"}
              </p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/45 p-3.5 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("publicProfileWinRate")}</p>
              <p className="mt-1 text-lg font-bold text-emerald-300">
                {profile.winRate && profile.winRate.total > 0 ? `${profile.winRate.rate.toFixed(1)}%` : "—"}
              </p>
            </div>
          </section>
        )}

        {/* recent activity */}
        {profile.history && (
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              {t("tradeHistory")}
            </h3>
            {recent.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border/70 bg-background/40 px-4 py-8 text-center text-sm text-muted-foreground">
                {t("publicProfileNoTrades")}
              </p>
            ) : (
              <div className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-background/35">
                {recent.map((trade) => (
                  <div key={trade.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{trade.assetName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {trade.type} · {new Date(trade.timestamp).toLocaleDateString()}
                      </p>
                    </div>
                    <span className={`flex shrink-0 items-center gap-1 text-sm font-bold ${trade.profit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {trade.profit >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                      {formatPublicMoney(trade.profit)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* notes as a short quote */}
        {profile.notes && (
          <section className="rounded-2xl border-l-2 border-emerald-400/60 bg-emerald-400/[0.06] px-4 py-3">
            <p className="whitespace-pre-wrap text-[13px] leading-6 text-foreground/80">{profile.notes}</p>
          </section>
        )}
      </div>
    </article>
  );
}
