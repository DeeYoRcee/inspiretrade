/**
 * EventStrip — Phase 5 terminal integration row (live & replay modes).
 *
 * One slim strip above the chart: the next HIGH-impact event for the
 * selected symbol's currencies with a live countdown, an amber warning state
 * inside the user's configurable warning window, two relevant headlines for
 * the instrument, and the warning settings (warn minutes + OPTIONAL order
 * confirmation). Trades are never blocked automatically — the confirmation
 * gate only activates when the user turns it on.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronDown, ExternalLink, Loader2, Settings2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEventWarning, useEconWarnSettings, useNextSymbolEvents, useRelevantNews } from "@/hooks/use-terminal-econ";
import { fmtCountdown } from "@shared/sessions";
import { cn } from "@/lib/utils";

export default function EventStrip({ symbol, onOpenCalendar }: { symbol: string; onOpenCalendar: () => void }) {
  const { nextHigh, loading } = useNextSymbolEvents(symbol, ["High"]);
  const warn = useEventWarning(symbol);
  const { settings, update } = useEconWarnSettings();
  const news = useRelevantNews(symbol, 2);
  const [now, setNow] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-2.5 py-1.5 text-xs",
        warn ? "border-amber-500/50 bg-amber-500/10" : "border-slate-800 bg-slate-900/60",
      )}
    >
      {warn && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />}
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
        <CalendarDays className="h-3.5 w-3.5" /> Events
      </span>

      {loading ? (
        <span className="flex items-center gap-1.5 text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> loading calendar…</span>
      ) : nextHigh ? (
        <span className="flex items-center gap-2 font-semibold text-slate-200">
          <span>{nextHigh.flag} {nextHigh.currency}</span>
          <span className="truncate max-w-[280px] text-slate-300">{nextHigh.title}</span>
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums", warn ? "bg-amber-500/20 text-amber-300" : "bg-sky-600/20 text-sky-300")}>
            {fmtCountdown(nextHigh.date - now)}
          </span>
          {warn && <span className="text-[10px] font-bold uppercase text-amber-300">major event — expect volatility</span>}
        </span>
      ) : (
        <span className="text-slate-500">No upcoming high-impact events for {symbol}</span>
      )}

      <span className="hidden items-center gap-2 lg:flex">
        {news.items.map((n) => (
          <a
            key={n.link}
            href={n.link}
            target="_blank"
            rel="noopener noreferrer"
            title={`${n.source} — ${n.title}`}
            className="flex max-w-[220px] items-center gap-1 truncate rounded border border-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-sky-600/60 hover:text-sky-300"
          >
            <ExternalLink className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{n.title}</span>
          </a>
        ))}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onOpenCalendar}
          className="rounded-md border border-slate-700/70 px-2 py-0.5 text-[11px] font-semibold text-slate-300 hover:border-sky-600/60 hover:text-sky-300"
          title="Open the full economic calendar"
        >
          Full calendar
        </button>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setSettingsOpen(true)} title="Event warning settings">
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md border-slate-700 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle className="text-base">Event warning settings</DialogTitle>
            <DialogDescription className="text-xs">
              The strip highlights high-impact releases for {symbol}'s currencies. Orders are never
              blocked automatically — the extra confirmation step only appears if you turn it on.
            </DialogDescription>
          </DialogHeader>
          <div>
            <div className="text-xs font-semibold text-slate-200">Warn minutes before the event</div>
            <div className="mt-2 flex gap-1.5">
              {[5, 10, 15, 30, 60].map((m) => (
                <button
                  key={m}
                  onClick={() => update({ warnMinutes: m })}
                  className={cn(
                    "flex-1 rounded border px-2 py-1.5 text-[11px] font-bold tabular-nums transition-colors",
                    settings.warnMinutes === m ? "border-sky-500/60 bg-sky-600/20 text-sky-200" : "border-slate-700/70 text-slate-400 hover:text-slate-200",
                  )}
                >
                  {m}m
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => update({ confirmTrades: !settings.confirmTrades })}
            className="flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-left"
          >
            <span className={cn("flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors", settings.confirmTrades ? "bg-sky-600" : "bg-slate-700")}>
              <span className={cn("h-4 w-4 rounded-full bg-white transition-transform", settings.confirmTrades && "translate-x-4")} />
            </span>
            <span>
              <span className="block text-xs font-semibold text-slate-200">Confirm orders inside the warning window</span>
              <span className="block text-[10px] text-slate-500">Off by default — placing trades stays one click.</span>
            </span>
          </button>
          <p className="text-[10px] leading-relaxed text-slate-500">
            <ChevronDown className="mr-1 inline h-3 w-3" />
            More detail in the Calendar mode: filters, history, sessions and per-event alerts.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
