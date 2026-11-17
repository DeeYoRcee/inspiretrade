/**
 * ReplayWorkspace — interactive historical market replay, embedded in the
 * TERMINAL (mode "replay"). TerminalPage owns the useReplay() state and the
 * PriceChart; this file provides the pieces that fill the terminal slots:
 *
 *   useReplayJournalAutoSave  — hook: auto-journal closed replay trades
 *   ReplayOverlay             — launcher (start config + saved sessions),
 *                               rendered over the chart until a session runs
 *   ReplayControls            — playback bar + isolated-wallet stats
 *   ReplayTicket              — right-hand order ticket (replay wallet)
 *   ReplayBook                — bottom blotter (positions/orders/closed)
 *
 * Real candles only (Binance klines / the quotes proxy in period mode), the
 * future is always hidden, and trades run through the same bar-step broker as
 * backtesting (shared/replay-engine) on an ISOLATED replay wallet — the live
 * virtual accounts are never touched.
 */
import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { push, ref as dbRef } from "firebase/database";
import { Play, Pause, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, History as HistoryIcon, Trash2, BookMarked } from "lucide-react";
import { getInstrument, type Timeframe } from "@shared/terminal";
import { positionPnlUsd } from "@shared/trading-engine";
import { useReplay, REPLAY_SPEEDS, type ReplaySpeed, type ReplaySessionMeta } from "@/hooks/use-replay";
import { historyAvailability } from "@/lib/history-loader";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { db, auth } from "@/lib/firebase";
import { cn } from "@/lib/utils";

export type ReplayApi = ReturnType<typeof useReplay>;

const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clockOf = (ms: number | null) => {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/** Auto-journal every closed replay trade with a chart snapshot. */
export function useReplayJournalAutoSave(r: ReplayApi, chartBoxRef: MutableRefObject<HTMLElement | null>) {
  const savingRef = useState(new Set<string>())[0];
  useEffect(() => {
    if (!r.closedEvents.length) return;
    for (const ev of r.closedEvents) void saveClosedTrade(ev, chartBoxRef.current, savingRef);
    r.markEventsSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.closedEvents]);
}

/** Chart-area overlay shown until a replay session is running. */
export function ReplayOverlay({ r, symbol, timeframe }: { r: ReplayApi; symbol: string; timeframe: Timeframe }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-4xl">
        {r.phase === "loading" ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/90 p-6 text-center text-sm text-sky-300">
            {r.progressText ?? "Loading real history…"}
          </div>
        ) : (
          <ReplayLauncher r={r} symbol={symbol} timeframe={timeframe} />
        )}
      </div>
    </div>
  );
}

