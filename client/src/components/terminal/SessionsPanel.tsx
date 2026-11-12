/**
 * SessionsPanel — trading session analyzer: current session, countdown to the
 * next open/close, session OHLC/range and average range, plus chart overlay
 * toggles (session boxes, previous day/week high-low). Session windows are
 * DST-correct via the Intl timezone database; display timezone is selectable.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import type { Timeframe } from "@shared/terminal";
import { loadBarsCached } from "@/lib/terminal/data-feeds";
import { SESSIONS, sessionStats, avgSessionRange, nextSessionChange, sessionBoundsUTC, wallTime, TIMEZONES, getSession } from "@/lib/terminal/sessions";
import { sessionActiveNow, SESSION_COLORS, type OverlayConfig } from "@/lib/terminal/chart-overlay";
import { Stat } from "./ToolDrawer";
import { cn } from "@/lib/utils";

export function SessionsPanel({ symbol, timeframe, overlay, setOverlay }: {
  symbol: string;
  timeframe: Timeframe;
  overlay: OverlayConfig;
  setOverlay: (o: OverlayConfig) => void;
}) {
  const [tz, setTz] = useState<string>(() => localStorage.getItem("terminalTz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  useEffect(() => { localStorage.setItem("terminalTz", tz); }, [tz]);

  const barsQ = useQuery({
    queryKey: ["sessionBars", symbol, timeframe],
    queryFn: () => loadBarsCached(symbol, "30m" as Timeframe, 1000),
    staleTime: 60_000,
  });
  const bars = barsQ.data ?? [];

  // re-render every 15s for the countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const nowSec = Date.now() / 1000;
  const next = useMemo(() => nextSessionChange(nowSec), [nowSec]);
  const minutesLeft = Math.max(0, Math.round((next.nextChangeUTC - nowSec) / 60));

  const toggleSession = (id: string) => {
    const sessions = overlay.sessions.includes(id) ? overlay.sessions.filter((s) => s !== id) : [...overlay.sessions, id];
    setOverlay({ ...overlay, sessions });
  };

  return (
    <div className="space-y-3 text-[11px]">
      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-bold"><Clock className="h-3.5 w-3.5 text-emerald-400" />Current session</div>
          <select value={tz} onChange={(e) => setTz(e.target.value)} className="num-input h-6 w-36 text-[10px]" aria-label="Display timezone">
            {[...new Set([tz, ...TIMEZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className={cn("rounded px-2 py-0.5 text-xs font-bold", next.current ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground")}>
            {next.current?.label ?? "Off-session"}
          </span>
          <span className="text-muted-foreground">
            {next.current ? "closes" : "opens"} in <b className="font-number text-foreground">{Math.floor(minutesLeft / 60)}h {minutesLeft % 60}m</b> ({next.next.label})
          </span>
        </div>
      </section>

      <section className="space-y-1.5">
        {SESSIONS.map((s) => {
          const activeNow = sessionActiveNow(s.id);
          const b = sessionBoundsUTC(s, nowSec);
          const st = bars.length ? sessionStats(bars, s, nowSec) : null;
          const avg = bars.length ? avgSessionRange(bars, s, 10) : 0;
          const on = overlay.sessions.includes(s.id);
          const color = SESSION_COLORS[s.id] ?? "148,163,184";
          return (
            <div key={s.id} className={cn("rounded-xl border p-2.5", activeNow ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/50 bg-card/40")}>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: `rgb(${color})`, opacity: activeNow ? 1 : 0.4 }} />
                <b>{s.label}</b>
                {activeNow && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-400">OPEN</span>}
                <span className="ml-auto font-number text-muted-foreground">
                  {b ? `${wallTime(b.openUTC, tz)} – ${wallTime(b.closeUTC, tz)} (${tz.split("/")[1] ?? tz})` : `${s.open}–${s.close} ${s.tz.split("/")[1]}`}
                </span>
                <button onClick={() => toggleSession(s.id)}
                  className={cn("rounded border px-1.5 py-0.5 text-[9px] font-bold", on ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}
                  title="Draw this session box on the chart">
                  {on ? "ON CHART" : "SHOW"}
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                <Stat label="High" value={st ? st.high.toFixed(st.high > 100 ? 1 : 4) : "—"} />
                <Stat label="Low" value={st ? st.low.toFixed(st.low > 100 ? 1 : 4) : "—"} />
                <Stat label="Range" value={st ? st.range.toFixed(st.range > 100 ? 1 : 4) : "—"} />
                <Stat label="Avg range (10d)" value={avg ? avg.toFixed(avg > 100 ? 1 : 4) : "—"} />
              </div>
            </div>
          );
        })}
      </section>

      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Chart overlay levels</div>
        <div className="flex flex-wrap gap-1.5">
          {([
            ["day", "Prev day H/L"],
            ["week", "Prev week H/L"],
          ] as const).map(([key, label]) => (
            <button key={key}
              onClick={() => setOverlay({ ...overlay, prevLevels: { ...overlay.prevLevels, [key]: !overlay.prevLevels[key] } })}
              className={cn("rounded-lg border px-2 py-1 text-[10px] font-semibold", (overlay.prevLevels as any)[key] ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
          <span className="text-[9px] text-muted-foreground">Levels are computed from real bars of {symbol}.</span>
        </div>
      </section>
      <p className="text-[9px] text-muted-foreground">Session windows follow each market's local clock (DST handled automatically). Session stats use the last 10 days of real {symbol} bars.</p>
    </div>
  );
}

// keep getSession referenced for consumers that import it from here
export { getSession };
