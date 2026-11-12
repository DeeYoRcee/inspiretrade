/**
 * ReplayPanel — professional bar-replay system. Loads REAL historical bars
 * (same feed/cache as the chart), hides everything after a chosen start bar
 * and reveals candles step by step. Includes play/pause/step controls,
 * adjustable speed, simulated replay trades (kept SEPARATE from the demo
 * account) and per-session performance stats, saveable to Firebase.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, StepBack, StepForward, Flag, Save, Trash2, X } from "lucide-react";
import { ref, get, set, remove } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import { getInstrument, type Bar, type Timeframe } from "@shared/terminal";
import { loadBarsCached } from "@/lib/terminal/data-feeds";
import { pipValue } from "@/lib/terminal/calculators";
import { Stat, Sparkline } from "./ToolDrawer";
import { cn } from "@/lib/utils";

export interface ReplayState { active: boolean; visibleBars: number; }

interface ReplayTrade {
  id: string; side: "long" | "short"; entry: number; lots: number;
  sl: number | null; tp: number | null; entryTime: number;
  exit?: number; exitTime?: number; pnl?: number; reason?: "sl" | "tp" | "manual" | "end";
}

interface SavedSession {
  id: string; symbol: string; timeframe: string; savedAt: number;
  startBarTime: number; endBarTime: number;
  trades: ReplayTrade[];
  stats: { total: number; wins: number; netPnl: number; winRate: number };
}

const SPEEDS = [
  { label: "0.5×", ms: 2000 },
  { label: "1×", ms: 1000 },
  { label: "2×", ms: 500 },
  { label: "5×", ms: 200 },
  { label: "10×", ms: 100 },
];

export function ReplayPanel({ symbol, timeframe, replay, setReplay }: {
  symbol: string;
  timeframe: Timeframe;
  replay: ReplayState | null;
  setReplay: React.Dispatch<React.SetStateAction<ReplayState | null>>;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [startIdx, setStartIdx] = useState("");
  const [speedMs, setSpeedMs] = useState(1000);
  const [playing, setPlaying] = useState(false);
  const [trades, setTrades] = useState<ReplayTrade[]>([]);
  const [lots, setLots] = useState(0.1);
  const [slPips, setSlPips] = useState(50);
  const [tpPips, setTpPips] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const barsQ = useQuery({
    queryKey: ["replayBars", symbol, timeframe],
    queryFn: () => loadBarsCached(symbol, timeframe, 1000),
    staleTime: 60_000,
  });
  const bars: Bar[] = barsQ.data ?? [];

  const active = !!replay?.active;
  const visible = replay?.visibleBars ?? 0;
  const inst = getInstrument(symbol);
  const digits = inst?.digits ?? 2;

  const currentBar = active ? bars[visible - 1] : undefined;

  // ---- playback -------------------------------------------------------------
  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!playing || !active) return;
    timerRef.current = setInterval(() => {
      setReplay((prev) => (prev && prev.active && prev.visibleBars < bars.length
        ? { active: true, visibleBars: prev.visibleBars + 1 }
        : prev));
    }, speedMs);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [playing, active, speedMs, bars.length, setReplay]);

  useEffect(() => {
    if (active && replay && replay.visibleBars >= bars.length) stopTimer();
  }, [active, replay, bars.length, stopTimer]);

  // evaluate open replay trades against each newly revealed bar
  useEffect(() => {
    if (!active || !currentBar) return;
    setTrades((list) => list.map((t) => {
      if (t.exit != null) return t;
      const hitSL = t.sl != null && (t.side === "long" ? currentBar.low <= t.sl : currentBar.high >= t.sl);
      const hitTP = t.tp != null && (t.side === "long" ? currentBar.high >= t.tp : currentBar.low <= t.tp);
      if (hitSL || hitTP) {
        const exit = hitSL ? t.sl! : t.tp!;
        return { ...t, exit, exitTime: currentBar.time, reason: hitSL ? "sl" as const : "tp" as const, pnl: replayPnl(t, exit, symbol) };
      }
      return t;
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active]);

  // ---- actions --------------------------------------------------------------
  const startReplay = () => {
    const idx = Math.max(30, Math.min(bars.length - 1, Number(startIdx) || Math.floor(bars.length * 0.7)));
    if (bars.length < 60) { setError("Not enough history loaded"); return; }
    setTrades([]);
    setError(null);
    stopTimer();
    setReplay({ active: true, visibleBars: idx + 1 });
  };

  const exitReplay = () => {
    stopTimer();
    setReplay(null);
    setPlaying(false);
  };

  const openTrade = (side: "long" | "short") => {
    if (!currentBar) return;
    const entry = currentBar.close;
    const pip = inst?.pipSize ?? 0.0001;
    setTrades((l) => [...l, {
      id: Math.random().toString(36).slice(2, 9), side, entry, lots,
      sl: slPips > 0 ? (side === "long" ? entry - slPips * pip : entry + slPips * pip) : null,
      tp: tpPips > 0 ? (side === "long" ? entry + tpPips * pip : entry - tpPips * pip) : null,
      entryTime: currentBar.time,
    }]);
  };

  const closeTrade = (t: ReplayTrade) => {
    if (!currentBar) return;
    setTrades((l) => l.map((x) => x.id === t.id ? { ...x, exit: currentBar.close, exitTime: currentBar.time, reason: "manual" as const, pnl: replayPnl(x, currentBar.close, symbol) } : x));
  };

  // ---- stats ----------------------------------------------------------------
  const closed = trades.filter((t) => t.exit != null);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const netPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const curve = useMemo(() => {
    let eq = 0;
    return [0, ...closed.map((t) => (eq += t.pnl ?? 0))];
  }, [closed]);

  // ---- saved sessions ---------------------------------------------------------
  const sessionsQ = useQuery({
    queryKey: ["replaySessions", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<SavedSession[]> => {
      const snap = await get(ref(db, `terminalReplay/${user!.uid}`));
      return snap.exists() ? Object.values<SavedSession>(snap.val()).sort((a, b) => b.savedAt - a.savedAt) : [];
    },
  });

  const saveSession = async () => {
    if (!user || !active || !currentBar) return;
    const startBar = bars[Math.max(0, visible - 1)];
    const rec: SavedSession = {
      id: Math.random().toString(36).slice(2, 12),
      symbol, timeframe, savedAt: Date.now(),
      startBarTime: bars[Math.max(0, Number(startIdx) ? Math.max(30, Number(startIdx)) : Math.floor(bars.length * 0.7))]?.time ?? startBar.time,
      endBarTime: currentBar.time,
      trades: JSON.parse(JSON.stringify(trades)),
      stats: {
        total: closed.length, wins: wins.length,
        netPnl: Math.round(netPnl * 100) / 100,
        winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
      },
    };
    await set(ref(db, `terminalReplay/${user.uid}/${rec.id}`), rec);
    qc.invalidateQueries({ queryKey: ["replaySessions", user.uid] });
  };

  const deleteSession = async (id: string) => {
    if (!user) return;
    await remove(ref(db, `terminalReplay/${user.uid}/${id}`));
    qc.invalidateQueries({ queryKey: ["replaySessions", user.uid] });
  };

  const fmtTime = (t: number) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-xl border border-sky-500/30 bg-[#0d1420]/95 shadow-xl backdrop-blur">
      {/* control bar */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 text-[11px]">
        <span className="flex items-center gap-1 font-bold text-sky-400"><Flag className="h-3.5 w-3.5" />Replay</span>
        {!active ? (
          <>
            <select value={startIdx} onChange={(e) => setStartIdx(e.target.value)} className="num-input h-7 w-44" aria-label="Start bar">
              <option value="">Start at ~70% ({Math.floor(bars.length * 0.7)} of {bars.length})</option>
              {bars.length > 0 && Array.from({ length: Math.min(200, Math.max(0, bars.length - 30)) }, (_, i) => {
                const idx = bars.length - 1 - i * Math.max(1, Math.floor(bars.length / 200));
                return <option key={idx} value={idx}>{fmtTime(bars[idx].time)} · bar {idx}</option>;
              })}
            </select>
            <button onClick={startReplay} disabled={barsQ.isLoading || !bars.length} className="flex h-7 items-center gap-1 rounded-lg bg-sky-500/20 px-2.5 font-bold text-sky-400 hover:bg-sky-500/30 disabled:opacity-40">
              <Play className="h-3 w-3" />Start
            </button>
            {error && <span className="text-red-400">{error}</span>}
          </>
        ) : (
          <>
            <button onClick={() => (playing ? stopTimer() : setPlaying(true))} className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400 hover:bg-sky-500/30" title={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => setReplay({ active: true, visibleBars: Math.max(31, visible - 1) })} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground" title="Step back">
              <StepBack className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setReplay({ active: true, visibleBars: Math.min(bars.length, visible + 1) })} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground" title="Step forward">
              <StepForward className="h-3.5 w-3.5" />
            </button>
            <select value={speedMs} onChange={(e) => setSpeedMs(Number(e.target.value))} className="num-input h-7 w-16" aria-label="Replay speed">
              {SPEEDS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
            </select>
            <span className="font-number text-muted-foreground">{visible}/{bars.length} · {currentBar ? fmtTime(currentBar.time) : ""}</span>
            <button onClick={saveSession} className="flex h-7 items-center gap-1 rounded-lg border border-border/60 px-2 text-muted-foreground hover:text-foreground" title="Save replay session"><Save className="h-3 w-3" />Save</button>
            <button onClick={exitReplay} className="flex h-7 items-center gap-1 rounded-lg border border-red-500/40 px-2 text-red-400 hover:bg-red-500/10" title="Exit replay"><X className="h-3 w-3" />Exit</button>
          </>
        )}
      </div>

      {/* replay trading + stats */}
      {active && (
        <div className="border-t border-border/40 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground">Sim trade:</span>
            <input type="number" step="0.01" min="0.01" value={lots} onChange={(e) => setLots(Math.max(0.01, Number(e.target.value)))} className="num-input h-7 w-16" title="Lots" />
            <span className="text-muted-foreground">SL</span>
            <input type="number" value={slPips} onChange={(e) => setSlPips(Number(e.target.value))} className="num-input h-7 w-16" title="Stop loss (pips)" />
            <span className="text-muted-foreground">TP</span>
            <input type="number" value={tpPips} onChange={(e) => setTpPips(Number(e.target.value))} className="num-input h-7 w-16" title="Take profit (pips)" />
            <button onClick={() => openTrade("long")} className="h-7 rounded-lg bg-emerald-500/20 px-2 font-bold text-emerald-400 hover:bg-emerald-500/30">BUY</button>
            <button onClick={() => openTrade("short")} className="h-7 rounded-lg bg-red-500/20 px-2 font-bold text-red-400 hover:bg-red-500/30">SELL</button>
            <div className="ml-auto flex gap-1.5">
              <Stat label="Trades" value={closed.length} />
              <Stat label="Win rate" value={closed.length ? `${Math.round((wins.length / closed.length) * 1000) / 10}%` : "—"} />
              <Stat label="Net P/L" value={`${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}`} tone={netPnl > 0 ? "up" : netPnl < 0 ? "down" : "neutral"} />
            </div>
          </div>
          {closed.length > 1 && (
            <div className="mt-1.5">
              <Sparkline points={curve} height={50} color={netPnl >= 0 ? "#22c55e" : "#ef4444"} />
            </div>
          )}
          {trades.length > 0 && (
            <div className="mt-1.5 max-h-24 space-y-1 overflow-y-auto">
              {trades.slice().reverse().map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2 py-1 text-[10px]">
                  <b className={t.side === "long" ? "text-emerald-400" : "text-red-400"}>{t.side === "long" ? "LONG" : "SHORT"}</b>
                  <span className="font-number">{t.entry.toFixed(digits)}</span>
                  <span className="text-muted-foreground">{t.lots} lots @ {fmtTime(t.entryTime)}</span>
                  {t.exit != null ? (
                    <span className="ml-auto font-number">
                      → {t.exit.toFixed(digits)} · <b className={(t.pnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}>{(t.pnl ?? 0) >= 0 ? "+" : ""}{(t.pnl ?? 0).toFixed(2)}</b> <span className="uppercase text-muted-foreground">{t.reason}</span>
                    </span>
                  ) : (
                    <button onClick={() => closeTrade(t)} className="ml-auto rounded border border-border/60 px-1.5 text-muted-foreground hover:text-foreground">Close</button>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-1 text-[9px] text-muted-foreground">Replay trades are simulated on historical data — they do not touch the live demo account.</p>
        </div>
      )}

      {/* saved sessions */}
      {(sessionsQ.data ?? []).length > 0 && (
        <div className="border-t border-border/40 px-2.5 py-2">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Saved replay sessions</div>
          <div className="max-h-28 space-y-1 overflow-y-auto">
            {sessionsQ.data!.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2 py-1 text-[10px]">
                <b>{s.symbol}</b><span className="text-muted-foreground">{s.timeframe}</span>
                <span className="text-muted-foreground">{new Date(s.savedAt).toLocaleDateString()}</span>
                <span className="font-number">{s.stats.total} trades</span>
                <span className={cn("font-number", s.stats.netPnl >= 0 ? "text-emerald-400" : "text-red-400")}>{s.stats.netPnl >= 0 ? "+" : ""}{s.stats.netPnl}</span>
                <button onClick={() => deleteSession(s.id)} className="ml-auto text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Simulated trade P/L in USD (contract-size model, same as the demo account). */
function replayPnl(t: ReplayTrade, exit: number, symbol: string): number {
  const inst = getInstrument(symbol);
  const diff = t.side === "long" ? exit - t.entry : t.entry - exit;
  return Math.round(diff * t.lots * (inst?.contractSize ?? 1) * 100) / 100;
}
