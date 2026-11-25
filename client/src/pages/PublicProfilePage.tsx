import { useEffect } from "react";
import { Activity, ArrowLeft, Download, Globe2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ProfilePresentation } from "@/components/public-profile/ProfilePresentation";
import { usePublicProfile } from "@/hooks/use-public-profile";
import { useLanguage } from "@/lib/language-context";
import { applySeo } from "@/lib/seo";

export default function PublicProfilePage({ username, embedded = false }: { username: string; embedded?: boolean }) {
  const { t } = useLanguage();
  const profileQuery = usePublicProfile(username);

  // P69 SEO: public profiles are real documents of their own — unique title
  // and a self-canonical (the static head's canonical "/" would otherwise
  // fold every profile into the homepage).
  const displayName = profileQuery.data?.displayName;
  useEffect(() => {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return;
    const name = displayName || `@${username}`;
    applySeo({
      title: `${name} (@${username}) — InspireTrade`,
      description: `${name} (@${username}) — public trading profile on InspireTrade: trading stats, badges and journey.`,
      path: `/@${username}`,
    });
  }, [username, displayName]);

  const saveAsPdf = () => window.print();
  const validUsername = /^[a-zA-Z0-9_]{3,20}$/.test(username);

  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute -right-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-emerald-500/[0.07] blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-48 -left-40 h-[32rem] w-[32rem] rounded-full bg-cyan-500/[0.05] blur-[100px]" />

      <header className={embedded ? "hidden" : "relative z-10 border-b border-border/50 bg-background/75 backdrop-blur-xl print:hidden"}>
        <div className="container mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild className="rounded-xl" aria-label={t("backToDashboard")}>
              <Link href="/"><ArrowLeft className="h-4 w-4" /></Link>
            </Button>
            <Link href="/" className="flex items-center gap-2.5 text-sm font-semibold">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Globe2 className="h-4 w-4" />
              </span>
              <span>InspireTrade</span>
            </Link>
          </div>
          <Button variant="outline" size="sm" className="gap-2 rounded-xl" onClick={saveAsPdf}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t("publicProfilePrint")}</span>
          </Button>
        </div>
      </header>

      {/* user request: the public profile renders at the SAME compact width
          as the regular profile screen (max-w-md) — not a wide showcase page */}
      <div className="relative z-10 container mx-auto max-w-md px-4 py-6">
        {profileQuery.isLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <Activity className="h-7 w-7 animate-pulse text-primary" />
          </div>
        ) : profileQuery.error ? (
          <div role="alert" className="glass-panel rounded-2xl border border-destructive/30 p-6 text-center">
            <h1 className="text-lg font-semibold">{t("publicProfileLoadError")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {profileQuery.error instanceof Error ? profileQuery.error.message : ""}
            </p>
            <Link href="/" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">
              <ArrowLeft className="h-4 w-4" />
              {t("backToDashboard")}
            </Link>
          </div>
        ) : !validUsername || !profileQuery.data ? (
          <div className="glass-panel mx-auto flex min-h-[42vh] max-w-xl flex-col items-center justify-center rounded-3xl border border-border/60 p-8 text-center">
            <Globe2 className="h-9 w-9 text-muted-foreground" />
            <h1 className="mt-4 text-xl font-semibold">{t("publicProfileNotFound")}</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{t("publicProfileNotFoundDescription")}</p>
            <Link href="/" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">
              <ArrowLeft className="h-4 w-4" />
              {t("backToDashboard")}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {/* P63R user request: the top-right "CEO @handle" badge is gone —
                CEO already shows on the card itself (name badge, title strip,
                frame plate); it had simply become noise here. */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">InspireTrade</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("publicProfileSharedPage")}</p>
            </div>
            <ProfilePresentation profile={profileQuery.data} />
          </div>
        )}
      </div>
    </main>
  );
}
