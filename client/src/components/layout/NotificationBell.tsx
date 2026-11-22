import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Bell, BellRing, CalendarDays, CheckCheck, Newspaper, Radar, Trash2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/lib/language-context";
import { SYMBOL_COLOR } from "@/lib/news-api";
import { cn } from "@/lib/utils";
import {
  ALERTS_CHANGED_EVENT,
  clearAlertLog,
  getAlertLog,
  getUnreadCount,
  markAllAlertsRead,
  type AlertLogEntry,
} from "@/lib/notifications";
import {
  deleteNotif, getNotifItems, markAllNotifsRead, markNotifRead,
  subscribeNotificationCenter, type NotifCategory, type NotifItem,
} from "@/lib/notification-center";

function timeAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const CATEGORIES: { id: NotifCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "news", label: "News" },
  { id: "calendar", label: "Calendar" },
  { id: "alert", label: "Alerts" },
  { id: "system", label: "System" },
];

function CategoryIcon({ category, symbol }: { category: NotifCategory; symbol?: string }) {
  if (category === "news") return <Newspaper className="h-2.5 w-2.5" />;
  if (category === "calendar") return <CalendarDays className="h-2.5 w-2.5" />;
  if (category === "alert") return <Radar className="h-2.5 w-2.5" />;
  return <Wrench className="h-2.5 w-2.5" />;
}

/**
 * PHASE 47 Part 2 — the UNIFIED Notification Center (navbar bell).
 * One chronological list across all categories (Market News, Economic
 * Calendar, Trading Alerts, System), category filters, per-item mark-read /
 * delete, mark-all-read, unread badge and deep links into the content.
 * Backed by the synced RTDB store + the legacy device log (existing records
 * remain readable — nothing was migrated or overwritten).
 */
export function NotificationBell() {
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [items, setItems] = useState<NotifItem[]>([]);
  const [localUnread, setLocalUnread] = useState(0);
  const [filter, setFilter] = useState<NotifCategory | "all">("all");
  const [open, setOpen] = useState(false);

  const refresh = () => {
    setItems(getNotifItems());
    setLocalUnread(getUnreadCount());
  };

  useEffect(() => {
    refresh();
    const off = subscribeNotificationCenter(refresh);
    window.addEventListener(ALERTS_CHANGED_EVENT, refresh);
    return () => { off(); window.removeEventListener(ALERTS_CHANGED_EVENT, refresh); };
  }, []);

  const filtered = useMemo(() => (filter === "all" ? items : items.filter((n) => n.category === filter)), [items, filter]);
  // unread = synced records with readAt==null + the legacy local log marker
  const unread = useMemo(() => {
    const remoteUnread = items.filter((n) => n.source === "synced" && !n.readAt).length;
    return remoteUnread + localUnread;
  }, [items, localUnread]);

  const openItem = async (n: NotifItem) => {
    if (n.source === "synced" && !n.readAt) await markNotifRead(n.id);
    navigate(n.url || (n.category === "alert" ? "/terminal" : "/news"));
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(o) => { setOpen(o); if (o) refresh(); }}>
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
      <DropdownMenuContent align="end" className="glass-panel w-[min(22rem,calc(100vw-1.5rem))] border-border/60">
        <div className="flex items-center justify-between px-3 pt-2">
          <span className="text-sm font-semibold">{t("notifications")}</span>
          <div className="flex items-center gap-1">
            <button
              title="Mark all as read"
              onClick={() => { markAllAlertsRead(); void markAllNotifsRead(); refresh(); }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <CheckCheck className="h-3.5 w-3.5" />
            </button>
            <button
              title="Clear all"
              onClick={() => { clearAlertLog(); void import("@/lib/notification-center").then((m) => m.clearNotifs()).then(refresh); }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {/* category filters */}
        <div className="flex flex-wrap gap-1 px-3 py-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilter(c.id)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors",
                filter === c.id ? "bg-primary text-primary-foreground" : "bg-secondary/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <DropdownMenuSeparator />
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t("alertsEmpty")}</p>
        ) : (
          <div className="max-h-[min(22rem,50dvh)] overflow-y-auto">
            {filtered.map((n) => {
              const color = SYMBOL_COLOR[n.symbol ?? ""] ?? (n.category === "alert" ? "#fbbf24" : n.category === "system" ? "#94a3b8" : "#9ca3af");
              return (
                <div
                  key={`${n.source}-${n.id}`}
                  className={cn("group flex w-full items-start gap-2.5 px-3 py-2 transition-colors hover:bg-accent/50", n.source === "synced" && !n.readAt && "bg-primary/5")}
                >
                  <button onClick={() => void openItem(n)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                    <span
                      className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                      style={{ color, backgroundColor: `${color}1f` }}
                    >
                      <CategoryIcon category={n.category} symbol={n.symbol} />
                      {n.symbol ?? n.category}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-xs", n.source === "synced" && !n.readAt ? "font-semibold text-foreground" : "font-medium text-foreground/90")}>{n.title}</span>
                      {n.body && <span className="block truncate text-[10px] text-muted-foreground">{n.body}</span>}
                      <span className="block text-[10px] text-muted-foreground">
                        {n.category === "news" ? t("marketNews") : n.category === "calendar" ? t("alertsCalendar") : n.category === "alert" ? "Trading alert" : "System"} · {timeAgo(n.at)}
                      </span>
                    </span>
                  </button>
                  <button
                    title="Delete notification"
                    onClick={() => { if (n.source === "synced") void deleteNotif(n.id).then(refresh); else { clearAlertLog(); refresh(); } }}
                    className="mt-0.5 shrink-0 text-muted-foreground/0 transition-colors hover:text-destructive group-hover:text-muted-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/terminal")} className="cursor-pointer gap-2">
          <Radar className="h-4 w-4" />
          Trading alerts manager
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/news")} className="cursor-pointer gap-2">
          <BellRing className="h-4 w-4" />
          {t("alertsSettings")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// keep the legacy type import referenced for API compatibility of callers
export type { AlertLogEntry };
