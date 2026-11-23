import React from "react";
import { Switch, Route, useLocation, useRoute } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { ThemeProvider } from "@/lib/theme-context";
import { LanguageProvider, useLanguage } from "@/lib/language-context";
import { clearWhopPending } from "@/lib/whop";
import { Navbar } from "@/components/layout/Navbar";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { ThemeBackdrop } from "@/components/layout/ThemeBackdrop";
import NotFound from "@/pages/not-found";
import VerifyEmailScreen from "@/pages/VerifyEmailPage";
import TitlesPage from "@/pages/TitlesPage";
import Dashboard from "@/pages/Dashboard";
import AuthPage from "@/pages/AuthPage";
import PremiumPage from "@/pages/PremiumPage";
import NewsPage from "@/pages/NewsPage";
import PublicProfilePage from "@/pages/PublicProfilePage";
import PropFirmPage from "@/pages/PropFirmPage";
import LeaderboardPage from "@/pages/LeaderboardPage";
import RewardsPage from "@/pages/RewardsPage";
import ProfilePage from "@/pages/ProfilePage";
import MarketPage from "@/pages/MarketPage";
import InventoryPage from "@/pages/InventoryPage";
// Phase 23 BUG-2: lazy route — the terminal is the heaviest page (chart
// engine + indicator suite); code-splitting it keeps every OTHER page's first
// paint free of that download
const TerminalPage = React.lazy(() => import("@/pages/TerminalPage"));
import WalletPage from "@/pages/WalletPage";
import AdminPage from "@/pages/AdminPage";
import CertificatePage from "@/pages/CertificatePage";
import { InstallPrompt } from "@/components/InstallPrompt";
import { UsernamePrompt } from "@/components/UsernamePrompt";
import { GlobalChat } from "@/components/chat/GlobalChat";
import { AlertsEngine } from "@/components/news/AlertsEngine";
import { TradingAlertsEngine } from "@/components/terminal/TradingAlertsEngine";
import { DailyRewardDialog } from "@/components/rewards/DailyRewardDialog";
import { PremiumNudge } from "@/components/premium/PremiumNudge";
import { MusicPlayer } from "@/components/music/MusicPlayer";
import { useIsAdmin } from "@/hooks/use-admin";
import { useEconomyInvalidator } from "@/hooks/use-economy";
import { authedFetch } from "@/lib/api";
import { captureRefFromUrl, popStoredRef, clearStoredRef } from "@/lib/referral";
import { useTerminalSettings, setTerminalSettingsUser } from "@/lib/terminal-settings";
import { setInstrumentSettingsUser } from "@/lib/instrument-settings";
import { setWatchlistsUser } from "@/lib/watchlists";
import { loadChartSettingsCloud } from "@/lib/chart-persistence";
import { Activity, Send } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Phase 21 — wires the unified settings/watchlist stores to the signed-in
 * user (LS mirror instant + RTDB sync) and applies the global appearance
 * settings (base font size + density class) to the document root.
 */
function SettingsSync() {
  const { user } = useAuth();
  const ts = useTerminalSettings();
  useEffect(() => {
    const uid = user?.uid || null;
    void setTerminalSettingsUser(uid);
    void setInstrumentSettingsUser(uid);
    void setWatchlistsUser(uid);
    // P41 — restore the user's chart look (candle colors, chart type) from
    // RTDB; the LS mirror is the offline cache, the cloud copy is canonical
    if (uid) {
      void loadChartSettingsCloud(uid).then((cloud) => {
        if (!cloud || typeof cloud !== "object") return;
        const cfg: Record<string, unknown> = { ...cloud };
        delete cfg.savedAt;
        if (!Object.keys(cfg).length) return;
        try {
          const localRaw = localStorage.getItem("it_chart_settings");
          const merged = { ...(localRaw ? JSON.parse(localRaw) as Record<string, unknown> : {}), ...cfg };
          localStorage.setItem("it_chart_settings", JSON.stringify(merged));
          window.dispatchEvent(new CustomEvent("it_chart_settings_changed", { detail: merged }));
        } catch { /* private mode */ }
      });
    }
  }, [user?.uid]);
  useEffect(() => {
    document.documentElement.style.fontSize = `${ts.appearance.fontSize}px`;
    document.documentElement.classList.toggle("density-cozy", ts.appearance.density === "cozy");
  }, [ts.appearance.fontSize, ts.appearance.density]);
  return null;
}

