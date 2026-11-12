/**
 * useReplaySession — the central Replay 2.0 controller.
 *
 * Owns: deep history (paginated, real data), the deterministic engine state,
 * cursor time (the MTF sync source of truth), playback, trading actions,
 * challenge state and save/resume. One instance lives in TerminalPage;
 * toolbar / trading panel / stats are pure views over it.
 *
 * Look-ahead safety: the cursor only ever EXPOSES past bars; the engine's
 * stepBar processes each newly revealed bar exactly once (guarded by
 * `processedIdx` so rewinding and re-playing can never double-fill orders).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ref, get, set, remove } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import type { Bar, Timeframe } from "@shared/terminal";
import { loadReplayHistory } from "@/lib/terminal/replay-history";
import {
  EMPTY_STATE, DEFAULT_ACCOUNT, openMarket, placePending, cancelPending, modifyPending,
  modifyPosition, closePosition, stepBar, equityOf, usedMarginOf,
  type ReplayState, type ReplayAccountConfig, type OpenRequest,
} from "@/lib/terminal/replay-engine";
import type { ReplayPriceLine, ReplayTradeMarker } from "@/components/terminal/TerminalChart";

export const SPEEDS = [
  { label: "0.25×", ms: 4000 }, { label: "0.5×", ms: 2000 }, { label: "1×", ms: 1000 },
  { label: "2×", ms: 500 }, { label: "3×", ms: 333 }, { label: "5×", ms: 200 },
  { label: "10×", ms: 100 }, { label: "20×", ms: 50 },
];

export interface ReplayChallenge {
  targetPct: number; maxDdPct: number; maxDailyLossPct: number; minDays: number;
  startBalance: number; startTime: number;
  status: "running" | "passed" | "failed"; failReason?: string;
}

export interface SavedReplaySession {
  id: string; name: string; savedAt: number;
  symbol: string; timeframe: Timeframe;
  cursorTime: number; speedIdx: number;
  cfg: ReplayAccountConfig;
  state: ReplayState;
  challenge?: ReplayChallenge | null;
}

export function useReplaySession(symbol: string, timeframe: Timeframe) {
  const { user } = useAuth();
  const qc = useQueryClient();

  // ---- deep history ----------------------------------------------------------
  const histQ = useQuery({
    queryKey: ["replayHistory", symbol, timeframe],
    queryFn: () => loadReplayHistory(symbol, timeframe, 5000),
    staleTime: 10 * 60_000,
  });
  const bars: Bar[] = histQ.data ?? [];

  // ---- session state -----------------------------------------------------------
  const [active, setActive] = useState(false);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [candleMode, setCandleMode] = useState(false); // pause after each bar
  const [cfg, setCfg] = useState<ReplayAccountConfig>(DEFAULT_ACCOUNT);
  const [engine, setEngine] = useState<ReplayState>(() => EMPTY_STATE(DEFAULT_ACCOUNT.startingBalance));
  const [challenge, setChallenge] = useState<ReplayChallenge | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const engineRef = useRef(engine); engineRef.current = engine;
  const processedIdxRef = useRef(-1); // last bar index fed to stepBar
  const barsRef = useRef(bars); barsRef.current = bars;
  const stateRef = useRef({ cursorIdx, symbol, timeframe, cfg, challenge });
  stateRef.current = { cursorIdx, symbol, timeframe, cfg, challenge };

  const cursorBar: Bar | undefined = active ? bars[Math.min(cursorIdx, bars.length - 1)] : undefined;
  const cursorBarRef = useRef<Bar | undefined>(undefined);
  cursorBarRef.current = cursorBar;

  // ---- multi-timeframe sync (§6): switching TF keeps the same historical instant
  const tfRef = useRef(timeframe);
  const pendingSeekRef = useRef<number | null>(null);
  useEffect(() => {
    if (tfRef.current === timeframe) return;
    tfRef.current = timeframe;
    if (active && cursorBarRef.current) pendingSeekRef.current = cursorBarRef.current.time;
  }, [timeframe, active]);
  useEffect(() => {
    if (pendingSeekRef.current == null || !bars.length || !active) return;
    const t = pendingSeekRef.current;
    pendingSeekRef.current = null;
    let idx = bars.length - 1;
    for (let i = 0; i < bars.length; i++) { if (bars[i].time >= t) { idx = i; break; } }
    // bars up to the cursor are already reflected in engine state on the old TF —
    // never re-process them (deterministic, no double fills)
    processedIdxRef.current = Math.max(processedIdxRef.current, idx);
    setCursorIdx(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars]);

  /** Feed all newly revealed bars (cursor → target) through the engine, in order. */
  const processTo = useCallback((targetIdx: number) => {
    const bs = barsRef.current;
    let st = engineRef.current;
    const { cfg: c, symbol: sym } = stateRef.current;
    const events: string[] = [];
    for (let i = processedIdxRef.current + 1; i <= targetIdx && i < bs.length; i++) {
      const res = stepBar(st, c, { ...bs[i], symbol: sym });
      st = res.state;
      events.push(...res.events);
    }
    processedIdxRef.current = Math.max(processedIdxRef.current, targetIdx);
    if (st !== engineRef.current) setEngine(st);
    return events;
  }, []);

  // ---- lifecycle ---------------------------------------------------------------

  const start = useCallback((startIdx?: number) => {
    const bs = barsRef.current;
    if (bs.length < 50) { setNotice("Not enough historical data loaded for this instrument/timeframe."); return; }
    const idx = Math.max(30, Math.min(bs.length - 1, startIdx ?? Math.floor(bs.length * 0.7)));
    processedIdxRef.current = idx;          // bars ≤ idx are "already revealed"
    setCursorIdx(idx);
    setEngine(EMPTY_STATE(cfg.startingBalance));
    setActive(true);
    setPlaying(false);
    if (challenge === null) setChallenge(null);
  }, [cfg.startingBalance, challenge]);

  const stop = useCallback(() => {
    setActive(false); setPlaying(false); setChallenge(null); setNotice(null);
  }, []);

  const stepForward = useCallback((n = 1) => {
    if (!active) return;
    const target = Math.min(barsRef.current.length - 1, cursorIdx + n);
    if (target === cursorIdx) return;
    const evts = processTo(target);
    setCursorIdx(target);
    if (evts.length) setNotice(evts.join(" · "));
    if (candleMode && n === 1) setPlaying(false);
  }, [active, cursorIdx, processTo, candleMode]);

  const stepBack = useCallback((n = 1) => {
    if (!active) return;
    // review-only rewind: account state is NOT rewound (processedIdx never decreases)
    setCursorIdx((c) => Math.max(0, c - n));
  }, [active]);

  const seekToTime = useCallback((t: number) => {
    if (!active) return;
    const bs = barsRef.current;
    // nearest bar at or before t
    let idx = bs.length - 1;
    for (let i = bs.length - 1; i >= 0; i--) { if (bs[i].time <= t) { idx = i; break; } }
    if (idx > processedIdxRef.current) processTo(idx);
    setCursorIdx(idx);
  }, [active, processTo]);

  const seekToIdx = useCallback((idx: number) => {
    if (!active) return;
    const i = Math.max(0, Math.min(barsRef.current.length - 1, idx));
    if (i > processedIdxRef.current) processTo(i);
    setCursorIdx(i);
  }, [active, processTo]);

  // ---- trading -----------------------------------------------------------------
  const priceOf = useCallback((sym: string) => (sym === symbol ? cursorBar?.close : undefined), [symbol, cursorBar]);

  const trade = useCallback((fn: (st: ReplayState, bar: Bar) => { state: ReplayState; error?: string; event?: string }) => {
    const bar = barsRef.current[Math.min(stateRef.current.cursorIdx, barsRef.current.length - 1)];
    if (!bar) return;
    const res = fn(engineRef.current, bar);
    if (res.error) { setNotice(res.error); return false; }
    setEngine(res.state);
    if (res.event) setNotice(res.event);
    return true;
  }, []);

  const open = useCallback((req: OpenRequest) => trade((st, bar) => openMarket(st, cfg, bar, req)), [cfg, trade]);
  const pending = useCallback((req: OpenRequest & { type: "limit" | "stop"; price: number }) => trade((st, bar) => placePending(st, bar, req)), [trade]);
  const close = useCallback((id: string, lots?: number) => trade((st, bar) => closePosition(st, cfg, bar, id, lots)), [cfg, trade]);
  const modify = useCallback((id: string, patch: { sl?: number | null; tp?: number | null }) => { setEngine((st) => modifyPosition(st, id, patch)); }, []);
  const cancelOrder = useCallback((id: string) => { setEngine((st) => cancelPending(st, id)); }, []);
  const modifyOrder = useCallback((id: string, patch: { price?: number; sl?: number | null; tp?: number | null }) => { setEngine((st) => modifyPending(st, id, patch)); }, []);

  const resetAccount = useCallback((newCfg?: Partial<ReplayAccountConfig>) => {
    const nextCfg = { ...cfg, ...newCfg };
    setCfg(nextCfg);
    setEngine(EMPTY_STATE(nextCfg.startingBalance));
    if (active) { processedIdxRef.current = cursorIdx; } // keep revealed bars consistent
  }, [cfg, active, cursorIdx]);

  // ---- derived ------------------------------------------------------------------
  const equity = useMemo(() => equityOf(engine, priceOf, cfg), [engine, priceOf, cfg]);
  const usedMargin = useMemo(() => usedMarginOf(engine, priceOf, cfg), [engine, priceOf, cfg]);
  const freeMargin = equity - usedMargin;
  const floating = equity - engine.balance;
  const upToTime = cursorBar?.time ?? 0;

  const markers = useMemo<ReplayTradeMarker[]>(() => {
    const out: ReplayTradeMarker[] = [];
    for (const t of engine.closed) {
      out.push({ time: t.entryTime, side: t.side, kind: "entry" });
      out.push({ time: t.exitTime, side: t.side, kind: "exit", profit: t.pnl, reason: t.reason });
    }
    return out;
  }, [engine.closed]);

  const priceLines = useMemo<ReplayPriceLine[]>(() => {
    if (!active || symbol !== symbol) return [];
    const out: ReplayPriceLine[] = [];
    for (const p of engine.positions) {
      if (p.symbol !== symbol) continue;
      out.push({ id: `pos-${p.id}`, price: p.entry, color: p.side === "buy" ? "#22c55e" : "#ef4444", title: `${p.side.toUpperCase()} ${p.lots}`, width: 2 });
      if (p.sl != null) out.push({ id: `sl-${p.id}`, price: p.sl, color: "#ef4444", title: "SL", dashed: true });
      if (p.tp != null) out.push({ id: `tp-${p.id}`, price: p.tp, color: "#22c55e", title: "TP", dashed: true });
    }
    for (const o of engine.orders) {
      if (o.symbol !== symbol) continue;
      out.push({ id: `ord-${o.id}`, price: o.price, color: "#f59e0b", title: `${o.side} ${o.type} ${o.lots}`, dashed: true });
    }
    return out;
  }, [engine.positions, engine.orders, symbol, active]);

  // ---- challenge evaluation ------------------------------------------------------
  const evaluateChallenge = useCallback(() => {
    const ch = stateRef.current.challenge;
    if (!ch || ch.status !== "running") return null;
    const eq = equityOf(engineRef.current, priceOf, cfg);
    const retPct = ((eq - ch.startBalance) / ch.startBalance) * 100;
    let peak = ch.startBalance, maxDDPct = 0, run = eq;
    for (const t of engineRef.current.closed) {
      run += t.pnl;
      peak = Math.max(peak, run);
      maxDDPct = Math.max(maxDDPct, ((peak - run) / peak) * 100);
    }
    const days = new Set(engineRef.current.closed.map((t) => new Date(t.exitTime * 1000).toISOString().slice(0, 10))).size;
    const dailyNet = new Map<string, number>();
    for (const t of engineRef.current.closed) {
      const d = new Date(t.exitTime * 1000).toISOString().slice(0, 10);
      dailyNet.set(d, (dailyNet.get(d) ?? 0) + t.pnl);
    }
    const worstDayPct = Math.min(0, ...[...dailyNet.values()].map((v) => (v / ch.startBalance) * 100));
    let next: ReplayChallenge = ch;
    if (retPct >= ch.targetPct && days >= ch.minDays) next = { ...ch, status: "passed" };
    else if (maxDDPct > ch.maxDdPct) next = { ...ch, status: "failed", failReason: `Max drawdown ${maxDDPct.toFixed(1)}% exceeded ${ch.maxDdPct}%` };
    else if (-worstDayPct > ch.maxDailyLossPct && worstDayPct < 0) next = { ...ch, status: "failed", failReason: `Daily loss ${(-worstDayPct).toFixed(1)}% exceeded ${ch.maxDailyLossPct}%` };
    if (next !== ch) { setChallenge(next); return next; }
    return { ...ch, retPct, maxDDPct, days, worstDayPct };
  }, [cfg, priceOf]);

  // ---- save / resume (§14) ---------------------------------------------------------
  const sessionsQ = useQuery({
    queryKey: ["replaySessions2", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<SavedReplaySession[]> => {
      const snap = await get(ref(db, `terminalReplaySessions/${user!.uid}`));
      return snap.exists() ? Object.values<SavedReplaySession>(snap.val()).sort((a, b) => b.savedAt - a.savedAt) : [];
    },
  });

  const saveSession = useCallback(async (name: string) => {
    if (!user || !active) return null;
    const rec: SavedReplaySession = {
      id: Math.random().toString(36).slice(2, 12),
      name: name.trim() || `Session ${new Date().toLocaleString()}`,
      savedAt: Date.now(), symbol, timeframe,
      cursorTime: cursorBar?.time ?? 0, speedIdx,
      cfg, state: JSON.parse(JSON.stringify(engine)),
      challenge,
    };
    await set(ref(db, `terminalReplaySessions/${user.uid}/${rec.id}`), rec);
    qc.invalidateQueries({ queryKey: ["replaySessions2", user.uid] });
    return rec;
  }, [user, active, symbol, timeframe, cursorBar, speedIdx, cfg, engine, challenge, qc]);

  const deleteSession = useCallback(async (id: string) => {
    if (!user) return;
    await remove(ref(db, `terminalReplaySessions/${user.uid}/${id}`));
    qc.invalidateQueries({ queryKey: ["replaySessions2", user.uid] });
  }, [user, qc]);

  const resumeSession = useCallback((rec: SavedReplaySession) => {
    const bs = barsRef.current;
    if (!bs.length) { setNotice("Load history for the session's instrument first."); return; }
    let idx = bs.length - 1;
    for (let i = 0; i < bs.length; i++) { if (bs[i].time >= rec.cursorTime) { idx = i; break; } }
    setCfg(rec.cfg);
    setEngine(rec.state);
    setChallenge(rec.challenge ?? null);
    setSpeedIdx(rec.speedIdx);
    processedIdxRef.current = idx;
    setCursorIdx(idx);
    setActive(true);
    setPlaying(false);
    setNotice(`Resumed “${rec.name}”`);
  }, []);

  const replayChartProps = useMemo(() => ({
    replay: active ? { active: true, upToTime } : null,
    tradeMarkers: markers,
    priceLines,
  }), [active, upToTime, markers, priceLines]);

  return {
    // data & lifecycle
    symbol, timeframe, bars, loading: histQ.isLoading, historyError: histQ.error as Error | null,
    active, playing, cursorIdx, cursorBar, upToTime, speedIdx, candleMode,
    start, stop, setPlaying, setSpeedIdx, setCandleMode,
    stepForward, stepBack, seekToTime, seekToIdx,
    // account & trading
    cfg, setCfg: resetAccount, engine, equity, usedMargin, freeMargin, floating,
    open, pending, close, modify, cancelOrder, modifyOrder,
    // ui
    notice, setNotice, markers, priceLines, replayChartProps, priceOf,
    // challenge
    challenge, setChallenge, evaluateChallenge,
    // sessions
    sessions: sessionsQ.data ?? [], saveSession, deleteSession, resumeSession, reloadSessions: () => qc.invalidateQueries({ queryKey: ["replaySessions2", user?.uid] }),
  };
}

export type ReplaySession = ReturnType<typeof useReplaySession>;
