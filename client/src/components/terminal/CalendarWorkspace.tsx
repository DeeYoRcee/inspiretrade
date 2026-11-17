/**
 * CalendarWorkspace — the terminal's "Calendar" mode (Phase 5).
 *
 * Four sub-tabs:
 *   Calendar — upcoming events (all impact levels) with filters, search,
 *              countdowns and per-row custom alerts (bell).
 *   History  — released events of the loaded ranges with actual-vs-forecast
 *              surprise markers (data the mirror has already published).
 *   Sessions — live Sydney/Tokyo/London/New York dashboard (SessionsBoard).
 *   Alerts   — alert configuration (AlertsPanel).
 *
 * Event detail: an AI-generated explanatory analysis, clearly labeled, for
 * common release types. No synthetic events, no fabricated numbers —
 * everything shown comes from the ForexFactory mirror via /api/news.
 */
import { useEffect, useMemo, useState } from "react";
import { Bell, BellRing, CalendarDays, ChevronDown, History, Info, LineChart, Loader2, RefreshCw, Search, Settings2, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEconCalendar, useEconEvents, useEventWarning, useEconWarnSettings, type EconRange } from "@/hooks/use-terminal-econ";
import { addEventAlert, loadEventAlerts, removeEventAlert, type EventAlert } from "@/lib/notifications";
import { eventKnowledge, type CalEventFull, type Impact } from "@shared/econ";
import { fmtCountdown } from "@shared/sessions";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import SessionsBoard from "./SessionsBoard";
import AlertsPanel from "./AlertsPanel";

const IMPACTS: Impact[] = ["High", "Medium", "Low", "Holiday"];

const IMPACT_STYLE: Record<Impact, string> = {
  High: "border-red-500/50 bg-red-500/10 text-red-300",
  Medium: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  Low: "border-slate-600/60 bg-slate-800/60 text-slate-300",
  Holiday: "border-violet-500/50 bg-violet-500/10 text-violet-300",
};

