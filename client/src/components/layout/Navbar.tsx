import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme, THEME_LABELS, THEMES, type Theme } from "@/lib/theme-context";
import { LANGUAGE_LABELS, type Language, useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { LogOut, Send, Instagram, TriangleAlert as AlertTriangle, Palette, FileDown, Crown, AtSign, Settings, ChevronLeft, ChevronRight, CalendarDays, Globe as Globe2, LayoutDashboard, Activity, UserRound } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTrades } from "@/hooks/use-trades";
import { useUserProfile, usePremiumStatus } from "@/hooks/use-premium";
import { UsernameDialog } from "@/components/dashboard/UsernameDialog";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

const THEME_NAMES: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  glass: "Glass",
  ocean: "Ocean",
  forest: "Forest",
  sunset: "Sunset",
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

export function Navbar() {
  const { logout, user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showUsername, setShowUsername] = useState(false);
  const [settingsView, setSettingsView] = useState<"main" | "language">("main");
  const { data: trades } = useTrades();
  const { data: profile } = useUserProfile();
  const { data: isPremium = false } = usePremiumStatus();
  const [location, navigate] = useLocation();

  const exportPDF = () => {
    if (!trades?.length) return;
    const totalPnL = trades.reduce((acc, trade) => acc + trade.profit, 0);
    const wins = trades.filter((trade) => trade.profit > 0).length;
    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const rows = trades.slice(0, 100).map((trade) => `<tr><td>${format(new Date(trade.timestamp), "MM/dd/yy")}</td><td>${escapeHtml(trade.assetName)}</td><td>${escapeHtml(trade.type)}</td><td>$${trade.entryPrice.toFixed(2)}</td><td>$${trade.exitPrice.toFixed(2)}</td><td>$${trade.profit.toFixed(2)}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trade Journal Report</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}th{background:#18181b;color:white}@media(max-width:600px){body{padding:12px}table{font-size:10px}th,td{padding:5px}}</style></head><body><h1>Trade Journal Report</h1><p>Generated: ${format(new Date(), "PPP")} · ${escapeHtml(user?.email || "")}</p><p>Total trades: ${trades.length} · Win rate: ${winRate}% · Wins: ${wins} · Net PnL: $${totalPnL.toFixed(2)}</p><div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Entry</th><th>Exit</th><th>PnL</th></tr></thead><tbody>${rows}</tbody></table></div><script>window.onload=()=>window.print()</script></body></html>`;
    const printWindow = window.open("", "_blank");
    if (printWindow) { printWindow.document.write(html); printWindow.document.close(); }
  };

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/prop-firm", label: "Prop", icon: Activity },
    { href: "/news", label: t("macroPulse"), icon: CalendarDays },
    { href: "/public-profile", label: "Profile", icon: Globe2 },
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

      {user && <UsernameDialog open={showUsername} currentUsername={profile?.username} isPremium={isPremium} onClose={() => setShowUsername(false)} />}

      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/95 backdrop-blur-md">
        <div className="container mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4 md:min-h-16 md:flex-nowrap">
          <button onClick={() => navigate("/")} aria-label="Trade Journal home" className="order-1 flex h-10 shrink-0 items-center"><img src="/logo.png" alt="Trade Journal" className="h-9 w-auto max-w-[130px] object-contain sm:h-10" /></button>

          {user && <nav aria-label="Main navigation" className="order-3 -mx-3 flex w-[calc(100%+1.5rem)] min-w-0 items-center overflow-x-auto border-t border-border/40 px-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:order-2 md:mx-auto md:w-auto md:max-w-full md:justify-center md:overflow-visible md:rounded-full md:border md:border-border/60 md:bg-card/60 md:p-1 md:pt-1">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? location === "/" : location.startsWith(href);
              return <Button key={href} variant={active ? "secondary" : "ghost"} size="sm" onClick={() => navigate(href)} aria-current={active ? "page" : undefined} className={cn("h-9 shrink-0 gap-1.5 rounded-full px-3 text-xs sm:text-sm", active && "text-emerald-500")}><Icon className="h-4 w-4 shrink-0" /><span className="whitespace-nowrap">{label}</span></Button>;
            })}
          </nav>}

          {user && <div className="order-2 ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-border/60 bg-card/60 p-1 sm:gap-1 md:order-3">
            {isPremium && <div className="hidden items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary lg:flex"><Crown className="h-3 w-3" />Premium</div>}
            {profile?.username && <span className="hidden max-w-28 truncate px-2 text-sm text-muted-foreground lg:block">@{profile.username}</span>}
            <Button variant="ghost" size="icon" onClick={exportPDF} title={t("exportPdf")} aria-label={t("exportPdf")} className="h-9 w-9 rounded-full text-muted-foreground"><FileDown className="h-4 w-4" /></Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Theme" title={`Theme: ${THEME_NAMES[theme]}`} className="h-9 gap-1.5 rounded-full px-2.5"><Palette className="h-4 w-4" /><span className="text-xs sm:text-sm">Theme</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-panel w-48 border-border/60">{THEMES.map((themeOption: Theme) => <DropdownMenuItem key={themeOption} onSelect={() => setTheme(themeOption)} className={cn("cursor-pointer", theme === themeOption && "bg-primary/10 font-semibold text-primary")}><span className={cn("mr-2 h-3 w-3 rounded-full border border-foreground/20", `theme-dot-${themeOption}`)} />{THEME_NAMES[themeOption]}{theme === themeOption && <span className="ml-auto text-xs">✓</span>}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu onOpenChange={(open) => !open && setSettingsView("main")}>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t("settings")} className="h-9 gap-1.5 rounded-full px-2.5"><Settings className="h-4 w-4" /><span className="hidden text-xs sm:inline sm:text-sm">{t("settings")}</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-panel w-52 border-border/60">{settingsView === "main" ? <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setSettingsView("language"); }} className="cursor-pointer gap-2">{t("language")}<ChevronRight className="ml-auto h-4 w-4" /></DropdownMenuItem> : <><DropdownMenuItem onSelect={(event) => { event.preventDefault(); setSettingsView("main"); }} className="cursor-pointer gap-2"><ChevronLeft className="h-4 w-4" />{t("settings")}</DropdownMenuItem><DropdownMenuSeparator />{(Object.keys(LANGUAGE_LABELS) as Language[]).map((code) => <DropdownMenuItem key={code} onSelect={() => setLanguage(code)} className={cn("cursor-pointer", language === code && "bg-primary/10 text-primary")}>{LANGUAGE_LABELS[code]}</DropdownMenuItem>)}</>}</DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t("account")} className="h-9 w-9 rounded-full p-0 md:w-auto md:px-2.5"><UserRound className="h-4 w-4 md:hidden" /><span className="hidden md:inline">{t("account")}</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-panel w-52 border-border/60"><div className="truncate px-3 py-2 text-xs text-muted-foreground">{user.email}</div><DropdownMenuSeparator /><DropdownMenuItem onClick={() => navigate("/public-profile")} className="cursor-pointer gap-2"><Globe2 className="h-4 w-4" />{t("publicProfile")}</DropdownMenuItem><DropdownMenuItem onClick={() => setShowUsername(true)} className="cursor-pointer gap-2"><AtSign className="h-4 w-4" />{t("usernameSettings")}</DropdownMenuItem>{!isPremium && <DropdownMenuItem onClick={() => navigate("/premium")} className="cursor-pointer gap-2 text-primary"><Crown className="h-4 w-4" />{t("getPremium")}</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem onClick={() => setShowConfirm(true)} className="cursor-pointer gap-2 text-destructive focus:text-destructive"><LogOut className="h-4 w-4" />{t("logout")}</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          </div>}
        </div>
      </header>
      {user && <div className="social-badge"><a href="https://t.me/DeeYoRcee_Inspire" target="_blank" rel="noreferrer" className="social-badge-item text-[#0088cc]"><Send className="h-5 w-5" /><span className="text-sm font-bold text-foreground">Telegram</span></a><a href="https://instagram.com/DeeYoRcee_Inspire" target="_blank" rel="noreferrer" className="social-badge-item text-[#E1306C]"><Instagram className="h-5 w-5" /><span className="text-sm font-bold text-foreground">Instagram</span></a></div>}
    </>
  );
}
