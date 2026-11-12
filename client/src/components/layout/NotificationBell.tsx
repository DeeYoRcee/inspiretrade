import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Bell, BellRing, CalendarDays, Newspaper, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/lib/language-context";
import { SYMBOL_COLOR } from "@/lib/news-api";
import {
  ALERTS_CHANGED_EVENT,
  clearAlertLog,
  getAlertLog,
  getUnreadCount,
  markAllAlertsRead,
  type AlertLogEntry,
} from "@/lib/notifications";

function timeAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Navbar notification bell: unread badge + dropdown with the alert log
 * (news hits open the article, calendar hits open the News page).
 */
export function NotificationBell() {
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [log, setLog] = useState<AlertLogEntry[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const refresh = () => {
      setLog(getAlertLog());
      setUnread(getUnreadCount());
    };
    refresh();
    window.addEventListener(ALERTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ALERTS_CHANGED_EVENT, refresh);
  }, []);

  return (
    <DropdownMenu modal={false} onOpenChange={(open) => open && markAllAlertsRead()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("notifications")} title={t("notifications")} className="relative h-9 w-9 rounded-full p-0">
          {unread > 0 ? <BellRing className="h-4 w-4 text-primary" /> : <Bell className="h-4 w-4" />}
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="glass-panel w-80 border-border/60">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-semibold">{t("notifications")}</span>
          {log.length > 0 && (
            <button
              onClick={clearAlertLog}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
              {t("alertsClear")}
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {log.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t("alertsEmpty")}</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {log.map((entry) => {
              const color = SYMBOL_COLOR[entry.symbol ?? ""] ?? "#9ca3af";
              return (
                <button
                  key={`${entry.kind}-${entry.id}-${entry.at}`}
                  onClick={() => (entry.kind === "news" ? window.open(entry.id, "_blank") : navigate("/news"))}
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/50"
                >
                  <span
                    className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                    style={{ color, backgroundColor: `${color}1f` }}
                  >
                    {entry.kind === "calendar" ? <CalendarDays className="h-2.5 w-2.5" /> : <Newspaper className="h-2.5 w-2.5" />}
                    {entry.symbol}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{entry.title}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {entry.kind === "news" ? t("marketNews") : t("alertsCalendar")} · {timeAgo(entry.at)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/news")} className="cursor-pointer gap-2">
          <BellRing className="h-4 w-4" />
          {t("alertsSettings")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
