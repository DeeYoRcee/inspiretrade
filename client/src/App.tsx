import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ThemeProvider } from "@/lib/theme-context";
import { LanguageProvider } from "@/lib/language-context";
import { Navbar } from "@/components/layout/Navbar";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import AuthPage from "@/pages/AuthPage";
import PremiumPage from "@/pages/PremiumPage";
import NewsPage from "@/pages/NewsPage";
import PublicProfilePage from "@/pages/PublicProfilePage";
import PublicProfileSettingsPage from "@/pages/PublicProfileSettings";
import { InstallPrompt } from "@/components/InstallPrompt";
import { UsernamePrompt } from "@/components/UsernamePrompt";
import { Activity, Send } from "lucide-react";
import { useEffect, type ReactNode } from "react";

function PremiumSuccessHandler() {
  const [location, navigate] = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    if (location.includes("premium=success") && user) {
      navigate("/");
    }
  }, [location, user]);

  return null;
}

function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1">{children}</main>
      <footer className="py-8 border-t border-border/50 bg-card/30 backdrop-blur-sm">
        <div className="container mx-auto px-4 text-center">
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-muted-foreground uppercase tracking-widest font-medium">
              For advertising & inquiries
            </p>
            <a
              href="https://t.me/fck_ed"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-6 py-2 rounded-full bg-[#0088cc]/10 text-[#0088cc] border border-[#0088cc]/20 hover:bg-[#0088cc]/20 transition-all font-semibold"
            >
              <Send className="w-4 h-4" />
              Telegram
            </a>
          </div>
        </div>
      </footer>
      <UsernamePrompt />
      <PremiumSuccessHandler />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Activity className="w-8 h-8 text-primary animate-pulse" />
    </div>
  );
}

function DashboardPage() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return (
    <AppLayout>
      <Dashboard />
    </AppLayout>
  );
}

function PremiumRoute() {
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <PremiumPage onClose={() => navigate("/")} />
    </div>
  );
}

function NewsRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return (
    <AppLayout>
      <NewsPage />
    </AppLayout>
  );
}

function PublicProfileSettingsRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return (
    <AppLayout>
      <PublicProfileSettingsPage />
    </AppLayout>
  );
}

function PublicProfileRoute({ params }: { params: { handle: string } }) {
  if (!params.handle.startsWith("@")) return <NotFound />;
  return <PublicProfilePage username={params.handle.slice(1)} />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={DashboardPage} />
      <Route path="/premium" component={PremiumRoute} />
      <Route path="/news" component={NewsRoute} />
      <Route path="/public-profile" component={PublicProfileSettingsRoute} />
      <Route path="/:handle" component={PublicProfileRoute} />
      <Route component={NotFound} />
    </Switch>
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
              <InstallPrompt />
            </TooltipProvider>
          </AuthProvider>
        </ThemeProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