function PremiumSuccessHandler() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user || !window.location.search.includes("premium=success")) return;
    window.history.replaceState(null, "", "/");
    // P45 §6 — the payment completed on Whop; clear the pending flag and
    // re-verify (the server verify self-heals the entitlement when the
    // webhook has not landed yet)
    clearWhopPending(user.uid);
    queryClient.invalidateQueries({ queryKey: ["premiumStatus", user.uid] });
    toast({ title: t("premiumThanks") });
  }, [user]);

  return null;
}

/**
 * Referral pipeline:
 * 1. On mount, capture `?ref=CODE` from the URL into localStorage.
 * 2. When a (fresh) account signs in, POST the code to /api/referral?action=apply.
 *    The server credits +100 INSP to the new user and +250 INSP to the referrer.
 */
function ReferralApplier() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useLanguage();
  const invalidate = useEconomyInvalidator();

  useEffect(() => {
    captureRefFromUrl();
  }, []);

  useEffect(() => {
    if (!user) return;
    const code = popStoredRef();
    if (!code) return;
    (async () => {
      try {
        // Only fresh accounts can claim the referral bonus (24-hour window —
        // the server is the final authority; this just avoids doomed calls).
        const created = new Date(user.metadata.creationTime || Date.now()).getTime();
        if (Date.now() - created > 24 * 60 * 60 * 1000) {
          clearStoredRef();
          return;
        }
        await authedFetch("/api/referral?action=apply", { code });
        clearStoredRef();
        invalidate();
        toast({ title: t("referralAppliedTitle"), description: t("referralAppliedBody") });
      } catch (error: any) {
        const msg = String(error?.message || "");
        // Permanent rejections — give up and surface WHY (was silent before).
        if (/ALREADY_REFERRED|BAD_CODE|CODE_NOT_FOUND|SELF_REFERRAL|409|400|404/.test(msg)) {
          clearStoredRef();
          toast({ title: t("referralFailedTitle"), description: msg.slice(0, 140), variant: "destructive" });
        }
        // Transient failures (network/500): KEEP the code — retried on next login.
      }
    })();
  }, [user]);

  return null;
}

function AppFooter() {
  const { t } = useLanguage();
  const [location] = useLocation();
  // the terminal is a focused workspace — keep the contact/ad footer out of it
  if (location.startsWith("/terminal")) return null;
  return (
    <footer className="py-8 border-t border-border/50 bg-card/30 backdrop-blur-sm">
      <div className="container mx-auto px-4 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground uppercase tracking-widest font-medium">{t("footerInquiries")}</p>
          <a href="https://t.me/fyck7" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-6 py-2 rounded-full bg-[#0088cc]/10 text-[#0088cc] border border-[#0088cc]/20 hover:bg-[#0088cc]/20 transition-all font-semibold">
            <Send className="w-4 h-4" />
            Telegram
          </a>
        </div>
      </div>
    </footer>
  );
}

function AppLayout({ children }: { children: ReactNode }) {
  // Phase 32: mandatory email verification — unverified accounts see the
  // verification screen instead of the app (Google accounts are verified).
  const { user } = useAuth();
  if (user && user.emailVerified === false) return <VerifyEmailScreen />;
  return (
    <div className="min-h-screen flex flex-col">
      <ThemeBackdrop />
      <Navbar />
      <main className="flex-1 pb-[calc(3.75rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
      <AppFooter />
      <MobileTabBar />
      <UsernamePrompt />
      <PremiumSuccessHandler />
      <GlobalChat />
    </div>
  );
}

function LoadingScreen() {
  // Phase 34d: the splash entry chime was removed per user request
  return (
    <div className="min-h-screen flex items-center justify-center">
      <img src="/logo.png" alt="InspireTrade" draggable={false} className="h-16 w-auto animate-pulse" />
    </div>
  );
}

function DashboardPage() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><Dashboard /></AppLayout>;
}

function PremiumRoute() {
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <div className="min-h-screen flex flex-col"><Navbar /><PremiumPage onClose={() => navigate("/")} /></div>;
}

function NullRoute() {
  // The Economic Calendar lives in CalendarKeepAlive (below) so its iframe —
  // and the widget's currency/importance filters — survive route changes.
  return null;
}

