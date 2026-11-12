import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, Clock3, Globe2, Loader2, Newspaper, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language-context";
import { useTheme } from "@/lib/theme-context";
import { cn } from "@/lib/utils";

const CALENDAR_WIDGET_CONFIG = {
  width: "100%",
  height: "100%",
  mode: 2,
  fw: "react",
  lang: "en",
};

// ---- market news -----------------------------------------------------------

const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "NASDAQ", "USD", "BTC"] as const;
type Symbol = (typeof SYMBOLS)[number];

// Brand accent per symbol — works on every theme (used as text/border color).
const SYMBOL_COLOR: Record<Symbol, string> = {
  XAUUSD: "#f59e0b",
  EURUSD: "#60a5fa",
  GBPUSD: "#c084fc",
  NASDAQ: "#34d399",
  USD: "#2dd4bf",
  BTC: "#f7931a",
};

interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
  summary: string;
  symbols: string[];
}

/** Compact relative time: 4m / 3h / 2d — digits need no translation. */
function timeAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function MarketNewsPanel() {
  const { t } = useLanguage();
  const [filter, setFilter] = useState<"All" | Symbol>("All");
  const [limit, setLimit] = useState(30);

  const { data, isLoading, isError, dataUpdatedAt, refetch, isFetching } = useQuery<{ items: NewsItem[] }>({
    queryKey: ["marketNews"],
    queryFn: async () => {
      const res = await fetch("/api/news");
      if (!res.ok) throw new Error("news fetch failed");
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const items = data?.items ?? [];
  const filtered = filter === "All" ? items : items.filter((item) => item.symbols.includes(filter));
  const visible = filtered.slice(0, limit);

  return (
    <Card className="overflow-hidden border-border/60 bg-card/80 shadow-2xl">
      <CardHeader className="flex flex-col gap-3 border-b border-border/50 px-3 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Newspaper className="h-5 w-5 shrink-0 text-primary" />
            <h2 className="truncate font-display text-lg font-semibold">{t("marketNews")}</h2>
          </div>
          <button
            onClick={() => refetch()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            title={t("newsUpdated")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            {dataUpdatedAt ? timeAgo(dataUpdatedAt) : ""}
          </button>
        </div>
        {/* symbol filter chips */}
        <div className="flex flex-wrap gap-1.5">
          {(["All", ...SYMBOLS] as const).map((sym) => {
            const active = filter === sym;
            const color = sym === "All" ? undefined : SYMBOL_COLOR[sym];
            return (
              <button
                key={sym}
                onClick={() => {
                  setFilter(sym);
                  setLimit(30);
                }}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-bold transition-colors",
                  active
                    ? "border-transparent text-background"
                    : "border-border/60 bg-card/60 text-muted-foreground hover:text-foreground",
                )}
                style={active && color ? { backgroundColor: color, color: "#0b0d0c" } : undefined}
              >
                {sym === "All" ? t("newsFilterAll") : sym}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="p-2 sm:p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="ml-3 text-sm">{t("newsLoading")}</span>
          </div>
        ) : isError ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("newsError")}</p>
        ) : visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("newsEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {visible.map((item) => (
              <a
                key={item.link}
                href={item.link}
                target="_blank"
                rel="noreferrer"
                className="block rounded-xl border border-border/40 bg-background/40 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-card/80"
              >
                <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 font-semibold text-foreground/80">
                    <Globe2 className="h-3 w-3" />
                    {item.source}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-3 w-3" />
                    {timeAgo(item.publishedAt)}
                  </span>
                  {item.symbols.slice(0, 3).map((sym) => (
                    <span
                      key={sym}
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                      style={{
                        color: SYMBOL_COLOR[sym as Symbol] ?? "#9ca3af",
                        backgroundColor: `${SYMBOL_COLOR[sym as Symbol] ?? "#9ca3af"}1f`,
                      }}
                    >
                      {sym}
                    </span>
                  ))}
                </div>
                <p className="text-sm font-medium leading-snug text-foreground">{item.title}</p>
                {item.summary && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.summary}</p>
                )}
              </a>
            ))}
            {filtered.length > visible.length && (
              <div className="pt-1 text-center">
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => setLimit((l) => l + 30)}>
                  +30 <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function NewsPage() {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const [tab, setTab] = useState<"news" | "calendar">("news");
  // Keep a stable ref to the widget container: the tradays script mounts into
  // it once and the iframe survives BOTH tab switches and route changes
  // (CalendarKeepAlive keeps this whole page alive with display:none).
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  // Widget themes: 1 = dark, 2 = light. Match the site's active theme and
  // re-mount the widget whenever the user switches themes.
  const widgetTheme = theme === "light" ? 2 : 1;

  // The widget effect is bound to the container element + theme: a theme
  // switch re-injects the widget with the matching dark/light variant, while
  // tab switches do nothing (the container keeps existing).
  useEffect(() => {
    if (!containerRef) return;
    const script = document.createElement("script");
    script.src = "https://www.tradays.com/c/js/widgets/calendar/widget.js?v=15";
    script.type = "text/javascript";
    script.async = true;
    script.dataset.type = "calendar-widget";
    script.innerHTML = JSON.stringify({ ...CALENDAR_WIDGET_CONFIG, theme: widgetTheme });

    containerRef.appendChild(script);

    return () => {
      script.remove();
      containerRef.querySelector("iframe")?.remove();
      const calendarIds = (window as Window & { calendarCompletedID?: string[] }).calendarCompletedID;
      const registeredCalendarIndex = calendarIds?.indexOf("economicCalendarWidget") ?? -1;
      if (registeredCalendarIndex >= 0) calendarIds?.splice(registeredCalendarIndex, 1);
    };
  }, [containerRef, widgetTheme]);

  return (
    <div className="container mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-8">
      {/* Page header */}
      <div className="mb-4 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4 shadow-lg sm:mb-6 sm:p-6">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary"><span className="h-2 w-2 animate-pulse rounded-full bg-success" />{t("macroPulseLive")}</div>
        <h1 className="flex items-center gap-2 text-2xl font-display font-bold text-gradient sm:gap-3 sm:text-3xl"><Newspaper className="h-7 w-7 shrink-0 text-primary sm:h-8 sm:w-8" />{t("news")}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t("newsDescription")}</p>
      </div>

      {/* Tabs — Market News | Economic Calendar. Both panels stay mounted so
          the calendar iframe and its filters are never destroyed. */}
      <div className="mb-4 flex gap-1.5" role="tablist" aria-label={t("news")}>
        <button
          role="tab"
          aria-selected={tab === "news"}
          onClick={() => setTab("news")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm transition-colors",
            tab === "news" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Newspaper className="h-4 w-4" />
          {t("marketNews")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "calendar"}
          onClick={() => setTab("calendar")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm transition-colors",
            tab === "calendar" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <CalendarDays className="h-4 w-4" />
          {t("economicCalendar")}
        </button>
      </div>

      {/* Market news feed */}
      <div className={tab === "news" ? "" : "hidden"}>
        <MarketNewsPanel />
      </div>

      {/* Economic calendar widget (always mounted, hidden when inactive) */}
      <div className={tab === "calendar" ? "" : "hidden"}>
        <Card className="overflow-hidden border-border/60 bg-card/80 shadow-2xl">
          <CardHeader className="flex flex-col items-start justify-between gap-3 border-b border-border/50 px-3 py-3 sm:flex-row sm:items-center sm:px-6">
            <div className="min-w-0"><h2 className="font-display text-lg font-semibold">{t("economicCalendar")}</h2><p className="mt-0.5 text-xs text-muted-foreground">{t("calendarWidgetInstructions")}</p></div>
            <a href="https://www.mql5.com/en/economic-calendar" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">{t("openSource")}<ArrowUpRight className="h-3.5 w-3.5" /></a>
          </CardHeader>
          <CardContent className="p-0">
            <div className="calendar-widget-shell overflow-hidden bg-background/40 p-1.5 sm:p-4">
              <div ref={setContainerRef} className="calendar-widget-frame w-full">
                <div id="economicCalendarWidget" />
                <div className="ecw-copyright"><a href="https://www.metatrader.com/?utm_source=calendar.widget&utm_medium=link&utm_term=economic.calendar&utm_content=visit.mql5.calendar&utm_campaign=202.calendar.widget" rel="noopener nofollow" target="_blank">MetaTrader World Markets</a></div>
              </div>
            </div>
          </CardContent>
        </Card>
        <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">{t("calendarDataDisclaimer")}</p>
      </div>
    </div>
  );
}
