/**
 * NewsWorkspace — the terminal's "News" mode (Phase 5).
 *
 * Reuses the app-wide /api/news aggregator (real RSS: Investing, ForexLive,
 * CNBC, Yahoo Finance, Cointelegraph, Google News search feeds) and the
 * existing in-app article reader. Every item carries its original source and
 * publication time; links always go to the original publisher. Nothing is
 * generated — when a feed is down, its stories simply disappear.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fetchNews } from "@/lib/news-api";
import { useLanguage } from "@/lib/language-context";
import { newsCategories, NEWS_CATEGORIES, type NewsCategory } from "@shared/econ";
import { SYMBOL_COLOR } from "@/lib/news-api";
import { ArticleDialog } from "@/components/news/ArticleDialog";
import type { NewsItem } from "@/lib/news-api";
import { cn } from "@/lib/utils";

function relTime(ts: number, now: number): string {
  const m = Math.max(1, Math.round((now - ts) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const absFmt = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export default function NewsWorkspace() {
  const { language } = useLanguage();
  const [category, setCategory] = useState<NewsCategory>("All");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<NewsItem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // minute ticker for the relative timestamps + "updated X ago" chip
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["marketNews", language],
    queryFn: () => fetchNews(language),
    staleTime: 40 * 1000,
    refetchInterval: 5 * 60 * 1000, // auto-refresh when new articles are available
    retry: 1,
  });

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? [])
      .map((item) => ({ item, cats: newsCategories(item) }))
      .filter(({ item, cats }) => {
        if (category !== "All" && !cats.includes(category)) return false;
        if (q && !item.title.toLowerCase().includes(q) && !(item.summary ?? "").toLowerCase().includes(q)) return false;
        return true;
      })
      .slice(0, 200);
  }, [data, category, search]);

  const updatedAt = data?.updatedAt ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      {/* header: categories + search + refresh + attribution */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {NEWS_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                category === c ? "border-sky-600 bg-sky-600/20 text-sky-200" : "border-slate-700/70 text-slate-400 hover:text-slate-200",
              )}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search headlines…" className="h-8 w-48 border-slate-700 bg-slate-950 pl-7 text-xs" />
        </div>
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => void refetch()} title="Refresh news">
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span>
          Sources: Investing · ForexLive · CNBC · Yahoo Finance · Cointelegraph · Google News — every story links to its original publisher.
        </span>
        {updatedAt > 0 && (
          <span className="flex items-center gap-1 text-emerald-400/80">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Updated {relTime(updatedAt, now)} · auto-refresh 5 min
          </span>
        )}
        <span className="ml-auto">{items.length} stories</span>
      </div>

      {/* feed */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-xs text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading live market news…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-xs text-slate-500">
            No stories match this filter right now. Feeds are polled every few minutes — try another category or refresh.
          </div>
        ) : (
          <div className="space-y-1.5">
            {items.map(({ item, cats }) => (
              <article
                key={item.link}
                className="group rounded-lg border border-slate-800 bg-slate-900/50 p-2.5 transition-colors hover:border-slate-700 hover:bg-slate-900"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
                  <span className="font-semibold text-slate-300">{item.source}</span>
                  <span className="text-slate-500">· {relTime(item.publishedAt, now)}</span>
                  <span className="text-slate-500">· {absFmt.format(item.publishedAt)}</span>
                  {item.symbols.slice(0, 3).map((s) => (
                    <span key={s} className="rounded px-1 font-bold" style={{ background: `${SYMBOL_COLOR[s] ?? "#64748b"}22`, color: SYMBOL_COLOR[s] ?? "#94a3b8" }}>
                      {s}
                    </span>
                  ))}
                  <span className="ml-auto flex gap-1">
                    {cats.map((c) => (
                      <span key={c} className="rounded border border-slate-700/70 px-1 text-slate-500">{c}</span>
                    ))}
                  </span>
                </div>
                <h3 className="mt-1 text-sm font-semibold leading-snug text-slate-100">
                  <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:text-sky-300 hover:underline">
                    {item.title} <ExternalLink className="inline h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
                  </a>
                </h3>
                {item.summary && <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{item.summary}</p>}
                <div className="mt-1.5 flex items-center gap-2">
                  {item.fullText && (
                    <button
                      onClick={() => setOpen(item)}
                      className="rounded-md border border-sky-700/60 bg-sky-600/10 px-2 py-0.5 text-[11px] font-semibold text-sky-300 hover:bg-sky-600/20"
                    >
                      Read in app
                    </button>
                  )}
                  <a href={item.link} target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:text-slate-300">
                    Open original ↗
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <ArticleDialog item={open} onClose={() => setOpen(null)} />
    </div>
  );
}
