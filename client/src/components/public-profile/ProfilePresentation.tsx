import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  LineChart,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useLanguage } from "@/lib/language-context";
import { formatPublicMoney, type PublicProfileSnapshot } from "@/lib/public-profile";

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/55">{label}</p>
      <p className={`mt-2 text-xl font-semibold tracking-tight ${accent ? "text-emerald-300" : "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

export function ProfilePresentation({ profile }: { profile: PublicProfileSnapshot }) {
  const { t } = useLanguage();
  const hasSharedSections = Boolean(
    profile.statistics || profile.winRate || profile.strategy || profile.history || profile.notes,
  );
  const initials = profile.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "TJ";

  return (
    <article className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-[0_24px_90px_rgba(0,0,0,.28)]">
      <header className="relative isolate overflow-hidden bg-gradient-to-br from-emerald-950 via-[#071712] to-slate-950 p-5 text-white sm:p-8">
        <div className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 left-[20%] h-72 w-96 rounded-full bg-cyan-300/[0.06] blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-emerald-100/20 bg-emerald-100/10 text-lg font-bold text-emerald-100">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{profile.displayName}</h2>
              <span className="rounded-full border border-emerald-200/20 bg-emerald-200/10 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-emerald-100">
                {t("publicProfile")}
              </span>
            </div>
            <p className="mt-1 text-sm text-emerald-50/65">@{profile.username}</p>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-medium text-emerald-50/70 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
            {t("publicProfileSnapshot")}
          </div>
        </div>

        {profile.statistics && (
          <section className="relative mt-7 rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-50/65">
              <BarChart3 className="h-4 w-4" />
              {t("publicProfileStatistics")}
            </div>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat label={t("publicProfilePnl")} value={formatPublicMoney(profile.statistics.netPnl)} accent />
              <Stat label={t("publicProfileProfitFactor")} value={profile.statistics.profitFactor === null ? "—" : profile.statistics.profitFactor.toFixed(2)} />
              <Stat
                label={t("publicProfileDrawdown")}
                value={profile.statistics.maxDrawdown > 0 ? formatPublicMoney(-profile.statistics.maxDrawdown) : "$0.00"}
              />
              <Stat label={t("publicProfileTotalTrades")} value={String(profile.statistics.totalTrades)} />
            </div>
          </section>
        )}

        <div className="relative mt-5 flex items-start gap-2 border-t border-white/10 pt-4 text-[11px] leading-5 text-white/55">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-200/70" />
          <p>{t("publicProfileDisclaimer")}</p>
        </div>
      </header>

      <div className="grid gap-5 p-4 sm:p-7">
        {!hasSharedSections && (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 px-5 py-10 text-center">
            <WalletCards className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-foreground">{t("publicProfileNoSections")}</p>
          </div>
        )}

        {profile.winRate && (
          <section className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/45 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300">
                <LineChart className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">{t("publicProfileWinRate")}</h3>
                <p className="text-xs text-muted-foreground">
                  {profile.winRate.wins} / {profile.winRate.total} {t("tradeHistory").toLowerCase()}
                </p>
              </div>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-emerald-300">
              {profile.winRate.total > 0 ? `${profile.winRate.rate.toFixed(1)}%` : "—"}
            </p>
          </section>
        )}

        {profile.strategy && (
          <section className="rounded-2xl border border-border/60 bg-background/35 p-4 sm:p-5">
            <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
              <LineChart className="h-4 w-4 text-emerald-300" />
              {t("publicProfileStrategy")}
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/85">{profile.strategy}</p>
          </section>
        )}

        {profile.history && (
          <section className="rounded-2xl border border-border/60 bg-background/35 p-4 sm:p-5">
            <div className="mb-3 flex items-center gap-2">
              <WalletCards className="h-4 w-4 text-emerald-300" />
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {t("publicProfileHistory")}
              </h3>
            </div>
            {profile.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("publicProfileNoTrades")}</p>
            ) : (
              <div className="divide-y divide-border/50">
                {profile.history.map((trade) => (
                  <div key={trade.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[minmax(0,1.2fr)_0.6fr_1fr_auto]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{trade.assetName}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground sm:hidden">
                        {trade.type} · {new Date(trade.timestamp).toLocaleDateString()}
                      </p>
                    </div>
                    <span className="hidden text-xs text-muted-foreground sm:block">{trade.type}</span>
                    <span className="hidden text-xs text-muted-foreground sm:block">
                      {new Date(trade.timestamp).toLocaleDateString()}
                    </span>
                    <span className={`flex items-center justify-end gap-1 text-sm font-semibold ${trade.profit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {trade.profit >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                      {formatPublicMoney(trade.profit)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">{t("publicProfileHistoryLimit")}</p>
          </section>
        )}

        {profile.notes && (
          <section className="rounded-2xl border-l-2 border-emerald-400/60 bg-emerald-400/[0.06] p-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-200/75">
              {t("publicProfileNotes")}
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/80">{profile.notes}</p>
          </section>
        )}

        <p className="border-t border-border/50 pt-4 text-[11px] leading-5 text-muted-foreground">
          {t("publicProfileFooterDisclaimer")}
        </p>
      </div>
    </article>
  );
}
