import { useEffect, useRef } from "react";
import { ArrowUpRight, CalendarDays, Clock3, Globe2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useLanguage } from "@/lib/language-context";

const CALENDAR_WIDGET_CONFIG = {
  width: "100%",
  height: "100%",
  mode: 2,
  fw: "react",
  lang: "en",
  theme: 2,
};

export default function NewsPage() {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://www.tradays.com/c/js/widgets/calendar/widget.js?v=15";
    script.type = "text/javascript";
    script.async = true;
    script.dataset.type = "calendar-widget";
    script.innerHTML = JSON.stringify(CALENDAR_WIDGET_CONFIG);

    const container = containerRef.current;
    container?.appendChild(script);

    return () => {
      script.remove();
      const widgetFrame = container?.querySelector("iframe");
      widgetFrame?.remove();
      const calendarIds = (window as Window & { calendarCompletedID?: string[] }).calendarCompletedID;
      const registeredCalendarIndex = calendarIds?.indexOf("economicCalendarWidget") ?? -1;
      if (registeredCalendarIndex >= 0) {
        calendarIds?.splice(registeredCalendarIndex, 1);
      }
    };
  }, []);

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-5 shadow-lg sm:p-7">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
              {t("macroPulseLive")}
            </div>
            <h1 className="flex items-center gap-3 text-3xl font-display font-bold text-gradient sm:text-4xl">
              <CalendarDays className="h-8 w-8 text-primary" />
              {t("macroPulse")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
              {t("macroPulseDescription")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs sm:min-w-64 sm:text-sm">
            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/50 px-3 py-2.5">
              <Globe2 className="h-4 w-4 shrink-0 text-primary" />
              <span>{t("mql5CalendarSource")}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/50 px-3 py-2.5">
              <Clock3 className="h-4 w-4 shrink-0 text-primary" />
              <span>{t("calendarTimeManaged")}</span>
            </div>
          </div>
        </div>
      </div>

      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-2xl">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/50 px-4 py-3 sm:px-6">
          <div>
            <h2 className="font-display text-lg font-semibold">{t("economicCalendar")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("calendarWidgetInstructions")}</p>
          </div>
          <a
            href="https://www.mql5.com/en/economic-calendar"
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {t("openSource")}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </CardHeader>
        <CardContent className="p-0">
          <div className="min-h-[720px] overflow-hidden bg-[#111318] p-2 sm:min-h-[860px] sm:p-4">
            <div ref={containerRef} className="h-[760px] w-full sm:h-[900px]">
              <div id="economicCalendarWidget" />
              <div className="ecw-copyright">
                <a
                  href="https://www.metatrader.com/?utm_source=calendar.widget&utm_medium=link&utm_term=economic.calendar&utm_content=visit.mql5.calendar&utm_campaign=202.calendar.widget"
                  rel="noopener nofollow"
                  target="_blank"
                >
                  MetaTrader World Markets
                </a>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
        {t("calendarDataDisclaimer")}
      </p>
    </div>
  );
}