function CalendarKeepAlive() {
  const { user, loading } = useAuth();
  const [match] = useRoute("/news");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (match) setMounted(true);
  }, [match]);

  if (loading) return match ? <LoadingScreen /> : null;
  if (!user) return match ? <AuthPage /> : null;
  if (!mounted) return null;

  return (
    <div className={match ? "min-h-screen flex flex-col" : "contents"}>
      {match && <Navbar />}
      <main className="flex-1">
        {/* display:none keeps the widget iframe alive while other pages are open */}
        <div className={match ? "" : "hidden"}>
          <NewsPage />
        </div>
      </main>
      {match && <AppFooter />}
    </div>
  );
}

function PropFirmRoute({ params }: { params: { challengeId?: string } }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><PropFirmPage params={params} /></AppLayout>;
}

function LeaderboardRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><LeaderboardPage /></AppLayout>;
}

function RewardsRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><RewardsPage /></AppLayout>;
}

function ProfileRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><ProfilePage /></AppLayout>;
}

function MarketRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><MarketPage /></AppLayout>;
}

function InventoryRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><InventoryPage /></AppLayout>;
}

function TerminalRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return (
    <AppLayout>
      <React.Suspense fallback={<LoadingScreen />}>
        <TerminalPage />
      </React.Suspense>
    </AppLayout>
  );
}

function WalletRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><WalletPage /></AppLayout>;
}

function AdminRoute() {
  const { user, loading } = useAuth();
  const isAdmin = useIsAdmin();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  if (!isAdmin) return <AdminRedirect />;
  return <AppLayout><AdminPage /></AppLayout>;
}

function AdminRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/");
  }, [navigate]);
  return <LoadingScreen />;
}

function CertificateRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><CertificatePage /></AppLayout>;
}

function TitlesRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><TitlesPage /></AppLayout>;
}

function PublicProfileRoute({ params }: { params: { handle: string } }) {
  if (!params.handle.startsWith("@")) return <NotFound />;
  return <PublicProfilePage username={params.handle.slice(1)} />;
}

function Router() {
  return (
    <>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/premium" component={PremiumRoute} />
        <Route path="/news" component={NullRoute} />
        <Route path="/prop-firm/:challengeId" component={PropFirmRoute} />
        <Route path="/prop-firm" component={PropFirmRoute} />
        <Route path="/leaderboard" component={LeaderboardRoute} />
        <Route path="/rewards" component={RewardsRoute} />
        <Route path="/profile" component={ProfileRoute} />
        <Route path="/market" component={MarketRoute} />
        <Route path="/inventory" component={InventoryRoute} />
        <Route path="/terminal" component={TerminalRoute} />
        <Route path="/wallet" component={WalletRoute} />
        <Route path="/admin" component={AdminRoute} />
        <Route path="/certificate" component={CertificateRoute} />
        <Route path="/titles"><TitlesRoute /></Route>
        <Route path="/:handle" component={PublicProfileRoute} />
        <Route component={NotFound} />
      </Switch>
      <CalendarKeepAlive />
    </>
  );
}

/**
 * Global render-crash guard: a thrown error in any route used to unmount the
 * whole React tree → the user saw a blank dark screen with no information.
 * The boundary keeps the shell alive and shows the error + a way forward.
 */
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[InspireTrade] render crash:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-lg font-semibold text-red-400">Something broke on this page</div>
          <div className="max-w-xl text-xs leading-relaxed text-slate-400">
            {this.state.error.message || String(this.state.error)}
            <br />
            <span className="text-slate-500">
              Your data is safe — this is a display error. Try reloading; if it persists, hard-refresh
              (Ctrl+Shift+R) to pick up the latest build.
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
            >
              Reload app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <ThemeProvider>
          <AuthProvider>
            <TooltipProvider>
              <AppErrorBoundary>
                <SettingsSync />
                <Toaster />
                <Router />
                <MusicPlayer />
                <ReferralApplier />
                <AlertsEngine />
                <TradingAlertsEngine />
                <InstallPrompt />
                {/* daily reward — auto-opens on site entry when today's reward
                    is unclaimed (self-gated: only for signed-in users, once per
                    day per session via "Later") */}
                <DailyRewardDialog />
                <PremiumNudge />
              </AppErrorBoundary>
            </TooltipProvider>
          </AuthProvider>
        </ThemeProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
