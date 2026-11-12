import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme, THEME_LABELS, THEMES, type Theme } from "@/lib/theme-context";
import { LANGUAGE_LABELS, type Language, useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { LogOut, Send, Instagram, TriangleAlert as AlertTriangle, Palette, Crown, Settings, Newspaper, Globe as Globe2, LayoutDashboard, Activity, UserRound, Gift, Store, Coins, Package, Wallet, ShieldCheck, Award, User as UserIcon } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePremiumStatus } from "@/hooks/use-premium";
import { useEconomy } from "@/hooks/use-economy";
import { useIsAdmin } from "@/hooks/use-admin";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

export function Navbar() {
  const { logout, user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const [showConfirm, setShowConfirm] = useState(false);
  const { data: isPremium = false } = usePremiumStatus();
  const { data: economy } = useEconomy();
  const isAdmin = useIsAdmin();
  const [location, navigate] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/prop-firm", label: "Prop", icon: Activity },
    { href: "/rewards", label: t("rewards"), icon: Gift },
    { href: "/inventory", label: t("inventory"), icon: Package },
    { href: "/market", label: t("market"), icon: Store },
    { href: "/wallet", label: t("wallet"), icon: Wallet },
    { href: "/news", label: t("news"), icon: Newspaper },
  ];

  return (
    <>
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent className="glass-panel border-border/60">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-display"><AlertTriangle className="h-5 w-5 text-destructive" />{t("logoutTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">{t("logoutDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel className="rounded-xl">{t("cancel")}</AlertDialogCancel><AlertDialogAction onClick={logout} className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90">{t("yesLogout")}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <header className="sticky top-0 z-50 w-full shrink-0 border-b border-border/50 bg-background/95 backdrop-blur-md">
        <div className="container mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4 md:min-h-16 md:flex-nowrap">
          <button onClick={() => navigate("/")} aria-label="Trade Journal home" className="order-1 flex h-10 shrink-0 items-center"><img src="/logo.png" alt="Trade Journal" className="h-9 w-auto max-w-[130px] object-contain sm:h-10" /></button>
          {user && <nav aria-label="Main navigation" className="order-3 -mx-3 flex w-[calc(100%+1.5rem)] min-w-0 items-center overflow-x-auto rounded-none border-t border-border/40 bg-card/60 px-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:order-2 md:mx-auto md:w-auto md:max-w-full md:justify-center md:overflow-visible md:rounded-full md:border md:border-border/60 md:p-1 md:pt-1">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? location === "/" : location.startsWith(href);
              return <Button key={href} variant={active ? "secondary" : "ghost"} size="sm" onClick={() => navigate(href)} aria-current={active ? "page" : undefined} className={cn("h-9 shrink-0 gap-1.5 rounded-full px-3 text-xs sm:text-sm", active && "text-primary")}><Icon className="h-4 w-4 shrink-0" /><span className="whitespace-nowrap">{label}</span></Button>;
            })}
          </nav>}

          {user && <div className="order-2 ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-border/60 bg-card/60 p-1 sm:gap-1 md:order-3">
            {economy && (
              <>
                <button onClick={() => navigate("/wallet")} className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold text-amber-400 transition-colors hover:bg-amber-400/10 sm:text-sm" aria-label={t("inspireBalance")}>
                  <Coins className="h-4 w-4" />
                  <span className="font-number">{economy.coins}</span>
                  <span className="hidden sm:inline">INSP</span>
                </button>
              </>
            )}
            {isPremium && <div className="hidden items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary lg:flex"><Crown className="h-3 w-3" />Premium</div>}

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Theme" title={`Theme: ${THEME_LABELS[theme]}`} className="h-9 gap-1.5 rounded-full px-2.5"><Palette className="h-4 w-4" /><span className="text-xs sm:text-sm">Theme</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-panel w-48 border-border/60">{THEMES.map((themeOption: Theme) => <DropdownMenuItem key={themeOption} onSelect={() => setTheme(themeOption)} className={cn("cursor-pointer", theme === themeOption && "bg-primary/10 font-semibold text-primary")}><span className={cn("mr-2 h-3 w-3 rounded-full border border-foreground/20", `theme-dot-${themeOption}`)} />{THEME_LABELS[themeOption]}{theme === themeOption && <span className="ml-auto text-xs">✓</span>}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t("settings")} className="h-9 gap-1.5 rounded-full px-2.5"><Settings className="h-4 w-4" /><span className="hidden text-xs sm:inline sm:text-sm">{t("settings")}</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-panel w-52 border-border/60">{(Object.keys(LANGUAGE_LABELS) as Language[]).map((code) => <DropdownMenuItem key={code} onSelect={() => setLanguage(code)} className={cn("cursor-pointer", language === code && "bg-primary/10 text-primary")}>{LANGUAGE_LABELS[code]}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t("account")} className="h-9 w-9 rounded-full p-0 md:w-auto md:px-2.5"><UserRound className="h-4 w-4 md:hidden" /><span className="hidden md:inline">{t("account")}</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-panel w-52 border-border/60"><div className="truncate px-3 py-2 text-xs text-muted-foreground">{user.email}</div><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => navigate("/profile")} className="cursor-pointer gap-2"><UserIcon className="h-4 w-4" />{t("profile")}</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate("/public-profile")} className="cursor-pointer gap-2"><Globe2 className="h-4 w-4" />{t("publicProfile")}</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate("/certificate")} className="cursor-pointer gap-2"><Award className="h-4 w-4" />{t("certificate")}</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate("/wallet")} className="cursor-pointer gap-2"><Wallet className="h-4 w-4" />{t("wallet")}</DropdownMenuItem>{isAdmin && <DropdownMenuItem onSelect={() => navigate("/admin")} className="cursor-pointer gap-2 text-emerald-400"><ShieldCheck className="h-4 w-4" />{t("adminPanel")}</DropdownMenuItem>}{!isPremium && <DropdownMenuItem onSelect={() => navigate("/premium")} className="cursor-pointer gap-2 text-primary"><Crown className="h-4 w-4" />{t("getPremium")}</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setShowConfirm(true)} className="cursor-pointer gap-2 text-destructive focus:text-destructive"><LogOut className="h-4 w-4" />{t("logout")}</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          </div>}
        </div>
      </header>
      {user && <div className="social-badge"><a href="https://t.me/DeeYoRcee_Inspire" target="_blank" rel="noreferrer" className="social-badge-item text-[#0088cc]"><Send className="h-5 w-5" /><span className="text-sm font-bold text-foreground">Telegram</span></a><a href="https://instagram.com/DeeYoRcee_Inspire" target="_blank" rel="noreferrer" className="social-badge-item text-[#E1306C]"><Instagram className="h-5 w-5" /><span className="text-sm font-bold text-foreground">Instagram</span></a></div>}
    </>
  );
}
