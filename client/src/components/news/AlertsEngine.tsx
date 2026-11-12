import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";
import { fetchNews } from "@/lib/news-api";
import {
  ALERTS_SETTINGS_EVENT,
  appendAlertLog,
  getCalSeen,
  getNewsSeen,
  loadAlertSettings,
  markCalSeen,
  markNewsSeen,
} from "@/lib/notifications";

/**
 * App-wide alert engine. Polls /api/news every minute (shares the
 * ["marketNews", lang] cache with the NewsPage feed), diffs it against the
 * localStorage "seen" markers and fires toasts + bell-log entries for:
 *  - fresh news (< 10 min) in symbols the user picked
 *  - high-impact calendar events in picked currencies within 30 minutes.
 * Everything degrades silently when data is unavailable.
 */
export function AlertsEngine() {
  const { toast } = useToast();
  const { language } = useLanguage();
  const settingsRef = useRef(loadAlertSettings());
  const newsBaseline = useRef(false);

  useEffect(() => {
    const sync = () => {
      settingsRef.current = loadAlertSettings();
    };
    window.addEventListener(ALERTS_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(ALERTS_SETTINGS_EVENT, sync);
  }, []);

  const { data } = useQuery({
    queryKey: ["marketNews", language],
    queryFn: () => fetchNews(language),
    staleTime: 45 * 1000,
    refetchInterval: 60 * 1000,
    retry: 1,
  });

  useEffect(() => {
    if (!data) return;
    const settings = settingsRef.current;
    const items = data.items ?? [];
    const seen = getNewsSeen();

    if (!newsBaseline.current) {
      // First load after opening the site: mark everything as seen so the
      // user only gets notified for items that arrive while they are here.
      markNewsSeen(items.map((i) => i.link));
      newsBaseline.current = true;
    } else if (settings.enabled && settings.symbols.length > 0) {
      const fresh = items.filter(
        (i) => !seen.has(i.link) && Date.now() - i.publishedAt < 10 * 60 * 1000 && i.symbols.some((s) => settings.symbols.includes(s)),
      );
      for (const item of fresh.slice(0, 3)) {
        const syms = item.symbols.filter((s) => settings.symbols.includes(s)).join(" · ");
        toast({ title: syms || "News", description: item.title });
        appendAlertLog({ id: item.link, kind: "news", symbol: item.symbols[0], title: item.title });
      }
    }
    // Always advance the baseline (also when alerts are disabled) so
    // re-enabling never dumps a backlog of toasts.
    markNewsSeen(items.map((i) => i.link));

    // ---- calendar alerts ----
    const calEvents = data.calendarOk ? data.calendar ?? [] : [];
    const calSeen = getCalSeen();
    if (settings.enabled && settings.calEnabled && settings.calCurrencies.length > 0) {
      const soon = calEvents.filter(
        (e) => e.impact === "High" && settings.calCurrencies.includes(e.currency) && !calSeen.has(e.id) && e.date > Date.now() && e.date - Date.now() <= 30 * 60 * 1000,
      );
      for (const ev of soon.slice(0, 2)) {
        const mins = Math.max(1, Math.round((ev.date - Date.now()) / 60000));
        toast({ title: `${ev.currency} — ${mins} min`, description: ev.title });
        appendAlertLog({ id: ev.id, kind: "calendar", symbol: ev.currency, title: ev.title });
        calSeen.add(ev.id);
      }
    }
    // Mark every already-released/seen event so stale ones never fire later.
    markCalSeen([...calSeen, ...calEvents.map((e) => e.id)]);
  }, [data, toast]);

  return null;
}
