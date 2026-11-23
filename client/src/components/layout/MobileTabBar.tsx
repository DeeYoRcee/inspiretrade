import { useState } from "react";
import { useLocation } from "wouter";
import {
  Home, ChartCandlestick, Store, Newspaper, Wallet, LayoutGrid,
  Activity, Gift, Trophy, UserRound, Package, Award, Globe2, Crown,
  Settings, ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePremiumStatus } from "@/hooks/use-premium";
import { useIsAdmin } from "@/hooks/use-admin";
import { useLanguage } from "@/lib/language-context";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * P43 — dedicated mobile navigation: a fixed bottom tab bar with the five
 * primary destinations plus a "More" bottom sheet holding every secondary
 * page. Touch-sized (h-14 rows, 44px+ targets), safe-area aware, active
 * indicators via wouter location. Desktop keeps the header pill bar — this
 * component renders nothing at md and above.
 */

const TABS: { href: string; icon: typeof Home; key: string | null; label: string | null }[] = [
  { href: "/", icon: Home, key: null, label: "Dashboard" },
  { href: "/terminal", icon: ChartCandlestick, key: "terminal", label: null },
  { href: "/market", icon: Store, key: "market", label: null },
  { href: "/news", icon: Newspaper, key: "news", label: null },
  { href: "/wallet", icon: Wallet, key: "wallet", label: null },
];

export function MobileTabBar() {
  const { user } = useAuth();
  const { data: isPremium = false } = usePremiumStatus();
  const isAdmin = useIsAdmin();
  const { t } = useLanguage();
  const [location, navigate] = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  if (!user) return null;

  const isActive = (href: string) => (href === "/" ? location === "/" : location.startsWith(href));

  const moreItems: { href: string; icon: typeof Activity; label: string; hide?: boolean }[] = [
    { href: "/prop-firm", icon: Activity, label: t("propFirm") },
    { href: "/rewards", icon: Gift, label: t("rewards") },
    { href: "/leaderboard", icon: Trophy, label: t("leaderboard") },
    { href: "/profile", icon: UserRound, label: t("profile") },
    { href: "/inventory", icon: Package, label: t("inventory") },
    { href: "/titles", icon: Award, label: t("titles") },
    { href: "/premium", icon: Crown, label: t("getPremium"), hide: isPremium },
    ...(isAdmin ? [{ href: "/admin", icon: ShieldCheck, label: t("adminPanel") }] : []),
  ];

  return (
    <>
      {/* bottom tab bar — phones only (md and above keep the header pill bar) */}
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-[60] grid grid-cols-6 border-t border-border/60 bg-background/95 backdrop-blur-md md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map((item) => {
          const { href, icon: Icon, key } = item;
          const active = isActive(href);
          return (
            <button
              key={href}
              onClick={() => { if (!active) navigate(href); setMoreOpen(false); }}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors active:bg-accent/40",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className={cn("h-5 w-5", active && "drop-shadow-[0_0_8px_hsl(var(--primary)/0.6)]")} />
              <span className="max-w-full truncate px-0.5">{item.key ? t(item.key) : item.label}</span>
              {active && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />}
            </button>
          );
        })}
        <button
          onClick={() => setMoreOpen(true)}
          aria-label={t("more")}
          className="flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-muted-foreground transition-colors active:bg-accent/40"
        >
          <LayoutGrid className="h-5 w-5" />
          <span>{t("more")}</span>
        </button>
      </nav>

      {/* "More" — every secondary destination in one touch-sized sheet */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto rounded-t-2xl border-border/60 bg-card px-2 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2">
          <SheetHeader className="px-2 pb-1 text-left">
            <SheetTitle className="text-sm font-semibold">{t("more")}</SheetTitle>
            <SheetDescription className="text-xs text-muted-foreground">{user.email}</SheetDescription>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-1.5 pb-1">
            {moreItems.filter((it) => !it.hide).map(({ href, icon: Icon, label }) => {
              const active = isActive(href);
              return (
                <button
                  key={href}
                  onClick={() => { navigate(href); setMoreOpen(false); }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border px-1 text-center text-[11px] font-medium leading-tight transition-colors active:bg-accent/40",
                    active ? "border-primary/50 bg-primary/10 text-primary" : "border-border/50 bg-background/40 text-foreground/80",
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span className="line-clamp-2">{label}</span>
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
