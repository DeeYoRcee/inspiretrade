import { Switch, Route, useLocation, useRoute } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { ThemeProvider } from "@/lib/theme-context";
import { LanguageProvider, useLanguage } from "@/lib/language-context";
import { Navbar } from "@/components/layout/Navbar";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import AuthPage from "@/pages/AuthPage";
import PremiumPage from "@/pages/PremiumPage";
import NewsPage from "@/pages/NewsPage";
import PublicProfilePage from "@/pages/PublicProfilePage";
import PublicProfileSettingsPage from "@/pages/PublicProfileSettings";
import PropFirmPage from "@/pages/PropFirmPage";
import RewardsPage from "@/pages/RewardsPage";
import ProfilePage from "@/pages/ProfilePage";
import MarketPage from "@/pages/MarketPage";
import InventoryPage from "@/pages/InventoryPage";
import TerminalPage from "@/pages/TerminalPage";
import SettingsPage from "@/pages/SettingsPage";
import WalletPage from "@/pages/WalletPage";
import AdminPage from "@/pages/AdminPage";
import CertificatePage from "@/pages/CertificatePage";
import { InstallPrompt } from "@/components/InstallPrompt";
import { UsernamePrompt } from "@/components/UsernamePrompt";
import { DailyRewardDialog } from "@/components/rewards/DailyRewardDialog";
import { GlobalChat } from "@/components/chat/GlobalChat";
import { AlertsEngine } from "@/components/news/AlertsEngine";
import { useIsAdmin } from "@/hooks/use-admin";
import { useEconomyInvalidator } from "@/hooks/use-economy";
import { authedFetch } from "@/lib/api";
import { captureRefFromUrl, popStoredRef, clearStoredRef } from "@/lib/referral";
import { Activity, Send } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

function PremiumSuccessHandler() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user || !window.location.search.includes("premium=success")) return;
    window.history.replaceState(null, "", "/");
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
        // Only brand-new accounts can apply a referral code (15-minute window).
        const created = new Date(user.metadata.creationTime || Date.now()).getTime();
        if (Date.now() - created > 15 * 60 * 1000) {
          clearStoredRef();
          return;
        }
        await authedFetch("/api/referral?action=apply", { code });
        clearStoredRef();
        invalidate();
        toast({ title: t("referralAppliedTitle"), description: t("referralAppliedBody") });
      } catch {
        // Invalid code / self-referral / already referred — drop silently.
        clearStoredRef();
      }
    })();
  }, [user]);

  return null;
}

function AppFooter() {
  const { t } = useLanguage();
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
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1">{children}</main>
      <AppFooter />
      <UsernamePrompt />
      <PremiumSuccessHandler />
      <DailyRewardDialog />
      <GlobalChat />
    </div>
  );
}

function LoadingScreen() {
  return <div className="min-h-screen flex items-center justify-center"><Activity className="w-8 h-8 text-primary animate-pulse" /></div>;
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

function PublicProfileSettingsRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><PublicProfileSettingsPage /></AppLayout>;
}

function PropFirmRoute({ params }: { params: { challengeId?: string } }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><PropFirmPage params={params} /></AppLayout>;
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
  return <AppLayout><TerminalPage /></AppLayout>;
}

function SettingsRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <AppLayout><SettingsPage /></AppLayout>;
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
        <Route path="/public-profile" component={PublicProfileSettingsRoute} />
        <Route path="/prop-firm/:challengeId" component={PropFirmRoute} />
        <Route path="/prop-firm" component={PropFirmRoute} />
        <Route path="/rewards" component={RewardsRoute} />
        <Route path="/profile" component={ProfileRoute} />
        <Route path="/market" component={MarketRoute} />
        <Route path="/inventory" component={InventoryRoute} />
        <Route path="/terminal" component={TerminalRoute} />
        <Route path="/settings" component={SettingsRoute} />
        <Route path="/wallet" component={WalletRoute} />
        <Route path="/admin" component={AdminRoute} />
        <Route path="/certificate" component={CertificateRoute} />
        <Route path="/:handle" component={PublicProfileRoute} />
        <Route component={NotFound} />
      </Switch>
      <CalendarKeepAlive />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <ThemeProvider>
          <AuthProvider>
            <TooltipProvider>
              <Toaster />
              <Router />
              <ReferralApplier />
              <AlertsEngine />
              <InstallPrompt />
            </TooltipProvider>
          </AuthProvider>
        </ThemeProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