const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function useTicker(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** calendar | history | sessions | alerts — controlled so other modes can deep-link */
export type CalendarTab = "calendar" | "history" | "sessions" | "alerts";

export default function CalendarWorkspace({ initialTab = "calendar", symbol }: { initialTab?: CalendarTab; symbol?: string }) {
  const [tab, setTab] = useState<CalendarTab>(initialTab);
  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(
          [
            ["calendar", "Calendar", <CalendarDays key="i" className="h-3.5 w-3.5" />],
            ["history", "History", <History key="i" className="h-3.5 w-3.5" />],
            ["sessions", "Sessions", <LineChart key="i" className="h-3.5 w-3.5" />],
            ["alerts", "Alerts", <BellRing key="i" className="h-3.5 w-3.5" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            onClick={() => setTab(id as CalendarTab)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors",
              tab === id ? "border-sky-600 bg-sky-600/20 text-sky-200" : "border-slate-700/70 text-slate-400 hover:text-slate-200",
            )}
          >
            {icon} {label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-slate-500">Source: ForexFactory (nfs.faireconomy.media) · times shown in your timezone</span>
      </div>
      {tab === "calendar" && <CalendarTabPane symbol={symbol} />}
      {tab === "history" && <HistoryTabPane />}
      {tab === "sessions" && <SessionsBoard />}
      {tab === "alerts" && <AlertsPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// shared event table
// ---------------------------------------------------------------------------

function ImpactChip({ impact }: { impact: Impact }) {
  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide", IMPACT_STYLE[impact])}>
      {impact}
    </span>
  );
}

function EventRow({
  ev, now, onOpen, onBell,
}: {
  ev: CalEventFull;
  now: number;
  onOpen: () => void;
  onBell: () => void;
}) {
  const future = ev.date > now;
  const countdown = future ? `in ${fmtCountdown(ev.date - now)}` : "";
  const surprise =
    ev.actual && ev.forecast
      ? (() => {
          const a = parseFloat(ev.actual.replace(/[^0-9.\-]/g, ""));
          const f = parseFloat(ev.forecast.replace(/[^0-9.\-]/g, ""));
          if (Number.isNaN(a) || Number.isNaN(f)) return null;
          return a > f ? "above" : a < f ? "below" : "inline";
        })()
      : null;
  return (
    <tr
      onClick={onOpen}
      className={cn(
        "cursor-pointer border-b border-slate-800/70 transition-colors hover:bg-slate-800/40",
        ev.impact === "High" && "bg-red-950/20",
      )}
    >
      <td className="whitespace-nowrap px-2 py-1.5 text-slate-300">{timeFmt.format(ev.date)}</td>
      <td className="whitespace-nowrap px-2 py-1.5">
        {future ? (
          <span className="text-xs font-semibold tabular-nums text-sky-300">{countdown}</span>
        ) : surprise ? (
          <span className={cn("text-xs font-semibold", surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-slate-400")}>
            {surprise === "above" ? "▲" : surprise === "below" ? "▼" : "="} released
          </span>
        ) : (
          <span className="text-[10px] text-slate-500">released</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-200">
        {ev.flag} {ev.currency}
      </td>
      <td className="px-2 py-1.5 text-slate-200">
        <span className="flex items-center gap-1.5">
          {ev.title}
          {ev.impact === "High" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" title="High impact" />}
        </span>
      </td>
      <td className="px-2 py-1.5"><ImpactChip impact={ev.impact} /></td>
      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-400">{ev.previous || "—"}</td>
      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-300">{ev.forecast || "—"}</td>
      <td className={cn("whitespace-nowrap px-2 py-1.5 tabular-nums font-semibold", surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-slate-300")}>
        {ev.actual || "—"}
      </td>
      <td className="px-1 py-1.5 text-right">
        <Button
          size="icon" variant="ghost" title="Set a custom alert for this event"
          className="h-6 w-6 text-slate-500 hover:text-amber-300"
          onClick={(e) => { e.stopPropagation(); onBell(); }}
        >
          <Bell className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  );
}

function FilterBar({
  search, onSearch,
  currencies, activeCurrencies, onToggleCurrency,
  activeImpacts, onToggleImpact,
}: {
  search: string; onSearch: (v: string) => void;
  currencies: string[]; activeCurrencies: Set<string>; onToggleCurrency: (c: string) => void;
  activeImpacts: Set<Impact>; onToggleImpact: (i: Impact) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search events…" className="h-8 w-44 border-slate-700 bg-slate-950 pl-7 text-xs" />
      </div>
      <div className="flex items-center gap-1">
        {IMPACTS.map((i) => (
          <button
            key={i}
            onClick={() => onToggleImpact(i)}
            className={cn("rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-opacity", IMPACT_STYLE[i], activeImpacts.has(i) ? "opacity-100" : "opacity-35")}
            title={`Show ${i} impact events`}
          >
            {i}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {currencies.map((c) => (
          <button
            key={c}
            onClick={() => onToggleCurrency(c)}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
              activeCurrencies.has(c) ? "border-sky-500/60 bg-sky-600/20 text-sky-200" : "border-slate-700/70 text-slate-400 hover:text-slate-200",
            )}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function EventTable({
  rows, now, onOpen, onBell, emptyText,
}: {
  rows: CalEventFull[];
  now: number;
  onOpen: (ev: CalEventFull) => void;
  onBell: (ev: CalEventFull) => void;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500">{emptyText}</div>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-800">
      <table className="w-full min-w-[760px] border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
          <tr className="text-[10px] uppercase tracking-wide text-slate-500">
            <th className="px-2 py-2 font-semibold">Time (local)</th>
            <th className="px-2 py-2 font-semibold">Countdown</th>
            <th className="px-2 py-2 font-semibold">Country</th>
            <th className="px-2 py-2 font-semibold">Event</th>
            <th className="px-2 py-2 font-semibold">Impact</th>
            <th className="px-2 py-2 font-semibold">Previous</th>
            <th className="px-2 py-2 font-semibold">Forecast</th>
            <th className="px-2 py-2 font-semibold">Actual</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((ev) => (
            <EventRow key={ev.id} ev={ev} now={now} onOpen={() => onOpen(ev)} onBell={() => onBell(ev)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar tab
// ---------------------------------------------------------------------------

function CalendarTabPane({ symbol }: { symbol?: string }) {
  const [range, setRange] = useState<EconRange>("thisweek");
  const query = useEconCalendar(range);
  const warn = useEventWarning(symbol ?? "");
  const { settings } = useEconWarnSettings();
  const now = useTicker(1000);
  const [search, setSearch] = useState("");
  const [impacts, setImpacts] = useState<Set<Impact>>(() => new Set(["High", "Medium"]));
  const [currencies, setCurrencies] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<CalEventFull | null>(null);

  const allEvents = query.data?.events ?? [];
  const currenciesList = useMemo(() => [...new Set(allEvents.map((e) => e.currency))].sort(), [allEvents]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allEvents.filter((e) => {
      if (!impacts.has(e.impact)) return false;
      if (currencies.size > 0 && !currencies.has(e.currency)) return false;
      if (q && !e.title.toLowerCase().includes(q) && !e.currency.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allEvents, impacts, currencies, search]);

  const nextHigh = allEvents.find((e) => e.impact === "High" && e.date > now) ?? null;
  const loading = query.isLoading;

  const toggleImpact = (i: Impact) => setImpacts((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const toggleCurrency = (c: string) => setCurrencies((prev) => { const n = new Set(prev); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  const bell = (ev: CalEventFull) => {
    addEventAlert({ eventId: ev.id, title: ev.title, currency: ev.currency, date: ev.date, minutesBefore: 30 });
    toast({ title: `Alert set — ${ev.currency}`, description: `${ev.title} · 30 min before release` });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {/* header: next high-impact countdown + warning + range + refresh */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
        <div className="text-xs">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Next high-impact event</span>
          <div className="flex items-center gap-2 font-semibold text-slate-100">
            {nextHigh ? (
              <>
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
                <span>{nextHigh.flag} {nextHigh.currency} — {nextHigh.title}</span>
                <span className="rounded bg-sky-600/20 px-1.5 py-0.5 text-xs font-bold tabular-nums text-sky-300">
                  {fmtCountdown(nextHigh.date - now)}
                </span>
              </>
            ) : loading ? (
              <span className="flex items-center gap-2 text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> loading…</span>
            ) : (
              <span className="text-slate-500">none scheduled in this range</span>
            )}
          </div>
        </div>
        {warn && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-300">
            ⚠ Major {warn.currency} event in {warn.minutesUntil} min — {warn.title}
            {settings.confirmTrades ? " · order confirmations active" : ""}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {(["thisweek", "nextweek", "thismonth"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                range === r ? "border-sky-600 bg-sky-600/20 text-sky-200" : "border-slate-700/70 text-slate-400 hover:text-slate-200",
              )}
            >
              {r === "thisweek" ? "This week" : r === "nextweek" ? "Next week" : "This month"}
            </button>
          ))}
          <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => void query.refetch()} title="Refresh calendar">
            <RefreshCw className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {query.data?.stale && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
          The calendar source is rate-limiting right now — showing the last successfully fetched data.
        </div>
      )}

      {query.data?.limited && query.data?.note && (
        <div className="rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-400">
          <Info className="mr-1 inline h-3 w-3 text-slate-500" />
          {query.data.note}
        </div>
      )}

      <FilterBar
        search={search} onSearch={setSearch}
        currencies={currenciesList} activeCurrencies={currencies} onToggleCurrency={toggleCurrency}
        activeImpacts={impacts} onToggleImpact={toggleImpact}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading real economic calendar…</div>
      ) : !query.data?.ok ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-300">
          The calendar source is unavailable right now (rate limit or network). Nothing is shown rather than guessing — try Refresh in a few minutes.
        </div>
      ) : (
        <EventTable
          rows={rows} now={now} onOpen={setDetail} onBell={bell}
          emptyText={
            query.data?.limited && range === "nextweek"
              ? "Next week's schedule isn't published by the free upstream yet — it appears when ForexFactory rolls the calendar on Sunday."
              : "No events match the current filters."
          }
        />
      )}

      <EventDetailDialog ev={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

function HistoryTabPane() {
  const { events, loading, stale, updatedAt } = useEconEvents();
  const now = useTicker(30000);
  const [search, setSearch] = useState("");
  const [impacts, setImpacts] = useState<Set<Impact>>(() => new Set(["High", "Medium"]));
  const [currencies, setCurrencies] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<CalEventFull | null>(null);

  const currenciesList = useMemo(() => [...new Set(events.map((e) => e.currency))].sort(), [events]);
  const past = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events
      .filter((e) => e.date <= now)
      .filter((e) => {
        if (!impacts.has(e.impact)) return false;
        if (currencies.size > 0 && !currencies.has(e.currency)) return false;
        if (q && !e.title.toLowerCase().includes(q) && !e.currency.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => b.date - a.date)
      .slice(0, 300);
  }, [events, impacts, currencies, search, now]);

  const toggleImpact = (i: Impact) => setImpacts((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const toggleCurrency = (c: string) => setCurrencies((prev) => { const n = new Set(prev); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
        <span className="font-semibold text-slate-200">Released events — current week & month ranges</span>
        <span className="text-[10px] text-slate-500">
          Updated {updatedAt ? timeFmt.format(updatedAt) : "—"}{stale ? " · cached copy" : ""}
        </span>
        <span className="ml-auto text-[10px] text-slate-500">
          The mirror publishes forecast & previous; "Actual" fills in only when the upstream provides it.
        </span>
      </div>
      <FilterBar
        search={search} onSearch={setSearch}
        currencies={currenciesList} activeCurrencies={currencies} onToggleCurrency={toggleCurrency}
        activeImpacts={impacts} onToggleImpact={toggleImpact}
      />
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading history…</div>
      ) : (
        <EventTable rows={past} now={now} onOpen={setDetail} onBell={() => {}} emptyText="No released events in the loaded ranges yet — history accumulates as weeks pass." />
      )}
      <EventDetailDialog ev={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// event detail dialog + AI analysis
// ---------------------------------------------------------------------------

function ValueLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", tone ?? "text-slate-200")}>{value || "—"}</span>
    </div>
  );
}

function EventDetailDialog({ ev, onClose }: { ev: CalEventFull | null; onClose: () => void }) {
  const [existing, setExisting] = useState<EventAlert[]>([]);
  useEffect(() => {
    if (ev) setExisting(loadEventAlerts().filter((a) => a.eventId === ev.id));
  }, [ev]);
  if (!ev) return null;
  const knowledge = eventKnowledge(ev.title);
  const surprise =
    ev.actual && ev.forecast
      ? (() => {
          const a = parseFloat(ev.actual.replace(/[^0-9.\-]/g, ""));
          const f = parseFloat(ev.forecast.replace(/[^0-9.\-]/g, ""));
          if (Number.isNaN(a) || Number.isNaN(f)) return null;
          return a > f ? "above" : a < f ? "below" : "inline";
        })()
      : null;

  return (
    <Dialog open={!!ev} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto border-slate-700 bg-slate-900 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {ev.flag} {ev.currency} — {ev.title} <ImpactChip impact={ev.impact} />
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400">
            {ev.country} · {timeFmt.format(ev.date)} (your timezone) · {clockFmt.format(ev.date)} UTC equivalent via Intl conversion
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <ValueLine label="Previous" value={ev.previous} />
          <ValueLine label="Forecast" value={ev.forecast} />
          <ValueLine
            label="Actual"
            value={ev.actual}
            tone={surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-slate-200"}
          />
        </div>
        {ev.actual && (
          <p className="text-xs text-slate-400">
            {surprise === "above" && "Actual came in above the forecast — markets usually read this as bullish for the currency (rates up)."}
            {surprise === "below" && "Actual came in below the forecast — markets usually read this as bearish for the currency (rates down)."}
            {surprise === "inline" && "Actual matched the forecast — the reaction usually depends on the details inside the report."}
          </p>
        )}

        {knowledge ? (
          <div className="space-y-3 rounded-lg border border-sky-800/60 bg-sky-950/30 p-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-sky-300">
              <Info className="h-3.5 w-3.5" /> AI-generated analysis — informational only, not a prediction or financial advice
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">What this event is</div>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-300">{knowledge.what}</p>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Instruments that may react</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {knowledge.affects.map((a) => (
                  <span key={a} className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-300">{a}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Why it matters to traders</div>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-300">{knowledge.why}</p>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Historical behaviour</div>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-300">{knowledge.historical}</p>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
            No analysis pattern is available for this event type yet — the values above are factual; interpret the reaction with your own framework.
          </p>
        )}

        <div className="rounded-lg border border-slate-800 p-3">
          <div className="mb-2 text-xs font-semibold text-slate-200">Custom alert</div>
          {existing.length > 0 ? (
            <div className="space-y-1.5">
              {existing.map((a) => (
                <div key={a.id} className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                  <BellRing className="h-3.5 w-3.5" />
                  <span>{a.minutesBefore} min before — {timeFmt.format(new Date(a.date - a.minutesBefore * 60000))}</span>
                  <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => { removeEventAlert(a.id); setExisting(loadEventAlerts().filter((x) => x.eventId === ev.id)); }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {[15, 30, 60].map((m) => (
                <Button
                  key={m} size="sm" variant="outline" className="h-7 text-[11px]"
                  onClick={() => {
                    addEventAlert({ eventId: ev.id, title: ev.title, currency: ev.currency, date: ev.date, minutesBefore: m });
                    setExisting(loadEventAlerts().filter((x) => x.eventId === ev.id));
                    toast({ title: `Alert set — ${ev.currency}`, description: `${ev.title} · ${m} min before` });
                  }}
                >
                  <Bell className="mr-1 h-3 w-3" /> {m} min before
                </Button>
              ))}
              <span className="text-[10px] text-slate-500">Fires a toast + browser notification (if enabled) while the site is open.</span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
