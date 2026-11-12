/**
 * CalendarPanel — economic calendar + market news, powered by the EXISTING
 * /api/news endpoint (ForexFactory weekly calendar + Google News per symbol,
 * with server-side translation). Impact filter: high / medium / low.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flame, Newspaper, ExternalLink } from "lucide-react";
import { authedFetch } from "@/lib/api";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

interface CalEvent { title?: string; name?: string; country?: string; currency?: string; time?: number; date?: string; impact?: string; forecast?: string | number; previous?: string | number; actual?: string | number }
interface NewsItem { title: string; link?: string; url?: string; source?: string }

export function CalendarPanel({ symbol, className }: { symbol: string; className?: string }) {
  const { t, language } = useLanguage();
  const [tab, setTab] = useState<"calendar" | "news">("calendar");
  const [impact, setImpact] = useState<"all" | "high" | "medium">("all");

  const { data, isLoading } = useQuery({
    queryKey: ["terminalNews", symbol, language],
    queryFn: async () => authedFetch(`/api/news?lang=${language === "ar" ? "ar" : language}&limit=20`),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });

  const events: CalEvent[] = ((data?.calendar as CalEvent[]) || []).filter((e) => {
    const imp = String(e.impact || "").toLowerCase();
    if (impact === "high") return imp === "high";
    if (impact === "medium") return imp === "high" || imp === "medium";
    return true;
  });
  const news: NewsItem[] = (data?.items as NewsItem[]) || [];

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 p-1.5">
        <button onClick={() => setTab("calendar")} className={cn("flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold", tab === "calendar" ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground")}>
          {t("econCalendar")}
        </button>
        <button onClick={() => setTab("news")} className={cn("flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold", tab === "news" ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground")}>
          {t("news")}
        </button>
      </div>

      {tab === "calendar" && (
        <>
          <div className="flex shrink-0 gap-1 p-1.5">
            {(["all", "medium", "high"] as const).map((f) => (
              <button key={f} onClick={() => setImpact(f)} className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize", impact === f ? "border-emerald-500/50 text-emerald-400" : "border-border/60 text-muted-foreground")}>
                {f}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {isLoading && <div className="py-6 text-center text-muted-foreground">…</div>}
            {!isLoading && !events.length && <div className="py-6 text-center text-muted-foreground">{t("noEvents")}</div>}
            {events.map((e, i) => {
              const imp = String(e.impact || "").toLowerCase();
              return (
                <div key={i} className="rounded-lg border border-border/50 bg-card/50 p-2 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    {imp === "high" && <Flame className="h-3 w-3 text-red-400" />}
                    <span className="font-semibold text-foreground">{e.currency || e.country}</span>
                    <span className="text-muted-foreground">{e.time ? new Date(e.time).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : (e.date || "")}</span>
                    <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold uppercase", imp === "high" ? "bg-red-500/15 text-red-400" : imp === "medium" ? "bg-amber-500/15 text-amber-400" : "bg-muted text-muted-foreground")}>{e.impact || "low"}</span>
                  </div>
                  <div className="mt-0.5 text-foreground">{e.title || e.name}</div>
                  <div className="mt-0.5 flex gap-3 text-[10px] text-muted-foreground">
                    {e.forecast != null && <span>F: {String(e.forecast)}</span>}
                    {e.previous != null && <span>P: {String(e.previous)}</span>}
                    {e.actual != null && <span className="font-semibold text-emerald-400">A: {String(e.actual)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {tab === "news" && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {isLoading && <div className="py-6 text-center text-muted-foreground">…</div>}
          {news.map((n, i) => (
            <a
              key={i}
              href={n.link || n.url || "#"}
              target="_blank"
              rel="noreferrer"
              className="flex items-start gap-2 rounded-lg border border-border/50 bg-card/50 p-2 text-[11px] hover:border-emerald-500/40"
            >
              <Newspaper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-foreground">{n.title}</div>
                {n.source && <div className="mt-0.5 text-[10px] text-muted-foreground">{n.source}</div>}
              </div>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
