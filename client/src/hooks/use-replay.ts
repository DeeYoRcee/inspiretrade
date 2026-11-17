/**
 * use-replay — interactive historical market replay state machine.
 *
 * Owns: the real historical bar window (loaded via history-loader), the
 * replay cursor, the simulated clock, playback speed, the REPLAY wallet
 * (isolated from live virtual balances) and every broker action.
 *
 * Look-ahead safety: the chart only ever receives bars[0..cursor] (+ the
 * forming candle built from the REAL OHLC sub-point path). The broker
 * (stepReplayBar) consumes exactly one bar per advance — it can never see
 * beyond the cursor.
 *
 * Rewinding (step back / jump) rebuilds the wallet by deterministically
 * replaying the broker from the session start up to the new cursor — trades
 * opened after that point are discarded, like standard replay tools.
 *
 * The session (config + cursor + wallet) persists to RTDB replaySessions/{uid}
 * so a refresh resumes where the user left off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ref as dbRef, get, set, remove } from "firebase/database";
import { db, auth } from "@/lib/firebase";
import { loadHistoryRange } from "@/lib/history-loader";
import { getInstrument, TF_SECONDS, type Bar, type Timeframe } from "@shared/terminal";
import {
  newReplayWallet, replayOpen, replayPlace, replayCancel, replayClose,
  replayModifyPosition, replayModifyOrder, stepReplayBar, barPathPoints,
  replayQuote, replayEquity, replayUsedMargin, performanceStats,
  type PerfStats, type ReplayExecConfig, type ReplayWallet, type ReplayTrade,
} from "@shared/replay-engine";
import { exitPriceFor, type Side } from "@shared/trading-engine";

export type ReplaySpeed = 1 | 2 | 5 | 10 | 20 | 50;
export const REPLAY_SPEEDS: ReplaySpeed[] = [1, 2, 5, 10, 20, 50];
/** simulated duration of one candle at 1x (2s), multiplied by the speed */
const BAR_MS_AT_1X = 2000;
const TICK_MS = 100;
const MAX_DT_BARS_PER_TICK = 10;

export interface ReplaySessionMeta {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  startISO: string;
  createdAt: number;
}

export interface ReplayStatus {
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
  progressText: string | null;
}

export interface ReplayClosedEvent {
  trade: ReplayTrade;
  sessionId: string;
}

function makeForming(bar: Bar, progress: number, tfSec: number): { bar: Bar; price: number; simTime: number } {
  const points = barPathPoints(bar);
  const segs = points.length - 1;
  const pos = Math.min(segs, Math.max(0, progress * segs));
  const i = Math.min(segs - 1, Math.floor(pos));
  const frac = segs === 0 ? 1 : pos - i;
  const price = i + 1 < points.length
    ? points[i] + (points[i + 1] - points[i]) * frac
    : points[points.length - 1];
  const revealed = points.slice(0, i + 1).concat(price);
  const forming: Bar = {
    time: bar.time,
    open: bar.open,
    high: Math.max(...revealed),
    low: Math.min(...revealed),
    close: price,
    volume: Math.round((bar.volume ?? 0) * Math.min(1, Math.max(0, progress))),
  };
  return { bar: forming, price, simTime: bar.time * 1000 + Math.floor(progress * tfSec * 1000) };
}

/** Deterministically rebuild a wallet by stepping the broker over [0..lastIdx]. */
function rebuildWallet(
  wallet0: ReplayWallet, spec: any, cfg: ReplayExecConfig, bars: Bar[], lastIdx: number,
): ReplayWallet {
  let w = newReplayWallet(wallet0.balance);
  w.seq = wallet0.seq;
  for (let i = 0; i <= lastIdx; i++) w = stepReplayBar(w, spec, cfg, bars[i]).wallet;
  w.seq = Math.max(w.seq, wallet0.seq);
  return w;
}

