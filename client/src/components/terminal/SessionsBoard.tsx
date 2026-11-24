/**
 * SessionsBoard — live market session dashboard (Phase 5, "Sessions" tab).
 *
 * Sydney / Tokyo / London / New York with DST-correct open-close windows
 * (shared/sessions.ts), per-session open-close countdowns, overlap chips,
 * the London/New York flagship-overlap banner and a 24-hour timeline strip.
 */
import { Clock, Globe2, Zap } from "lucide-react";
import { useMarketSessions } from "@/hooks/use-terminal-econ";
import { fmtCountdown } from "@shared/sessions";
import { cn } from "@/lib/utils";

const SESSION_ACCENT: Record<string, { bar: string; dot: string; text: string }> = {
  sydney: { bar: "bg-sky-500/70", dot: "bg-sky-400", text: "text-primary" },
  tokyo: { bar: "bg-rose-500/70", dot: "bg-rose-400", text: "text-rose-300" },
  london: { bar: "bg-amber-500/70", dot: "bg-amber-400", text: "text-amber-300" },
  newyork: { bar: "bg-emerald-500/70", dot: "bg-emerald-400", text: "text-emerald-300" },
};

const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

export default function SessionsBoard() {
  const snap = useMarketSessions();
  const { now, states, overlaps, openCount, activity, windows } = snap;
  const flagship = overlaps.find((o) => o.flagship);
  const windowOf = (id: string) => windows.find((w) => w.id === id);
  const overlapNames = overlaps.map((o) => `${nameOf(o.a)} × ${nameOf(o.b)}`);

  function nameOf(id: string): string {
    return states.find((s) => s.def.id === id)?.def.city ?? id;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      {/* activity + overlap summary */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card/70 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <Globe2 className="h-4 w-4 text-primary" />
          <span className="font-semibold text-foreground">{activity.label}</span>
          <span className="text-muted-foreground">· {openCount}/4 sessions open</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-foreground/80">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          Your timezone: <span className="font-semibold">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        </div>
        {flagship ? (
          <div className="ml-auto flex items-center gap-2 rounded-md border border-amber-400/60 bg-amber-500/15 px-2.5 py-1.5 text-xs font-bold text-amber-300">
            <Zap className="h-4 w-4 animate-pulse" /> LONDON × NEW YORK OVERLAP — peak liquidity window
          </div>
        ) : (
          overlapNames.length > 0 && (
            <div className="ml-auto rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 text-xs text-foreground/80">
              Overlap: {overlapNames.join(" · ")}
            </div>
          )
        )}
      </div>

      {/* session cards */}
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {states.map((s) => {
          const accent = SESSION_ACCENT[s.def.id] ?? SESSION_ACCENT.sydney;
          const w = windowOf(s.def.id);
          const isOpen = s.open;
          return (
            <div
              key={s.def.id}
              className={cn(
                "rounded-lg border p-3 transition-colors",
                isOpen ? "border-emerald-600/40 bg-emerald-950/20" : "border-border bg-card/70",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg leading-none">{s.def.flag}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground">{s.def.city}</div>
                  <div className="text-[10px] text-muted-foreground">{s.def.tz}</div>
                </div>
                <span
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                    isOpen ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-border/70 bg-secondary text-muted-foreground",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", isOpen ? cn("animate-pulse", accent.dot) : "bg-secondary")} />
                  {isOpen ? "Open" : "Closed"}
                </span>
              </div>
              <div className="mt-2 space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{isOpen ? "Closes in" : "Opens in"}</span>
                  <span className={cn("font-bold tabular-nums", isOpen ? accent.text : "text-foreground/80")}>
                    {fmtCountdown(Math.max(0, s.nextAt - now))}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Local window</span>
                  <span className="tabular-nums text-foreground/80">
                    {`${String(Math.floor(s.def.openMin / 60)).padStart(2, "0")}:${String(s.def.openMin % 60).padStart(2, "0")}`}–{`${String(Math.floor(s.def.closeMin / 60)).padStart(2, "0")}:${String(s.def.closeMin % 60).padStart(2, "0")}`}
                  </span>
                </div>
                {w && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{isOpen ? "Opened" : "Next open"}</span>
                    <span className="tabular-nums text-foreground/80">{hourFmt.format(w.start)}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 24h timeline */}
      <div className="rounded-lg border border-border bg-card/70 p-3">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Next 24 hours — session windows (your timezone)</span>
          <span>{hourFmt.format(now)} → {hourFmt.format(now + 86400000)}</span>
        </div>
        <div className="relative h-9 overflow-hidden rounded-md border border-border bg-background">
          {/* 6h gridlines */}
          {[25, 50, 75].map((p) => (
            <div key={p} className="absolute top-0 h-full w-px bg-secondary" style={{ left: `${p}%` }} />
          ))}
          {windows.map((w) => {
            const left = ((w.start - now) / 86400000) * 100;
            const width = ((w.end - w.start) / 86400000) * 100;
            if (width <= 0) return null;
            return (
              <div
                key={w.id}
                className={cn("absolute top-1 h-7 rounded-sm", SESSION_ACCENT[w.id]?.bar ?? "bg-sky-500/70")}
                style={{ left: `${Math.max(0, left)}%`, width: `${Math.min(100, width)}%` }}
                title={`${nameOf(w.id)}: ${hourFmt.format(w.start)} – ${hourFmt.format(w.end)}`}
              >
                <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-black/80">
                  {nameOf(w.id)}
                </span>
              </div>
            );
          })}
          {/* now marker */}
          <div className="absolute top-0 h-full w-0.5 bg-white/70" style={{ left: 0 }} />
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-muted-foreground/70">
          <span>now</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+24h</span>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Windows follow each city's LOCAL trading day (07:00-16:00 Sydney, 09:00-18:00 Tokyo, 08:00-17:00
        London & New York, Monday-Friday) and shift automatically with daylight-saving changes handled by
        the IANA timezone database. FX trading is decentralized — exchanges' cash sessions differ slightly.
      </p>
    </div>
  );
}
