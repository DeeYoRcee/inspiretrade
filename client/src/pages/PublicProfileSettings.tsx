import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Globe2, LockKeyhole, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { UsernameDialog } from "@/components/dashboard/UsernameDialog";
import { ProfilePresentation } from "@/components/public-profile/ProfilePresentation";
import { useAuth } from "@/hooks/use-auth";
import { usePublicProfileSettings, useSavePublicProfile } from "@/hooks/use-public-profile";
import { useTrades } from "@/hooks/use-trades";
import { useUserProfile } from "@/hooks/use-premium";
import {
  createDefaultPublicProfileSettings,
  createPublicProfileSnapshot,
  type PublicProfileSection,
} from "@/lib/public-profile";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";

export default function PublicProfileSettingsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  const profileQuery = useUserProfile();
  const settingsQuery = usePublicProfileSettings();
  const tradesQuery = useTrades();
  const saveProfile = useSavePublicProfile();
  const [draft, setDraft] = useState(createDefaultPublicProfileSettings);
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);

  useEffect(() => {
    if (settingsQuery.data) setDraft(settingsQuery.data);
  }, [settingsQuery.data]);

  const profile = profileQuery.data;
  const trades = tradesQuery.data ?? [];
  const preview = useMemo(() => {
    if (!user || !profile?.username) return null;
    return createPublicProfileSnapshot({
      uid: user.uid,
      username: profile.username,
      displayName: user.displayName || profile.username,
      trades,
      settings: draft,
    });
  }, [user, profile?.username, trades, draft]);

  const publishedUsername = settingsQuery.data?.publishedUsername;
  const publishedUrl = publishedUsername && typeof window !== "undefined"
    ? `${window.location.origin}/@${publishedUsername}`
    : "";
  const loading = profileQuery.isLoading || settingsQuery.isLoading || tradesQuery.isLoading;
  const loadError = profileQuery.error || settingsQuery.error || tradesQuery.error;

  const sectionOptions: {
    key: PublicProfileSection;
    title: string;
    description: string;
  }[] = [
    { key: "statistics", title: t("publicProfileStatistics"), description: t("publicProfileStatisticsDescription") },
    { key: "strategy", title: t("publicProfileStrategy"), description: t("publicProfileStrategyDescription") },
    { key: "winRate", title: t("publicProfileWinRate"), description: t("publicProfileWinRateDescription") },
    { key: "history", title: t("publicProfileHistory"), description: t("publicProfileHistoryDescription") },
    { key: "notes", title: t("publicProfileNotes"), description: t("publicProfileNotesDescription") },
  ];

  const handleSave = async () => {
    if (!profile?.username || !user) {
      setUsernameDialogOpen(true);
      return;
    }

    try {
      await saveProfile.mutateAsync({
        username: profile.username,
        displayName: user.displayName || profile.username,
        trades,
        settings: draft,
      });
      toast({ title: t("publicProfileUpdated") });
    } catch (error) {
      toast({
        title: t("error"),
        description: error instanceof Error ? error.message : t("publicProfileSaveFailed"),
        variant: "destructive",
      });
    }
  };

  const copyPublishedLink = async () => {
    if (!publishedUrl) return;
    try {
      await navigator.clipboard.writeText(publishedUrl);
      toast({ title: t("publicProfileLinkCopied") });
    } catch {
      toast({
        title: t("error"),
        description: publishedUrl,
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="container flex min-h-[55vh] items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="container max-w-3xl py-12">
        <div role="alert" className="glass-panel rounded-2xl border border-destructive/30 p-5 text-sm text-destructive">
          {loadError instanceof Error ? loadError.message : t("publicProfileLoadError")}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-[1440px] space-y-6 px-4 py-7 sm:px-6 sm:py-9">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <span>Trade Journal</span>
            <span className="text-border">/</span>
            <span className="text-primary">{t("publicProfile")}</span>
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {t("publicProfileTitle")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t("publicProfileDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {publishedUrl && (
            <Button variant="outline" className="gap-2 rounded-xl" onClick={copyPublishedLink}>
              <Copy className="h-4 w-4" />
              {t("publicProfileShare")}
            </Button>
          )}
          <Button className="gap-2 rounded-xl" onClick={handleSave} disabled={saveProfile.isPending}>
            {saveProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {draft.enabled ? t("publicProfilePublish") : t("publicProfileSave")}
          </Button>
        </div>
      </div>

      {!profile?.username && (
        <div className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/20 p-4">
          <div className="flex items-start gap-3">
            <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-semibold">{t("publicProfileUsernameRequired")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("publicProfileUsernameHint")}</p>
            </div>
          </div>
          <Button variant="outline" className="rounded-xl" onClick={() => setUsernameDialogOpen(true)}>
            {t("publicProfileSetUsername")}
          </Button>
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[370px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <section className="glass-panel rounded-3xl border border-border/60 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{t("publicProfileVisibility")}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t("publicProfilePreviewHint")}</p>
              </div>
              <div className={`rounded-full px-3 py-1 text-[10px] font-semibold ${draft.enabled ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                {draft.enabled ? t("publicProfileLive") : t("publicProfilePrivate")}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/40 p-4">
              <div className="flex items-start gap-3">
                <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-semibold">{t("publicProfileEnabled")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("publicProfileEnabledDescription")}</p>
                </div>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => {
                  if (enabled && !profile?.username) {
                    setUsernameDialogOpen(true);
                    return;
                  }
                  setDraft((current) => ({ ...current, enabled }));
                }}
                aria-label={t("publicProfileEnabled")}
              />
            </div>

            <div className="mt-4 divide-y divide-border/50">
              {sectionOptions.map((option) => (
                <div key={option.key} className="flex items-center justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{option.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</p>
                  </div>
                  <Switch
                    checked={draft.visibility[option.key]}
                    onCheckedChange={(visible) =>
                      setDraft((current) => ({
                        ...current,
                        visibility: { ...current.visibility, [option.key]: visible },
                      }))
                    }
                    aria-label={`${option.title}: ${draft.visibility[option.key] ? t("publicProfileVisible") : t("publicProfileHidden")}`}
                  />
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-xl bg-primary/[0.07] p-3 text-xs leading-5 text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p>{t("publicProfilePrivacyNote")}</p>
            </div>
          </section>

          <section className="glass-panel space-y-4 rounded-3xl border border-border/60 p-5 sm:p-6">
            <div>
              <h2 className="text-sm font-semibold">{t("publicProfileStrategy")}</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("publicProfileStrategyDescription")}</p>
            </div>
            <textarea
              value={draft.strategy}
              onChange={(event) => setDraft((current) => ({ ...current, strategy: event.target.value }))}
              maxLength={1200}
              rows={4}
              placeholder={t("publicProfileStrategyPlaceholder")}
              className="w-full resize-y rounded-xl border border-input bg-background/60 px-3 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div>
              <h2 className="text-sm font-semibold">{t("publicProfileNotes")}</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("publicProfileNotesDescription")}</p>
            </div>
            <textarea
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              maxLength={2000}
              rows={4}
              placeholder={t("publicProfileNotesPlaceholder")}
              className="w-full resize-y rounded-xl border border-input bg-background/60 px-3 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <p>{t("publicProfilePrivateNotesNotice")}</p>
            </div>
          </section>

          {publishedUrl && (
            <section className="glass-panel rounded-2xl border border-border/60 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t("publicProfileLink")}
              </p>
              <p className="mt-2 break-all text-sm font-medium">{publishedUrl}</p>
              <a
                href={publishedUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
              >
                {t("publicProfileOpen")}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </section>
          )}
        </aside>

        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-[0.15em] text-muted-foreground">
                {t("publicProfilePreview")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{t("publicProfilePreviewHint")}</p>
            </div>
            <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t("publicProfileLocalPreview")}
            </span>
          </div>
          {preview ? (
            <ProfilePresentation profile={preview} />
          ) : (
            <div className="glass-panel flex min-h-72 flex-col items-center justify-center rounded-3xl border border-dashed border-border/70 p-6 text-center">
              <Globe2 className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">{t("publicProfileUsernameRequired")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("publicProfileUsernameHint")}</p>
            </div>
          )}
        </section>
      </div>

      {user && (
        <UsernameDialog
          open={usernameDialogOpen}
          currentUsername={profile?.username}
          isPremium={profile?.isPremium}
          onClose={() => setUsernameDialogOpen(false)}
        />
      )}
    </div>
  );
}
