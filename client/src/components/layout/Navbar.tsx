import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/lib/theme-context";
import { LANGUAGE_LABELS, type Language, useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { LogOut, Send, Instagram, AlertTriangle, Sun, Moon, FileDown, Crown, AtSign, Settings, ChevronLeft, ChevronRight, CalendarDays, Home, Globe2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTrades } from "@/hooks/use-trades";
import { useUserProfile } from "@/hooks/use-premium";
import { UsernameDialog } from "@/components/dashboard/UsernameDialog";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

export function Navbar() {
  const { logout, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showUsername, setShowUsername] = useState(false);
  const [settingsView, setSettingsView] = useState<"main" | "language">("main");
  const { data: trades } = useTrades();
  const { data: profile } = useUserProfile();
  const [location, navigate] = useLocation();

  const exportPDF = () => {
    if (!trades || trades.length === 0) return;

    const totalPnL = trades.reduce((acc, t) => acc + t.profit, 0);
    const wins = trades.filter(t => t.profit > 0).length;
    const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : "0";

    const rows = trades.slice(0, 100).map(t => `
      <tr>
        <td>${format(new Date(t.timestamp), "MM/dd/yy")}</td>
        <td>${t.assetName}</td>
        <td>${t.type}</td>
        <td>$${t.entryPrice.toFixed(2)}</td>
        <td>$${t.exitPrice.toFixed(2)}</td>
        <td style="color:${t.profit >= 0 ? '#16a34a' : '#dc2626'};font-weight:bold">
          ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}
        </td>
      </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><title>Trade Journal Report</title>
    <style>
      body{font-family:Arial,sans-serif;padding:24px;color:#111}
      h1{font-size:22px;margin-bottom:4px}
      .meta{color:#555;font-size:13px;margin-bottom:16px}
      .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
      .card{background:#f4f4f5;border-radius:8px;padding:12px}
      .card .val{font-size:22px;font-weight:bold;margin:4px 0}
      .card .lbl{font-size:11px;color:#666;text-transform:uppercase}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#18181b;color:#fff;padding:8px 6px;text-align:left}
      td{padding:6px;border-bottom:1px solid #e4e4e7}
      tr:hover td{background:#fafafa}
      @media print{button{display:none}}
    </style></head><body>
    <h1>📊 Trade Journal Report</h1>
    <div class="meta">Generated: ${format(new Date(), "PPP")} &nbsp;·&nbsp; ${user?.email || ""}</div>
    <div class="summary">
      <div class="card"><div class="lbl">Total Trades</div><div class="val">${trades.length}</div></div>
      <div class="card"><div class="lbl">Win Rate</div><div class="val">${winRate}%</div></div>
      <div class="card"><div class="lbl">Wins</div><div class="val" style="color:#16a34a">${wins}</div></div>
      <div class="card"><div class="lbl">Net PnL</div><div class="val" style="color:${totalPnL >= 0 ? '#16a34a' : '#dc2626'}">${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}</div></div>
    </div>
    <table><thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Entry</th><th>Exit</th><th>PnL</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();window.close()}</script>
    </body></html>`;

    const win = window.open('', '_blank');
    if (win) { win.document.write(html); win.document.close(); }
  };

  return (
    <>
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent className="glass-panel border-border/60">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-display">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              {t("logoutTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {t("logoutDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={logout}
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("yesLogout")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {user && (
        <UsernameDialog
          open={showUsername}
          currentUsername={profile?.username}
          isPremium={profile?.isPremium}
          onClose={() => setShowUsername(false)}
        />
      )}

      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="Trade Journal" className="h-10 w-auto object-contain" />
          </div>

          {user && (
            <div className="flex items-center gap-1 sm:gap-2">
              {/* Premium badge */}
              {profile?.isPremium && (
                <div className="hidden sm:flex items-center gap-1 bg-primary/10 border border-primary/20 rounded-full px-2.5 py-1 text-xs font-semibold text-primary">
                  <Crown className="w-3 h-3" />
                  Premium
                </div>
              )}

              {/* Username display */}
              {profile?.username && (
                <span className="hidden md:block text-sm text-muted-foreground">
                  @{profile.username}
                </span>
              )}

              <Button
                variant={location === "/news" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => navigate("/news")}
                title={t("macroPulse")}
                className={cn(
                  "rounded-full gap-1.5",
                  location === "/news" ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarDays className="h-4 w-4" />
                <span className="hidden sm:inline">{t("macroPulse")}</span>
              </Button>

              {location === "/news" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/")}
                  title={t("backToDashboard")}
                  aria-label={t("backToDashboard")}
                  className="rounded-full gap-1.5"
                >
                  <Home className="h-4 w-4" />
                  <span className="hidden sm:inline">{t("backToDashboard")}</span>
                </Button>
              )}

              <Button
                variant="ghost"
                size="icon"
                onClick={exportPDF}
                title={t("exportPdf")}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                <FileDown className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                title={t("toggleTheme")}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>

              {/* Settings menu */}
              <DropdownMenu onOpenChange={(open) => !open && setSettingsView("main")}>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className="rounded-full ml-1 gap-1.5">
                    <Settings className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{t("settings")}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="glass-panel border-border/60 w-48">
                  {settingsView === "main" ? (
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        setSettingsView("language");
                      }}
                      className="cursor-pointer gap-2"
                    >
                      {t("language")}
                      <ChevronRight className="ml-auto w-4 h-4" />
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          setSettingsView("main");
                        }}
                        className="cursor-pointer gap-2"
                      >
                        <ChevronLeft className="w-4 h-4" />
                        {t("settings")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {(Object.keys(LANGUAGE_LABELS) as Language[]).map((code) => (
                        <DropdownMenuItem
                          key={code}
                          onSelect={() => setLanguage(code)}
                          className={cn(
                            "cursor-pointer",
                            language === code && "bg-primary/10 text-primary"
                          )}
                        >
                          {LANGUAGE_LABELS[code]}
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Account menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className="rounded-full ml-1 gap-1.5">
                    <span className="hidden sm:inline">{t("account")}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="glass-panel border-border/60 w-48">
                   <div className="px-3 py-2 text-xs text-muted-foreground truncate">{user.email}</div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/public-profile")} className="gap-2 cursor-pointer">
                    <Globe2 className="w-4 h-4" /> {t("publicProfile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowUsername(true)} className="gap-2 cursor-pointer">
                     <AtSign className="w-4 h-4" /> {t("usernameSettings")}
                  </DropdownMenuItem>
                  {!profile?.isPremium && (
                    <DropdownMenuItem
                      onClick={() => navigate("/premium")}
                      className="gap-2 cursor-pointer text-primary"
                    >
                       <Crown className="w-4 h-4" /> {t("getPremium")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setShowConfirm(true)}
                    className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                  >
                     <LogOut className="w-4 h-4" /> {t("logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </header>

      {user && (
        <div className="social-badge">
          <a
            href="https://t.me/DeeYoRcee_Inspire"
            target="_blank"
            rel="noreferrer"
            className="social-badge-item text-[#0088cc]"
          >
            <Send className="w-5 h-5" />
            <span className="text-sm font-bold text-foreground">Telegram</span>
          </a>
          <a
            href="https://instagram.com/DeeYoRcee_Inspire"
            target="_blank"
            rel="noreferrer"
            className="social-badge-item text-[#E1306C]"
          >
            <Instagram className="w-5 h-5" />
            <span className="text-sm font-bold text-foreground">Instagram</span>
          </a>
        </div>
      )}
    </>
  );
}
