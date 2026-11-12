/**
 * ReplayToolbar — the professional replay control deck (§2/§13).
 * Play/Pause/Stop, next/previous, fast-forward/rewind (±10), jump to a
 * date+time, 8 playback speeds, candle-by-candle mode, a progress timeline
 * with trade markers and seek, keyboard hints, save/resume and the exit.
 * Keyboard: Space=play/pause, ←/→=step, ↑/↓=speed (bound in TerminalPage).
 */
import { useMemo, useState } from "react";
import {
  Play, Pause, Square, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Save, FolderOpen, Trash2, Keyboard, Gauge,
} from "lucide-react";
import { SPEEDS, type ReplaySession, type SavedReplaySession } from "@/hooks/use-replay";
import { SESSIONS, isInSession, sessionStats } from "@/lib/terminal/sessions";
import { SESSION_COLORS } from "@/lib/terminal/chart-overlay";
import { cn } from "@/lib/utils";

const fmt = (t: number) => new Date(t * 1000).toLocaleString([], {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export function ReplayToolbar({ rs, onOpenStats }: { rs: ReplaySession; onOpenStats: () => void }) {
  const [showKeys, setShowKeys] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [jumpValue, setJumpValue] = useState("");
  const [startPct, setStartPct] = useState(70);

  const { bars, cursorIdx, cursorBar, active, playing } = rs;
  const progress = bars.length > 1 ? (cursorIdx / (bars.length - 1)) * 100 : 0;

  // sessions open at the cursor instant (§12)
  const cursorSessions = cursorBar
    ? SESSIONS.filter((s) => isInSession(s, cursorBar.time))
    : [];

  const tradeMarks = useMemo(
    () => rs.markers.filter((m) => m.kind === "entry").map((m) => {
      const idx = bars.findIndex((b) => b.time === m.time);
      return idx >= 0 ? { idx, side: m.side } : null;
    }).filter((x): x is { idx: number; side: "buy" | "sell" } => !!x),
    [rs.markers, bars],
  );

  const jump = () => {
    const d = new Date(jumpValue);
    if (!Number.isNaN(d.getTime())) rs.seekToTime(Math.floor(d.getTime() / 1000));
  };

  return (
    <div className="rounded-xl border border-sky-500/30 bg-[#0d1420]/95 shadow-xl backdrop-blur">
      {/* start strip (before a session is running) */}
      {!active && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-2.5 py-2 text-[11px]">
          <span className="text-muted-foreground">Start at</span>
          <input type="range" min={5} max={98} value={startPct} onChange={(e) => setStartPct(Number(e.target.value))} className="h-1.5 w-48 accent-sky-500" />
          <span className="font-number w-28 text-muted-foreground">
            {bars.length ? fmt(bars[Math.floor((bars.length - 1) * startPct / 100)]?.time ?? 0) : "loading…"}
          </span>
          <button
            onClick={() => rs.start(Math.floor((bars.length - 1) * startPct / 100))}
            disabled={rs.loading || bars.length < 50}
            className="flex items-center gap-1.5 rounded-lg bg-sky-500/25 px-3 py-1.5 text-[11px] font-black text-sky-300 hover:bg-sky-500/35 disabled:opacity-40">
            <Play className="h-3.5 w-3.5" />{rs.loading ? "Loading history…" : `START REPLAY (${bars.length} real bars)`}
          </button>
          {rs.historyError && <span className="text-red-400">{rs.historyError.message}</span>}
        </div>
      )}

      {/* row 1 — controls */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 text-[11px]">
        <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[10px] font-black tracking-wider text-sky-400">REPLAY · SIMULATED</span>
        <button onClick={() => rs.stepBack(10)} disabled={!active} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-30" title="Rewind 10 (review only — account not rewound)">
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => rs.stepBack(1)} disabled={!active} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-30" title="Previous candle (←)">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => rs.setPlaying(!playing)} disabled={!active} className={cn("flex h-7 w-8 items-center justify-center rounded-lg font-bold disabled:opacity-30", playing ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400")} title={playing ? "Pause (Space)" : "Play (Space)"}>
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => rs.stepForward(1)} disabled={!active} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-30" title="Next candle (→)">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => rs.stepForward(10)} disabled={!active} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-30" title="Fast forward 10">
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => rs.setCandleMode(!rs.candleMode)} className={cn("rounded-lg border px-2 py-1 text-[10px] font-bold", rs.candleMode ? "border-sky-500/50 bg-sky-500/15 text-sky-400" : "border-border/60 text-muted-foreground hover:text-foreground")} title="Pause after every candle">
          <Gauge className="mr-0.5 inline h-3 w-3" />CANDLE×1
        </button>
        <select value={rs.speedIdx} onChange={(e) => rs.setSpeedIdx(Number(e.target.value))} disabled={!active} className="num-input h-7 w-16 disabled:opacity-40" title="Playback speed (↑/↓)">
          {SPEEDS.map((s, i) => <option key={s.ms} value={i}>{s.label}</option>)}
        </select>

        <div className="mx-1 h-5 w-px bg-border/60" />

        {/* jump to date+time */}
        <input type="datetime-local" value={jumpValue} onChange={(e) => setJumpValue(e.target.value)}
          className="num-input h-7 w-52" title="Jump to date & time" />
        <button onClick={jump} disabled={!active || !jumpValue} className="h-7 rounded-lg border border-border/60 px-2 text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30">JUMP</button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-number text-[10px] text-muted-foreground">{cursorBar ? fmt(cursorBar.time) : "—"} · bar {cursorIdx + 1}/{bars.length}</span>
          <button onClick={() => setShowKeys((v) => !v)} className={cn("flex h-7 w-7 items-center justify-center rounded-lg border", showKeys ? "border-sky-500/50 text-sky-400" : "border-border/60 text-muted-foreground hover:text-foreground")} title="Keyboard shortcuts">
            <Keyboard className="h-3.5 w-3.5" />
          </button>
          <button onClick={onOpenStats} className="h-7 rounded-lg border border-emerald-500/40 px-2 text-[10px] font-bold text-emerald-400 hover:bg-emerald-500/10">STATS</button>
          <button onClick={() => setShowSessions((v) => !v)} className="flex h-7 items-center gap-1 rounded-lg border border-border/60 px-2 text-[10px] font-bold text-muted-foreground hover:text-foreground" title="Save / resume sessions">
            <FolderOpen className="h-3 w-3" />{rs.sessions.length}
          </button>
          <button onClick={() => rs.stop()} className="flex h-7 items-center gap-1 rounded-lg border border-red-500/40 px-2 text-[10px] font-bold text-red-400 hover:bg-red-500/10" title="Exit replay">
            <Square className="h-3 w-3" />EXIT
          </button>
        </div>
      </div>

      {/* row 2 — timeline */}
      <div className="relative px-2.5 pb-2.5">
        <div className="relative h-6 rounded-lg border border-border/50 bg-card/50">
          <div className="absolute inset-y-0 left-0 rounded-l-lg bg-sky-500/20" style={{ width: `${progress}%` }} />
          <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${progress}%` }} />
          {tradeMarks.map((m, i) => (
            <div key={i} className={cn("absolute top-1/2 h-2 w-2 -translate-y-1/2 rotate-45", m.side === "buy" ? "bg-emerald-400" : "bg-red-400")}
              style={{ left: `calc(${(m.idx / Math.max(1, bars.length - 1)) * 100}% - 4px)` }} title={`${m.side} @ ${fmt(bars[m.idx].time)}`} />
          ))}
          <input type="range" min={0} max={Math.max(0, bars.length - 1)} value={cursorIdx} disabled={!active}
            onChange={(e) => rs.seekToIdx(Number(e.target.value))}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="Replay timeline" />
        </div>
        {rs.notice && (
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
            <span className="truncate text-sky-300">{rs.notice}</span>
            <button onClick={() => rs.setNotice(null)} className="text-muted-foreground hover:text-foreground">✕</button>
          </div>
        )}
        {/* historical session chips at the cursor (§12) */}
        {active && cursorBar && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px]">
            <span className="text-muted-foreground">Sessions open at cursor:</span>
            {cursorSessions.length === 0 && <span className="text-muted-foreground">none (off-session)</span>}
            {cursorSessions.map((s) => {
              const st = sessionStats(bars, s, cursorBar.time);
              return (
                <span key={s.id} className="rounded px-1.5 py-0.5 font-bold" style={{ background: `rgba(${SESSION_COLORS[s.id] ?? "148,163,184"},0.15)`, color: `rgb(${SESSION_COLORS[s.id] ?? "148,163,184"})` }}>
                  {s.label}{st ? ` · H ${st.high.toFixed(st.high > 100 ? 1 : 4)} L ${st.low.toFixed(st.low > 100 ? 1 : 4)}` : ""}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* keyboard helper */}
      {showKeys && (
        <div className="border-t border-border/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">
          <b className="text-foreground">Shortcuts:</b> Space = Play/Pause · → = Next candle · ← = Previous · ↑ = Faster · ↓ = Slower
        </div>
      )}

      {/* sessions drawer */}
      {showSessions && (
        <div className="border-t border-border/40 px-2.5 py-2">
          <div className="flex gap-1.5">
            <input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="Session name…" className="num-input h-7 flex-1" />
            <button onClick={async () => { await rs.saveSession(sessionName); setSessionName(""); }}
              disabled={!active}
              className="flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 px-2 text-[10px] font-bold text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40">
              <Save className="h-3 w-3" />Save
            </button>
          </div>
          <div className="mt-1.5 max-h-32 space-y-1 overflow-y-auto">
            {!rs.sessions.length && <div className="py-2 text-center text-[10px] text-muted-foreground">No saved sessions yet.</div>}
            {rs.sessions.map((s: SavedReplaySession) => (
              <div key={s.id} className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2 py-1 text-[10px]">
                <b className="truncate">{s.name}</b>
                <span className="text-muted-foreground">{s.symbol} {s.timeframe} · {s.state.closed.length} trades</span>
                <span className={cn("font-number", s.state.balance >= s.cfg.startingBalance ? "text-emerald-400" : "text-red-400")}>
                  {s.state.balance >= s.cfg.startingBalance ? "+" : ""}{(s.state.balance - s.cfg.startingBalance).toFixed(0)}
                </span>
                <button onClick={() => { rs.resumeSession(s); setShowSessions(false); }} className="ml-auto rounded border border-sky-500/40 px-1.5 py-0.5 font-bold text-sky-400 hover:bg-sky-500/10">Resume</button>
                <button onClick={() => rs.deleteSession(s.id)} className="text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">Resume restores the exact timestamp, balance, open positions and pending orders. Drawings &amp; indicators reload automatically per instrument.</p>
        </div>
      )}
    </div>
  );
}
