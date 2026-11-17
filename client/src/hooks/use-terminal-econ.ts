/**
 * Phase 5 terminal fundamental-data hooks.
 *
 * All queries share the react-query cache, so the EventStrip (mounted in
 * live/replay modes) and the Calendar/News workspaces never fetch twice.
 * Sources: /api/news?econ=calendar (ForexFactory mirror, all impact levels)
 * and /api/news (RSS aggregator with per-instrument tagging).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/lib/language-context";
import { fetchNews, type NewsItem } from "@/lib/news-api";
import { sessionStates, currentOverlaps, activityLabel, sessionWindows24h, type SessionState, type OverlapInfo } from "@shared/sessions";
import { symbolCurrencies, symbolNewsTags, type CalEventFull } from "@shared/econ";

const ECON_STALE = 10 * 60 * 1000;

export type EconRange = "thisweek" | "nextweek" | "thismonth";

interface EconCalResponse {
  ok: boolean;
  stale: boolean;
  range: EconRange;
  /** true when the range is a windowed view of the only upstream export */
  limited?: boolean;
  note?: string;
  updatedAt: number;
  count: number;
  events: CalEventFull[];
  source: string;
}

/** Full economic calendar (all impact levels) for a range. */
export function useEconCalendar(range: EconRange) {
  return useQuery({
    queryKey: ["econCalendar", range],
    queryFn: async (): Promise<EconCalResponse> => {
      const res = await fetch(`/api/news?econ=calendar&range=${range}`);
      if (!res.ok) throw new Error(`calendar fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: ECON_STALE,
    refetchInterval: ECON_STALE,
    retry: 1,
  });
}

/** thisweek + thismonth merged — enough coverage for history and the strip. */
export function useEconEvents() {
  const week = useEconCalendar("thisweek");
  const month = useEconCalendar("thismonth");
  const events = useMemo(() => {
    const seen = new Set<string>();
    const merged: CalEventFull[] = [];
    for (const e of [...(month.data?.events ?? []), ...(week.data?.events ?? [])]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    return merged.sort((a, b) => a.date - b.date);
  }, [week.data, month.data]);
  return {
    events,
    loading: week.isLoading || month.isLoading,
    error: !week.data?.ok && week.isError ? "calendar-unavailable" : (!week.data?.ok && week.data ? "calendar-source-down" : null),
    stale: !!(week.data?.stale || month.data?.stale),
    updatedAt: Math.max(week.data?.updatedAt ?? 0, month.data?.updatedAt ?? 0),
    source: week.data?.source ?? "ForexFactory weekly calendar (nfs.faireconomy.media)",
  };
}

// ---- terminal warning settings ----------------------------------------------

export interface EconWarnSettings {
  /** warn N minutes before high-impact events of the symbol's currencies */
  warnMinutes: number;
  /** OPTIONAL trade confirmation inside the warning window (never blocks by default) */
  confirmTrades: boolean;
}

const WARN_KEY = "it_econ_warn";

export function loadEconWarnSettings(): EconWarnSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(WARN_KEY) || "{}");
    return {
      warnMinutes: [5, 10, 15, 30, 60].includes(Number(raw.warnMinutes)) ? Number(raw.warnMinutes) : 15,
      confirmTrades: raw.confirmTrades === true,
    };
  } catch {
    return { warnMinutes: 15, confirmTrades: false };
  }
}

export function saveEconWarnSettings(s: EconWarnSettings): void {
  try {
    localStorage.setItem(WARN_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent("it-econ-warn-changed"));
  } catch { /* private mode */ }
}

export function useEconWarnSettings(): { settings: EconWarnSettings; update: (patch: Partial<EconWarnSettings>) => void } {
  const [settings, setSettings] = useState(loadEconWarnSettings);
  useEffect(() => {
    const sync = () => setSettings(loadEconWarnSettings());
    window.addEventListener("it-econ-warn-changed", sync);
    return () => window.removeEventListener("it-econ-warn-changed", sync);
  }, []);
  return {
    settings,
    update: (patch) => saveEconWarnSettings({ ...loadEconWarnSettings(), ...patch }),
  };
}

// ---- symbol-scoped derived data ---------------------------------------------

/** Upcoming events for the currencies a terminal symbol is quoted against. */
export function useNextSymbolEvents(symbol: string, impacts: string[] = ["High", "Medium"]) {
  const { events, loading, stale, source, updatedAt } = useEconEvents();
  const currencies = useMemo(() => symbolCurrencies(symbol), [symbol]);
  const upcoming = useMemo(
    () => events.filter((e) => e.date > Date.now() && impacts.includes(e.impact) && currencies.includes(e.currency)),
    [events, currencies, impacts.join(",")],
  );
  const nextHigh = useMemo(() => upcoming.find((e) => e.impact === "High") ?? null, [upcoming]);
  return { upcoming, nextHigh, currencies, loading, stale, source, updatedAt };
}

/** Warning object for the TradingPanel guard — null when nothing is imminent. */
export interface EventWarning {
  eventId: string;
  title: string;
  currency: string;
  date: number;
  minutesUntil: number;
}

export function useEventWarning(symbol: string): EventWarning | null {
  const { settings } = useEconWarnSettings();
  const { nextHigh } = useNextSymbolEvents(symbol, ["High"]);
  return useMemo(() => {
    if (!nextHigh) return null;
    const ms = nextHigh.date - Date.now();
    if (ms <= 0 || ms > settings.warnMinutes * 60000) return null;
    return {
      eventId: nextHigh.id,
      title: nextHigh.title,
      currency: nextHigh.currency,
      date: nextHigh.date,
      minutesUntil: Math.max(1, Math.round(ms / 60000)),
    };
  }, [nextHigh, settings.warnMinutes]);
}

/** Latest news items tagged for the terminal symbol. */
export function useRelevantNews(symbol: string, limit = 3): { items: NewsItem[]; updatedAt: number; loading: boolean } {
  const { language } = useLanguage();
  const { data, isLoading } = useQuery({
    queryKey: ["marketNews", language],
    queryFn: () => fetchNews(language),
    staleTime: 40 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: 1,
  });
  const tags = useMemo(() => symbolNewsTags(symbol), [symbol]);
  const items = useMemo(() => {
    const list = data?.items ?? [];
    const exact = list.filter((i) => i.symbols.some((s) => tags.includes(s)));
    return exact.slice(0, limit);
  }, [data, tags.join(",")]);
  return { items, updatedAt: data?.updatedAt ?? 0, loading: isLoading };
}

// ---- live sessions ------------------------------------------------------------

export interface SessionsSnapshot {
  now: number;
  states: SessionState[];
  overlaps: OverlapInfo[];
  openCount: number;
  activity: ReturnType<typeof activityLabel>;
  windows: ReturnType<typeof sessionWindows24h>;
}

/** 1s tick for countdowns; the Intl-heavy boundary math runs on every tick —
 *  4 sessions × a few formatToParts calls is far below a frame budget. */
export function useMarketSessions(): SessionsSnapshot {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const states = sessionStates(now);
    const overlaps = currentOverlaps(now, states);
    const openCount = states.filter((s) => s.open).length;
    return { now, states, overlaps, openCount, activity: activityLabel(openCount), windows: sessionWindows24h(now) };
  }, [now]);
}