export function useReplay() {
  const [phase, setPhase] = useState<ReplayStatus["phase"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [session, setSession] = useState<ReplaySessionMeta | null>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [wallet, setWallet] = useState<ReplayWallet>(() => newReplayWallet(100000));
  const [forming, setForming] = useState<{ bar: Bar; price: number; simTime: number } | null>(null);
  const [capped, setCapped] = useState(false);
  const [lots, setLots] = useState(0.1);
  const [commissionPerLot, setCommissionPerLot] = useState(0);
  const [closedEvents, setClosedEvents] = useState<ReplayClosedEvent[]>([]);

  const barsRef = useRef<Bar[]>([]);
  barsRef.current = bars;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const progressRef = useRef(0); // intra-bar progress 0..1 of the current candle
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<ReplaySessionMeta | null>(null);
  sessionRef.current = session;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const cfgRef = useRef<ReplayExecConfig>({ commissionPerLot, leverage: 100 });
  cfgRef.current = { commissionPerLot, leverage: 100 };

  const spec = useMemo(() => (session ? getInstrument(session.symbol) : null), [session]);
  const cfg = cfgRef.current;
  const stats: PerfStats = useMemo(() => performanceStats(wallet.closed), [wallet.closed]);
  const mid = forming?.price ?? (bars[cursor]?.close ?? null);
  const equity = mid != null && spec ? replayEquity(wallet, spec, mid, forming?.simTime ?? 0, cfg) : wallet.balance;
  const usedMargin = mid != null && spec ? replayUsedMargin(wallet, spec, mid, cfg) : 0;
  const quote = mid != null && spec && forming ? replayQuote(spec, mid, forming.simTime, cfg) : null;

  // ---- session loading -------------------------------------------------------

  const loadSession = useCallback(async (symbol: string, tf: Timeframe, startISO: string, startBalance: number) => {
    setPhase("loading");
    setError(null);
    setProgressText("Loading real history…");
    setPlaying(false);
    try {
      const startMs = new Date(startISO).getTime();
      if (!Number.isFinite(startMs)) throw new Error("Invalid start date");
      const now = Date.now();
      if (startMs >= now - TF_SECONDS[tf] * 1000) throw new Error("Start date must be in the past");
      const fromSec = Math.floor(startMs / 1000);
      const toSec = Math.floor(now / 1000);
      const res = await loadHistoryRange(symbol, tf, fromSec, toSec, (done, total) => {
        setProgressText(`Loading history… ${done}/${total}`);
      });
      if (res.bars.length < 30) throw new Error("Not enough history in this window — try an earlier start or a higher timeframe");
      const id = `rs-${Date.now().toString(36)}`;
      const meta: ReplaySessionMeta = { id, symbol, timeframe: tf, startISO, createdAt: Date.now() };
      const w = newReplayWallet(startBalance);
      setSession(meta);
      sessionRef.current = meta;
      setBars(res.bars);
      barsRef.current = res.bars;
      setCursor(0);
      cursorRef.current = 0;
      progressRef.current = 0;
      setWallet(w);
      walletRef.current = w;
      setCapped(res.capped);
      const specLocal = getInstrument(symbol)!;
      setForming(makeForming(res.bars[0], 0, TF_SECONDS[tf]));
      setPhase("ready");
      setProgressText(null);
      void persistSession(meta, res.bars.length, 0, w, tf);
      void specLocal;
    } catch (e: any) {
      setPhase("error");
      setError(String(e?.message || e));
      setProgressText(null);
    }
  }, []);

  // ---- persistence: RTDB when rules allow, localStorage fallback -------------

  const lsKey = () => `it_replay_sessions_${auth.currentUser?.uid ?? "anon"}`;

  const lsRead = useCallback((): Record<string, any> => {
    try { return JSON.parse(localStorage.getItem(lsKey()) || "{}"); } catch { return {}; }
  }, []);

  const lsWrite = useCallback((map: Record<string, any>) => {
    try {
      // keep the local mirror small: last 6 sessions, closed-trades tail only
      const ids = Object.values(map as any)
        .filter((s: any) => s?.meta?.id)
        .sort((a: any, b: any) => (b.meta.createdAt ?? 0) - (a.meta.createdAt ?? 0))
        .slice(0, 6);
      const trimmed: Record<string, any> = {};
      for (const s of ids as any[]) {
        trimmed[s.meta.id] = { ...s, wallet: s.wallet ? { ...s.wallet, closed: (s.wallet.closed ?? []).slice(-50) } : undefined };
      }
      localStorage.setItem(lsKey(), JSON.stringify(trimmed));
    } catch { /* quota — ignore */ }
  }, []);

  const persistSession = useCallback(async (
    meta: ReplaySessionMeta | null, barCount: number, cur: number, w: ReplayWallet, tf: Timeframe,
  ) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !meta) return;
    const payload = {
      meta, cursor: cur, barCount, tfSec: TF_SECONDS[tf],
      wallet: { balance: w.balance, seq: w.seq, positions: w.positions, orders: w.orders, closed: w.closed.slice(-300) },
      updatedAt: Date.now(),
    };
    // RTDB first (uid-scoped rules; falls back to a local mirror when the
    // rules haven't been deployed to production Firebase yet)
    try {
      await set(dbRef(db, `replaySessions/${uid}/${meta.id}`), payload);
      await set(dbRef(db, `replaySessions/${uid}/latest`), meta.id);
    } catch { /* rules/offline — local mirror keeps it */ }
    const map = lsRead();
    map[meta.id] = payload;
    lsWrite(map);
  }, [lsRead, lsWrite]);

  const savedSessions = useCallback(async (): Promise<ReplaySessionMeta[]> => {
    const uid = auth.currentUser?.uid;
    if (!uid) return [];
    const metas: ReplaySessionMeta[] = [];
    try {
      const snap = await get(dbRef(db, `replaySessions/${uid}`));
      if (snap.exists()) {
        const val = snap.val() as Record<string, any>;
        metas.push(...Object.values(val)
          .filter((s: any) => s?.meta?.id || (s?.id && s?.symbol))
          .map((s: any) => (s.meta ? (s.meta as ReplaySessionMeta) : ({ id: s.id, symbol: s.symbol, timeframe: s.timeframe, startISO: s.startISO, createdAt: s.createdAt }) as ReplaySessionMeta)));
      }
    } catch { /* rules/offline — fall back to the local mirror */ }
    const local = lsRead();
    for (const s of Object.values(local) as any[]) {
      if (s?.meta?.id && !metas.some((m) => m.id === s.meta.id)) metas.push(s.meta as ReplaySessionMeta);
    }
    return metas.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 10);
  }, [lsRead]);

  const deleteSession = useCallback(async (id: string) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try { await remove(dbRef(db, `replaySessions/${uid}/${id}`)); } catch { /* ignore */ }
    const map = lsRead();
    delete map[id];
    lsWrite(map);
  }, [lsRead, lsWrite]);

  const resumeSession = useCallback(async (meta: ReplaySessionMeta) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setPhase("loading");
    setError(null);
    setProgressText("Restoring session…");
    try {
      const startMs = new Date(meta.startISO).getTime();
      const toSec = Math.floor(Date.now() / 1000);
      const res = await loadHistoryRange(meta.symbol, meta.timeframe, Math.floor(startMs / 1000), toSec);
      let cur = 0;
      let w: ReplayWallet | null = null;
      try {
        const snap = await get(dbRef(db, `replaySessions/${uid}/${meta.id}`));
        if (snap.exists()) {
          const saved: any = snap.val();
          cur = Math.min(saved?.cursor ?? 0, res.bars.length - 1);
          if (saved?.wallet) {
            w = { balance: saved.wallet.balance, seq: saved.wallet.seq ?? 1, positions: saved.wallet.positions ?? [], orders: saved.wallet.orders ?? [], closed: saved.wallet.closed ?? [] };
          }
        }
      } catch { /* rules/offline — try the local mirror */ }
      if (!w) {
        const local = lsRead()[meta.id];
        if (local?.wallet) {
          cur = Math.min(local.cursor ?? 0, res.bars.length - 1);
          w = { balance: local.wallet.balance, seq: local.wallet.seq ?? 1, positions: local.wallet.positions ?? [], orders: local.wallet.orders ?? [], closed: local.wallet.closed ?? [] };
        }
      }
      if (!w) w = newReplayWallet(100000);
      setSession(meta);
      sessionRef.current = meta;
      setBars(res.bars);
      barsRef.current = res.bars;
      setCursor(cur);
      cursorRef.current = cur;
      progressRef.current = 0;
      setWallet(w);
      walletRef.current = w;
      setForming(makeForming(res.bars[cur], 0, TF_SECONDS[meta.timeframe]));
      setPhase("ready");
      setProgressText(null);
    } catch (e: any) {
      setPhase("error");
      setError(String(e?.message || e));
      setProgressText(null);
    }
  }, [lsRead]);

  // ---- playback loop ---------------------------------------------------------

  useEffect(() => {
    if (!playing || phase !== "ready" || !session || !spec) return;
    const tfSec = TF_SECONDS[session.timeframe];
    const timer = setInterval(() => {
      const list = barsRef.current;
      let cur = cursorRef.current;
      if (cur >= list.length - 1) {
        setPlaying(false);
        return;
      }
      const dtBars = (speedRef.current * TICK_MS) / BAR_MS_AT_1X; // candles to advance this tick
      let remaining = Math.min(dtBars, MAX_DT_BARS_PER_TICK);
      let w = walletRef.current;
      let p = progressRef.current;
      const events: ReplayTrade[] = [];
      while (remaining > 0 && cur < list.length - 1) {
        const stepSize = Math.min(remaining, 1 - p);
        p += stepSize;
        remaining -= stepSize;
        if (p >= 0.9999) {
          // candle complete — run the broker for this bar
          const step = stepReplayBar(w, spec, cfgRef.current, list[cur]);
          w = step.wallet;
          events.push(...step.closed.map((c) => c.trade));
          cur += 1;
          p = 0;
        }
      }
      progressRef.current = p;
      cursorRef.current = cur;
      walletRef.current = w;
      const f = makeForming(list[cur], p, tfSec);
      // batched state updates (one render per tick)
      setCursor(cur);
      setWallet(w);
      setForming(f);
      if (events.length) {
        const sid = sessionRef.current?.id ?? "";
        setClosedEvents((prev) => [...prev, ...events.map((trade) => ({ trade, sessionId: sid }))]);
      }
    }, TICK_MS);
    timerRef.current = timer;
    return () => { clearInterval(timer); timerRef.current = null; };
  }, [playing, phase, session, spec]);

  // periodic session save while playing
  useEffect(() => {
    if (!playing || !session) return;
    const t = setInterval(() => {
      void persistSession(sessionRef.current, barsRef.current.length, cursorRef.current, walletRef.current, session!.timeframe);
    }, 10000);
    return () => clearInterval(t);
  }, [playing, session, persistSession]);

  // save on unmount / tab hide
  useEffect(() => {
    const save = () => {
      if (sessionRef.current && phase === "ready") {
        void persistSession(sessionRef.current, barsRef.current.length, cursorRef.current, walletRef.current, sessionRef.current.timeframe);
      }
    };
    document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
    window.addEventListener("pagehide", save);
    return () => { save(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ---- actions ---------------------------------------------------------------

  const advanceTo = useCallback((targetCursor: number, keepManual = false) => {
    const list = barsRef.current;
    const clamped = Math.max(0, Math.min(targetCursor, list.length - 1));
    const cur = cursorRef.current;
    const w0 = walletRef.current;
    let w: ReplayWallet;
    if (clamped >= cur && keepManual) {
      // pure forward jump: step the broker over the skipped bars, keep manual trades
      w = w0;
      const specLocal = sessionRef.current ? getInstrument(sessionRef.current.symbol) : null;
      if (specLocal) {
        for (let i = cur; i < clamped; i++) {
          const step = stepReplayBar(w, specLocal, cfgRef.current, list[i]);
          w = step.wallet;
          if (step.closed.length) {
            const sid = sessionRef.current?.id ?? "";
            setClosedEvents((prev) => [...prev, ...step.closed.map((c) => ({ trade: c.trade, sessionId: sid }))]);
          }
        }
      }
    } else {
      // rewind or fresh rebuild: deterministic broker-only replay from the start
      const specLocal = sessionRef.current ? getInstrument(sessionRef.current.symbol) : null;
      w = specLocal ? rebuildWallet(newReplayWallet(w0.balance), specLocal, cfgRef.current, list, Math.max(0, clamped - 1)) : w0;
    }
    setCursor(clamped);
    cursorRef.current = clamped;
    setWallet(w);
    walletRef.current = w;
    progressRef.current = 0;
    const tfSec = sessionRef.current ? TF_SECONDS[sessionRef.current.timeframe] : 60;
    setForming(makeForming(list[clamped], 0, tfSec));
    if (sessionRef.current) {
      void persistSession(sessionRef.current, list.length, clamped, w, sessionRef.current.timeframe);
    }
  }, [persistSession]);

  const play = useCallback(() => { if (phase === "ready") setPlaying(true); }, [phase]);
  const pause = useCallback(() => setPlaying(false), []);
  const stepForward = useCallback(() => {
    pause();
    advanceTo(cursorRef.current + 1, true);
  }, [advanceTo, pause]);
  const stepBackward = useCallback(() => {
    pause();
    advanceTo(cursorRef.current - 1, false);
  }, [advanceTo, pause]);
  const jumpTo = useCallback((iso: string) => {
    pause();
    const t = new Date(iso).getTime();
    const list = barsRef.current;
    const idx = list.findIndex((b) => b.time * 1000 >= t);
    advanceTo(idx < 0 ? list.length - 1 : idx, false);
  }, [advanceTo, pause]);

  const openMarket = useCallback((side: Side, l: number, sl: number | null, tp: number | null) => {
    if (!spec || !forming) return { ok: false, error: "Replay not running" };
    const res = replayOpen(walletRef.current, spec, cfgRef.current, {
      symbol: spec.symbol, side, lots: l, sl, tp, now: forming.simTime, kind: "market", mid: forming.price,
    });
    if (res.ok) { setWallet(res.wallet); walletRef.current = res.wallet; }
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }, [spec, forming]);

  const placePending = useCallback((side: Side, kind: "limit" | "stop", price: number, l: number, sl: number | null, tp: number | null) => {
    if (!spec || !forming) return { ok: false, error: "Replay not running" };
    const res = replayPlace(walletRef.current, spec, cfgRef.current, {
      symbol: spec.symbol, side, lots: l, price, sl, tp, now: forming.simTime, kind, mid: forming.price,
    });
    if (res.ok) { setWallet(res.wallet); walletRef.current = res.wallet; }
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }, [spec, forming]);

  const cancelOrder = useCallback((orderId: string) => {
    const w = replayCancel(walletRef.current, orderId);
    setWallet(w); walletRef.current = w;
    return { ok: true };
  }, []);

  const closePosition = useCallback((positionId: string) => {
    if (!spec || !forming) return { ok: false, error: "Replay not running" };
    const res = replayClose(walletRef.current, spec, cfgRef.current, positionId, forming.price, forming.simTime);
    if (res.ok && res.wallet) {
      setWallet(res.wallet);
      walletRef.current = res.wallet;
      if (res.trade && sessionRef.current) {
        setClosedEvents((prev) => [...prev, { trade: res.trade!, sessionId: sessionRef.current!.id }]);
      }
      return { ok: true };
    }
    return { ok: false, error: res.error };
  }, [spec, forming]);

  const modifyPosition = useCallback((positionId: string, patch: { sl?: number | null; tp?: number | null }) => {
    const res = replayModifyPosition(walletRef.current, positionId, patch);
    if (res.ok) { setWallet(res.wallet); walletRef.current = res.wallet; }
    return res;
  }, []);

  const modifyOrder = useCallback((orderId: string, patch: { price?: number; sl?: number | null; tp?: number | null; lots?: number }) => {
    const res = replayModifyOrder(walletRef.current, orderId, patch);
    if (res.ok) { setWallet(res.wallet); walletRef.current = res.wallet; }
    return res;
  }, []);

  const markEventsSeen = useCallback(() => setClosedEvents([]), []);

  const exitPriceAt = useCallback((side: Side) => {
    if (!spec || !forming || !quote) return null;
    return exitPriceFor(side, quote);
  }, [spec, forming, quote]);

  return {
    phase, error, progressText, session, bars, cursor, playing, speed, wallet, forming,
    simTime: forming?.simTime ?? null,
    currentPrice: forming?.price ?? null,
    stats, equity, usedMargin, lots, commissionPerLot, capped, closedEvents,
    setSpeed, setLots, setCommissionPerLot,
    loadSession, resumeSession, savedSessions, deleteSession,
    play, pause, stepForward, stepBackward, jumpTo,
    openMarket, placePending, cancelOrder, closePosition, modifyPosition, modifyOrder,
    markEventsSeen, exitPriceAt,
  };
}