/** "Replay wallet · future hidden" badge pinned to the chart corner. */
export function ReplayBadge() {
  return (
    <div className="pointer-events-none absolute right-3 top-2 z-10 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
      Replay wallet · future hidden
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launcher (start config + saved sessions)
// ---------------------------------------------------------------------------

function ReplayLauncher({ r, symbol, timeframe }: { r: ReplayApi; symbol: string; timeframe: Timeframe }) {
  const [startISO, setStartISO] = useState(() => {
    const d = new Date(Date.now() - 14 * 86400000);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [balance, setBalance] = useState(100000);
  const [commission, setCommission] = useState(0);
  const [saved, setSaved] = useState<ReplaySessionMeta[]>([]);
  const availability = historyAvailability(symbol, timeframe);
  const minISO = availability.maxDaysBack != null
    ? new Date(Date.now() - availability.maxDaysBack * 86400000).toISOString().slice(0, 16)
    : new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 16);

  useEffect(() => { void r.savedSessions().then(setSaved); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const start = () => {
    if (new Date(startISO).getTime() < new Date(minISO).getTime()) {
      toast({ title: "Start date too far back", description: availability.note, variant: "destructive" });
      return;
    }
    void r.loadSession(symbol, timeframe, startISO, balance);
  };

  return (
    <div className="grid gap-4 rounded-lg border border-slate-800 bg-slate-900/95 p-4 md:grid-cols-[1fr_240px]">
      <div className="space-y-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <HistoryIcon className="h-4 w-4 text-sky-400" /> Trade replay — {symbol} · {timeframe.toUpperCase()}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            The chart loads real historical candles for {symbol} and reveals them one by one — the
            future stays hidden. Trades execute on an isolated replay wallet with the same
            spread / commission engine as live virtual trading.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Start date & time (UTC)">
            <input
              type="datetime-local" value={startISO} min={minISO}
              max={new Date(Date.now() - 3600000).toISOString().slice(0, 16)}
              onChange={(e) => setStartISO(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            />
          </Field>
          <Field label="Starting balance ($)">
            <input
              type="number" value={balance} min={100} max={5000000} step={1000}
              onChange={(e) => setBalance(Math.max(100, Number(e.target.value) || 0))}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            />
          </Field>
          <Field label="Commission per lot ($, round-trip)">
            <input
              type="number" value={commission} min={0} max={50} step={0.5}
              onChange={(e) => setCommission(Math.max(0, Number(e.target.value) || 0))}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            />
          </Field>
        </div>
        <p className="text-[10px] text-slate-500">{availability.note}</p>
        {r.phase === "error" && <div className="text-xs text-red-400">{r.error}</div>}
        <Button onClick={start} disabled={r.phase === "loading"} className="bg-sky-600 hover:bg-sky-500">
          <Play className="mr-1 h-3.5 w-3.5" /> Start replay
        </Button>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <h3 className="text-sm font-semibold text-slate-100">Saved sessions</h3>
        <p className="mt-1 text-[10px] text-slate-500">Only you can see them.</p>
        <div className="mt-3 max-h-52 space-y-2 overflow-y-auto">
          {saved.length === 0 && <div className="text-xs text-slate-500">No sessions yet.</div>}
          {saved.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md border border-slate-800 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-slate-200">{s.symbol} · {s.timeframe.toUpperCase()}</div>
                <div className="text-[10px] text-slate-500">{s.startISO.replace("T", " ").slice(0, 16)} UTC</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => void r.resumeSession(s)}>Resume</Button>
              <Button size="icon" variant="ghost" title="Delete session" onClick={() => { void r.deleteSession(s.id); setSaved((p) => p.filter((x) => x.id !== s.id)); }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls bar
// ---------------------------------------------------------------------------

export function ReplayControls({ r }: { r: ReplayApi }) {
  const [jumpISO, setJumpISO] = useState("");
  const progress = r.bars.length > 1 ? (r.cursor / (r.bars.length - 1)) * 100 : 0;
  const jumpMin = r.session
    ? new Date(r.bars[0]?.time ? r.bars[0].time * 1000 : Date.now()).toISOString().slice(0, 16)
    : "";
  const jumpMax = r.session
    ? new Date((r.bars[r.bars.length - 1]?.time ?? 0) * 1000).toISOString().slice(0, 16)
    : "";

  return (
    <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
          <HistoryIcon className="h-4 w-4 text-sky-400" /> Replay
          {r.session && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
              {r.session.symbol} · {r.session.timeframe.toUpperCase()}
            </span>
          )}
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Balance</span>
          <span className="font-semibold tabular-nums text-slate-100">${money(r.wallet.balance)}</span>
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Equity</span>
          <span className={cn("font-semibold tabular-nums", r.equity >= r.wallet.balance ? "text-emerald-400" : "text-red-400")}>${money(r.equity)}</span>
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Closed</span>
          <span className="font-semibold tabular-nums text-slate-100">{r.wallet.closed.length}</span>
        </span>
        <span className="ml-auto text-[10px] text-slate-500">Isolated wallet — live accounts untouched</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="outline" title="Jump to start" onClick={() => r.jumpTo(new Date(r.bars[0].time * 1000).toISOString())}>
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="outline" title="Step backward one candle (trades made later are discarded)" onClick={r.stepBackward}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {r.playing ? (
          <Button size="icon" variant="outline" title="Pause" onClick={r.pause}>
            <Pause className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="icon" variant="outline" title="Play — automatically advance candles" onClick={r.play}>
            <Play className="h-4 w-4" />
          </Button>
        )}
        <Button size="icon" variant="outline" title="Step forward one candle" onClick={r.stepForward}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="outline" title="Jump to end of loaded history" onClick={() => r.jumpTo(new Date(r.bars[r.bars.length - 1].time * 1000).toISOString())}>
          <ChevronsRight className="h-4 w-4" />
        </Button>
        <div className="mx-1 flex items-center gap-0.5 rounded-md border border-slate-700/70 p-0.5">
          {REPLAY_SPEEDS.map((s) => (
            <button
              key={s} onClick={() => r.setSpeed(s as ReplaySpeed)}
              className={cn(
                "rounded px-1.5 py-1 text-[10px] font-semibold",
                r.speed === s ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200",
              )}
            >{s}x</button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-slate-500">
          <span>1x ≈ 2s per candle</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="datetime-local" value={jumpISO} min={jumpMin} max={jumpMax}
            onChange={(e) => setJumpISO(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
            title="Jump to a specific date & time"
          />
          <Button size="sm" variant="outline" disabled={!jumpISO} onClick={() => { r.jumpTo(jumpISO); }}>
            Jump
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <span className="text-[10px] tabular-nums text-slate-500">
          candle {r.cursor + 1}/{r.bars.length} · {clockOf(r.simTime)}{r.capped ? " · capped at 20k candles" : ""}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order ticket
// ---------------------------------------------------------------------------

export function ReplayTicket({ r }: { r: ReplayApi }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit" | "stop">("market");
  const [price, setPrice] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");

  const submit = (pending: boolean) => {
    const l = r.lots;
    const slN = sl ? Number(sl) : null;
    const tpN = tp ? Number(tp) : null;
    if (pending) {
      if (!price) { toast({ title: "Trigger price required", variant: "destructive" }); return; }
      const res = r.placePending(side, kind as "limit" | "stop", Number(price), l, slN, tpN);
      if (res.ok) toast({ title: `${kind.toUpperCase()} ${side} placed at ${price}` });
      else toast({ title: "Order rejected", description: (res as any).error, variant: "destructive" });
    } else {
      const res = r.openMarket(side, l, slN, tpN);
      if (res.ok) toast({ title: `${side.toUpperCase()} ${l} ${r.session?.symbol} filled` });
      else toast({ title: "Order rejected", description: (res as any).error, variant: "destructive" });
    }
    setSl(""); setTp(""); setPrice("");
  };

  const ask = r.exitPriceAt("buy");
  const bid = r.exitPriceAt("sell");

  return (
    <div className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-100">Order ticket</span>
        <span className="text-[10px] text-slate-500">{r.session?.symbol}</span>
      </div>
      <div className="flex justify-between rounded-md border border-slate-800 px-2 py-1 text-xs">
        <span className="text-slate-500">Bid <span className="font-semibold text-slate-200 tabular-nums">{bid != null ? bid.toFixed(2) : "—"}</span></span>
        <span className="text-slate-500">Ask <span className="font-semibold text-slate-200 tabular-nums">{ask != null ? ask.toFixed(2) : "—"}</span></span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setSide("buy")}
          className={cn("rounded-md py-2 text-sm font-semibold", side === "buy" ? "bg-emerald-600 text-white" : "border border-slate-700 text-slate-300")}
        >BUY / Long</button>
        <button
          onClick={() => setSide("sell")}
          className={cn("rounded-md py-2 text-sm font-semibold", side === "sell" ? "bg-red-600 text-white" : "border border-slate-700 text-slate-300")}
        >SELL / Short</button>
      </div>
      <div className="flex gap-1">
        {(["market", "limit", "stop"] as const).map((k) => (
          <button
            key={k} onClick={() => setKind(k)}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs font-medium capitalize",
              kind === k ? "bg-slate-700 text-white" : "border border-slate-800 text-slate-400",
            )}
          >{k}</button>
        ))}
      </div>
      <Field label="Lots">
        <input
          type="number" value={r.lots} min={0.01} max={100} step={0.01}
          onChange={(e) => r.setLots(Math.max(0.01, Number(e.target.value) || 0.01))}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
        />
      </Field>
      {kind !== "market" && (
        <Field label={`Trigger price (${kind === "limit" ? (side === "buy" ? "below ask" : "above bid") : (side === "buy" ? "above ask" : "below bid")})`}>
          <input
            type="number" value={price} onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00" className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Stop loss">
          <input type="number" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="optional"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" />
        </Field>
        <Field label="Take profit">
          <input type="number" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="optional"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" />
        </Field>
      </div>
      <Field label="Commission per lot ($)">
        <input
          type="number" value={r.commissionPerLot} min={0} max={50} step={0.5}
          onChange={(e) => r.setCommissionPerLot(Math.max(0, Number(e.target.value) || 0))}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
        />
      </Field>
      {kind === "market" ? (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => submit(false)} className="rounded-md bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-500">
            BUY {r.lots.toFixed(2)}
          </button>
          <button onClick={() => submit(false)} className="rounded-md bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-500">
            SELL {r.lots.toFixed(2)}
          </button>
        </div>
      ) : (
        <Button onClick={() => submit(true)} className="bg-sky-600 hover:bg-sky-500">
          Place {kind} order
        </Button>
      )}
      <div className="rounded-md border border-slate-800 px-2 py-1.5 text-[10px] leading-relaxed text-slate-500">
        SL / TP evaluate on every revealed candle (conservative intra-bar path —
        if both sit inside one candle, the stop fires first). Pending orders fill
        at the trigger price or the open when gapped through.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Replay book — positions / orders / closed
// ---------------------------------------------------------------------------

export function ReplayBook({ r }: { r: ReplayApi }) {
  const [tab, setTab] = useState<"positions" | "orders" | "closed">("positions");
  const tabs = [
    { id: "positions" as const, label: `Positions (${r.wallet.positions.length})` },
    { id: "orders" as const, label: `Orders (${r.wallet.orders.length})` },
    { id: "closed" as const, label: `Closed (${r.wallet.closed.length})` },
  ];
  return (
    <div className="flex h-[210px] shrink-0 flex-col rounded-lg border border-slate-800 bg-slate-900/60">
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.id} onClick={() => setTab(t.id)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium",
              tab === t.id ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200",
            )}
          >{t.label}</button>
        ))}
        <span className="ml-auto text-[10px] text-slate-500">
          Win rate {r.stats.winRate}% · PF {r.stats.profitFactor === Infinity ? "∞" : r.stats.profitFactor} · Net ${money(r.stats.netProfit)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase text-slate-500">
              <tr>
                <th className="px-2 py-1 text-left">Side</th><th className="px-2 py-1 text-left">Symbol</th>
                <th className="px-2 py-1 text-right">Lots</th><th className="px-2 py-1 text-right">Entry</th>
                <th className="px-2 py-1 text-right">SL</th><th className="px-2 py-1 text-right">TP</th>
                <th className="px-2 py-1 text-right">Current</th><th className="px-2 py-1 text-right">P/L</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {r.wallet.positions.length === 0 && <EmptyRow cols={9} text="No open positions — place a trade while the replay runs." />}
              {r.wallet.positions.map((p) => {
                const spec = getInstrument(p.symbol);
                const cur = r.exitPriceAt(p.side);
                const pnl = spec && cur != null
                  ? positionPnlUsd(spec, p.side, p.lots, p.entry, cur, { [p.symbol]: r.currentPrice ?? cur })
                  : 0;
                return (
                  <tr key={p.id} className="border-t border-slate-800/60">
                    <td className={cn("px-2 py-1 font-semibold", p.side === "buy" ? "text-emerald-400" : "text-red-400")}>{p.side.toUpperCase()}</td>
                    <td className="px-2 py-1 text-slate-300">{p.symbol}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-300">{p.lots.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-300">{p.entry.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-400">{p.sl?.toFixed(2) ?? "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-400">{p.tp?.toFixed(2) ?? "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-300">{cur?.toFixed(2) ?? "—"}</td>
                    <td className={cn("px-2 py-1 text-right font-semibold tabular-nums", pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Button size="sm" variant="outline" onClick={() => { const res = r.closePosition(p.id); if (!res.ok) toast({ title: "Close failed", description: (res as any).error, variant: "destructive" }); }}>Close</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === "orders" && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase text-slate-500">
              <tr>
                <th className="px-2 py-1 text-left">Type</th><th className="px-2 py-1 text-left">Side</th>
                <th className="px-2 py-1 text-right">Lots</th><th className="px-2 py-1 text-right">Trigger</th>
                <th className="px-2 py-1 text-right">SL</th><th className="px-2 py-1 text-right">TP</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {r.wallet.orders.length === 0 && <EmptyRow cols={7} text="No pending orders." />}
              {r.wallet.orders.map((o) => (
                <tr key={o.id} className="border-t border-slate-800/60">
                  <td className="px-2 py-1 font-medium capitalize text-amber-400">{o.kind}</td>
                  <td className={cn("px-2 py-1 font-semibold", o.side === "buy" ? "text-emerald-400" : "text-red-400")}>{o.side.toUpperCase()}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-300">{o.lots.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-300">{o.price.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-400">{o.sl?.toFixed(2) ?? "—"}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-400">{o.tp?.toFixed(2) ?? "—"}</td>
                  <td className="px-2 py-1 text-right">
                    <Button size="sm" variant="outline" onClick={() => r.cancelOrder(o.id)}>Cancel</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "closed" && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase text-slate-500">
              <tr>
                <th className="px-2 py-1 text-left">Side</th><th className="px-2 py-1 text-left">Symbol</th>
                <th className="px-2 py-1 text-right">Lots</th><th className="px-2 py-1 text-right">Entry</th>
                <th className="px-2 py-1 text-right">Exit</th><th className="px-2 py-1 text-right">P/L</th>
                <th className="px-2 py-1 text-left">Reason</th><th className="px-2 py-1 text-left">Closed</th>
                <th className="px-2 py-1 text-left">Journal</th>
              </tr>
            </thead>
            <tbody>
              {r.wallet.closed.length === 0 && <EmptyRow cols={9} text="No closed trades yet." />}
              {[...r.wallet.closed].reverse().map((t) => (
                <tr key={`${t.id}-${t.closedAt}`} className="border-t border-slate-800/60">
                  <td className={cn("px-2 py-1 font-semibold", t.side === "buy" ? "text-emerald-400" : "text-red-400")}>{t.side.toUpperCase()}</td>
                  <td className="px-2 py-1 text-slate-300">{t.symbol}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-300">{t.lots.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-300">{t.entry.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-300">{t.exit.toFixed(2)}</td>
                  <td className={cn("px-2 py-1 text-right font-semibold tabular-nums", t.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {t.pnl >= 0 ? "+" : "−"}${money(Math.abs(t.pnl))}
                  </td>
                  <td className="px-2 py-1 uppercase text-slate-400">{t.reason}</td>
                  <td className="px-2 py-1 text-slate-500">{new Date(t.closedAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="px-2 py-1 text-slate-500"><BookMarked className="h-3.5 w-3.5 text-emerald-500" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EmptyRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-xs text-slate-500">{text}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Journal auto-save for replay closes
// ---------------------------------------------------------------------------

async function saveClosedTrade(
  ev: { trade: any; sessionId: string },
  chartBox: HTMLElement | null,
  saving: Set<string>,
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const t = ev.trade;
  const key = `${ev.sessionId}:${t.id}:${t.closedAt}`;
  if (saving.has(key)) return;
  saving.add(key);
  try {
    // Dedupe in localStorage per uid (the RTDB marker node needs rules that
    // may not be deployed yet; the journal itself lives in trades/{uid} which
    // is always writable).
    const lsKey = `it_replay_journal_${uid}`;
    const seen: string[] = (() => { try { return JSON.parse(localStorage.getItem(lsKey) || "[]"); } catch { return []; } })();
    if (seen.includes(key)) return;
    const spec = (await import("@shared/terminal")).getInstrument(t.symbol);
    const screenshot = captureChart(chartBox);
    await push(dbRef(db, `trades/${uid}`), {
      assetName: spec?.name ?? t.symbol,
      instrumentSymbol: t.symbol,
      instrumentName: spec?.name ?? t.symbol,
      entryPrice: t.entry,
      exitPrice: t.exit,
      lotSize: t.lots,
      profit: t.pnl,
      type: t.side === "buy" ? "BUY" : "SELL",
      category: spec?.assetClass === "crypto" ? "CRYPTO" : "FOREX",
      timestamp: t.closedAt,
      exitTime: t.closedAt,
      slPrice: t.sl ?? null,
      tpPrice: t.tp ?? null,
      emotion: t.pnl >= 0 ? "happy" : "neutral",
      comment: `Replay session ${ev.sessionId} · closed by ${t.reason}`,
      replay: true,
      replaySessionId: ev.sessionId,
      imageBase64: screenshot ?? undefined,
    });
    seen.push(key);
    try { localStorage.setItem(lsKey, JSON.stringify(seen.slice(-500))); } catch { /* quota */ }
    toast({ title: "Replay trade saved to journal", description: `${t.side.toUpperCase()} ${t.symbol} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} USD` });
  } catch { /* journal save is best-effort */ }
}

/** Downscaled JPEG snapshot of the replay chart for the journal entry. */
function captureChart(box: HTMLElement | null): string | null {
  try {
    const canvas = box?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return null;
    const w = 720;
    const h = Math.round((canvas.height / canvas.width) * w);
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, w, h);
    return off.toDataURL("image/jpeg", 0.55);
  } catch { return null; }
}
