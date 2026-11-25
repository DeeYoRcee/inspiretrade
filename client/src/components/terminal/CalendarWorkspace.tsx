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
const CAL_IMPACTS_KEY = "it-cal-impacts";
const CAL_CURRENCIES_KEY = "it-cal-currencies";

const IMPACT_STYLE: Record<Impact, string> = {
  High: "border-red-500/50 bg-red-500/10 text-red-300",
  Medium: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  Low: "border-border/70 bg-secondary/60 text-foreground/80",
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
              tab === id ? "border-primary bg-primary/20 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground/90",
            )}
          >
            {icon} {label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">Source: ForexFactory (nfs.faireconomy.media) · times shown in your timezone</span>
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

/** P63R — phone-only event card: the 760px-wide desktop table (kept for md+)
 *  became an inner horizontal scroller on phones; the card list below is the
 *  mobile layout for the SAME data (terminal Calendar mode AND the /news
 *  calendar tab — both mount this workspace). */
function PhoneEventCard({
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
    <button
      onClick={onOpen}
      className={cn(
        "block w-full rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 text-left transition-colors active:bg-secondary/40",
        ev.impact === "High" && "border-red-900/60 bg-red-950/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="whitespace-nowrap text-xs font-semibold text-foreground/80">{timeFmt.format(ev.date)}</span>
        <span className="flex min-w-0 items-center gap-2">
          {future ? (
            <span className="whitespace-nowrap text-xs font-semibold tabular-nums text-primary">{countdown}</span>
          ) : surprise ? (
            <span className={cn("whitespace-nowrap text-xs font-semibold", surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-muted-foreground")}>
              {surprise === "above" ? "▲" : surprise === "below" ? "▼" : "="} released
            </span>
          ) : (
            <span className="whitespace-nowrap text-[10px] text-muted-foreground">released</span>
          )}
          <ImpactChip impact={ev.impact} />
          <span
            role="button" tabIndex={0}
            title="Set a custom alert for this event"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-amber-300 active:bg-secondary/40"
            onClick={(e) => { e.stopPropagation(); onBell(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onBell(); } }}
          >
            <Bell className="h-3.5 w-3.5" />
          </span>
        </span>
      </div>
      <div className="mt-1 flex items-start gap-1.5">
        <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-foreground/90">{ev.flag} {ev.currency}</span>
        <span className="min-w-0 text-[13px] leading-tight text-foreground/90">
          {ev.title}
          {ev.impact === "High" && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-400" />}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
        <div><p className="text-[9px] uppercase tracking-wide text-muted-foreground">Prev</p><p className="tabular-nums text-muted-foreground">{ev.previous || "—"}</p></div>
        <div><p className="text-[9px] uppercase tracking-wide text-muted-foreground">Forecast</p><p className="tabular-nums text-foreground/80">{ev.forecast || "—"}</p></div>
        <div>
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Actual</p>
          <p className={cn("tabular-nums font-semibold", surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-foreground/80")}>{ev.actual || "—"}</p>
        </div>
      </div>
    </button>
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
        "cursor-pointer border-b border-border/70 transition-colors hover:bg-secondary/40",
        ev.impact === "High" && "bg-red-950/20",
      )}
    >
      <td className="whitespace-nowrap px-2 py-1.5 text-foreground/80">{timeFmt.format(ev.date)}</td>
      <td className="whitespace-nowrap px-2 py-1.5">
        {future ? (
          <span className="text-xs font-semibold tabular-nums text-primary">{countdown}</span>
        ) : surprise ? (
          <span className={cn("text-xs font-semibold", surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-muted-foreground")}>
            {surprise === "above" ? "▲" : surprise === "below" ? "▼" : "="} released
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">released</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-foreground/90">
        {ev.flag} {ev.currency}
      </td>
      <td className="px-2 py-1.5 text-foreground/90">
        <span className="flex items-center gap-1.5">
          {ev.title}
          {ev.impact === "High" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" title="High impact" />}
        </span>
      </td>
      <td className="px-2 py-1.5"><ImpactChip impact={ev.impact} /></td>
      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground">{ev.previous || "—"}</td>
      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-foreground/80">{ev.forecast || "—"}</td>
      <td className={cn("whitespace-nowrap px-2 py-1.5 tabular-nums font-semibold", surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-foreground/80")}>
        {ev.actual || "—"}
      </td>
      <td className="px-1 py-1.5 text-right">
        <Button
          size="icon" variant="ghost" title="Set a custom alert for this event"
          className="h-6 w-6 text-muted-foreground hover:text-amber-300"
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
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search events…" className="cal-panel h-9 w-44 max-w-full border-border bg-background pl-7 text-xs sm:h-8" />
      </div>
      <div className="flex items-center gap-1">
        {IMPACTS.map((i) => (
          <button
            key={i}
            onClick={() => onToggleImpact(i)}
            className={cn("rounded border px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide transition-opacity sm:px-1.5 sm:py-0.5 sm:text-[10px]", IMPACT_STYLE[i], activeImpacts.has(i) ? "opacity-100" : "opacity-35")}
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
              "rounded border px-2.5 py-1.5 text-[11px] font-semibold transition-colors sm:px-1.5 sm:py-0.5 sm:text-[10px]",
              activeCurrencies.has(c) ? "border-primary/70 bg-primary/20 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground/90",
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
    return <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">{emptyText}</div>;
  }
  return (
    <>
    {/* desktop: the original table (md+ only — phones get the card list) */}
    <div className="cal-panel hidden min-h-0 overflow-auto rounded-lg border border-border md:block md:flex-1">
      <table className="w-full min-w-[760px] border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
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
    {/* phone: compact event cards, one per row, full width — no inner
        horizontal scrolling */}
    <div className="cal-panel min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-border p-2 md:hidden">
      {rows.map((ev) => (
        <PhoneEventCard key={ev.id} ev={ev} now={now} onOpen={() => onOpen(ev)} onBell={() => onBell(ev)} />
      ))}
    </div>
    </>
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
  // impact / currency filters persist across visits (localStorage): picking
  // "High" only and coming back later must NOT resurrect Medium/Low rows
  const [impacts, setImpacts] = useState<Set<Impact>>(() => {
    try {
      const raw = localStorage.getItem(CAL_IMPACTS_KEY);
      if (raw) {
        const list = JSON.parse(raw) as Impact[];
        const valid = list.filter((x) => IMPACTS.includes(x));
        if (valid.length) return new Set(valid);
      }
    } catch { /* corrupted store — fall through to defaults */ }
    return new Set(["High", "Medium"]);
  });
  const [currencies, setCurrencies] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(CAL_CURRENCIES_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* corrupted store — defaults */ }
    return new Set();
  });
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

  const toggleImpact = (i: Impact) => setImpacts((prev) => {
    const n = new Set(prev);
    if (n.has(i)) n.delete(i); else n.add(i);
    // never allow an empty filter (all off = nothing would ever render)
    const store = n.size ? [...n] : [...IMPACTS];
    try { localStorage.setItem(CAL_IMPACTS_KEY, JSON.stringify(store)); } catch { /* private mode */ }
    return n.size ? n : new Set(IMPACTS);
  });
  const toggleCurrency = (c: string) => setCurrencies((prev) => {
    const n = new Set(prev);
    if (n.has(c)) n.delete(c); else n.add(c);
    try { localStorage.setItem(CAL_CURRENCIES_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });

  const bell = (ev: CalEventFull) => {
    addEventAlert({ eventId: ev.id, title: ev.title, currency: ev.currency, date: ev.date, minutesBefore: 30 });
    toast({ title: `Alert set — ${ev.currency}`, description: `${ev.title} · 30 min before release` });
  };

  return (
    <div className="cal-root flex min-h-0 flex-1 flex-col gap-2.5">
      {/* header: next high-impact countdown + warning + range + refresh */}
      <div className="cal-panel flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card/70 px-3 py-2">
        <div className="text-xs">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Next high-impact event</span>
          <div className="flex items-center gap-2 font-semibold text-foreground">
            {nextHigh ? (
              <>
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
                <span>{nextHigh.flag} {nextHigh.currency} — {nextHigh.title}</span>
                <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs font-bold tabular-nums text-primary">
                  {fmtCountdown(nextHigh.date - now)}
                </span>
              </>
            ) : loading ? (
              <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> loading…</span>
            ) : (
              <span className="text-muted-foreground">none scheduled in this range</span>
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
                "rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors sm:px-2 sm:py-1 sm:text-[11px]",
                range === r ? "border-primary bg-primary/20 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground/90",
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
        <div className="rounded-md border border-border bg-card/70 px-2 py-1 text-[11px] text-muted-foreground">
          <Info className="mr-1 inline h-3 w-3 text-muted-foreground" />
          {query.data.note}
        </div>
      )}

      <FilterBar
        search={search} onSearch={setSearch}
        currencies={currenciesList} activeCurrencies={currencies} onToggleCurrency={toggleCurrency}
        activeImpacts={impacts} onToggleImpact={toggleImpact}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading real economic calendar…</div>
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
  // impact / currency filters persist across visits (localStorage): picking
  // "High" only and coming back later must NOT resurrect Medium/Low rows
  const [impacts, setImpacts] = useState<Set<Impact>>(() => {
    try {
      const raw = localStorage.getItem(CAL_IMPACTS_KEY);
      if (raw) {
        const list = JSON.parse(raw) as Impact[];
        const valid = list.filter((x) => IMPACTS.includes(x));
        if (valid.length) return new Set(valid);
      }
    } catch { /* corrupted store — fall through to defaults */ }
    return new Set(["High", "Medium"]);
  });
  const [currencies, setCurrencies] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(CAL_CURRENCIES_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* corrupted store — defaults */ }
    return new Set();
  });
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

  const toggleImpact = (i: Impact) => setImpacts((prev) => {
    const n = new Set(prev);
    if (n.has(i)) n.delete(i); else n.add(i);
    // never allow an empty filter (all off = nothing would ever render)
    const store = n.size ? [...n] : [...IMPACTS];
    try { localStorage.setItem(CAL_IMPACTS_KEY, JSON.stringify(store)); } catch { /* private mode */ }
    return n.size ? n : new Set(IMPACTS);
  });
  const toggleCurrency = (c: string) => setCurrencies((prev) => {
    const n = new Set(prev);
    if (n.has(c)) n.delete(c); else n.add(c);
    try { localStorage.setItem(CAL_CURRENCIES_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card/70 px-3 py-2 text-xs">
        <span className="font-semibold text-foreground/90">Released events — current week & month ranges</span>
        <span className="text-[10px] text-muted-foreground">
          Updated {updatedAt ? timeFmt.format(updatedAt) : "—"}{stale ? " · cached copy" : ""}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          The mirror publishes forecast & previous; "Actual" fills in only when the upstream provides it.
        </span>
      </div>
      <FilterBar
        search={search} onSearch={setSearch}
        currencies={currenciesList} activeCurrencies={currencies} onToggleCurrency={toggleCurrency}
        activeImpacts={impacts} onToggleImpact={toggleImpact}
      />
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading history…</div>
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
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", tone ?? "text-foreground/90")}>{value || "—"}</span>
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
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto border-border bg-card text-foreground">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {ev.flag} {ev.currency} — {ev.title} <ImpactChip impact={ev.impact} />
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {ev.country} · {timeFmt.format(ev.date)} (your timezone) · {clockFmt.format(ev.date)} UTC equivalent via Intl conversion
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-background/60 p-3">
          <ValueLine label="Previous" value={ev.previous} />
          <ValueLine label="Forecast" value={ev.forecast} />
          <ValueLine
            label="Actual"
            value={ev.actual}
            tone={surprise === "above" ? "text-emerald-400" : surprise === "below" ? "text-red-400" : "text-foreground/90"}
          />
        </div>
        {ev.actual && (
          <p className="text-xs text-muted-foreground">
            {surprise === "above" && "Actual came in above the forecast — markets usually read this as bullish for the currency (rates up)."}
            {surprise === "below" && "Actual came in below the forecast — markets usually read this as bearish for the currency (rates down)."}
            {surprise === "inline" && "Actual matched the forecast — the reaction usually depends on the details inside the report."}
          </p>
        )}

        {knowledge ? (
          <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/10 p-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-primary">
              <Info className="h-3.5 w-3.5" /> AI-generated analysis — informational only, not a prediction or financial advice
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">What this event is</div>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground/80">{knowledge.what}</p>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Instruments that may react</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {knowledge.affects.map((a) => (
                  <span key={a} className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-foreground/80">{a}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Why it matters to traders</div>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground/80">{knowledge.why}</p>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Historical behaviour</div>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground/80">{knowledge.historical}</p>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-background/60 p-3 text-xs text-muted-foreground">
            No analysis pattern is available for this event type yet — the values above are factual; interpret the reaction with your own framework.
          </p>
        )}

        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-semibold text-foreground/90">Custom alert</div>
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
              <span className="text-[10px] text-muted-foreground">Fires a toast + browser notification (if enabled) while the site is open.</span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
