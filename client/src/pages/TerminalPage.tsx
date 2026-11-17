/**
 * InspireTrade Terminal — the main trading workspace page.
 *
 * One terminal, six modes (segmented switcher in the toolbar):
 *   - LIVE      : server-authoritative virtual trading (unchanged Phase 1-3 UI)
 *   - REPLAY    : historical bar-by-bar replay on real candles with an
 *                 isolated replay wallet (shared bar-step broker)
 *   - BACKTEST  : deterministic strategy testing over real history
 *   - ANALYTICS : statistics computed from the journaled trades
 *   - CALENDAR  : economic calendar + history + sessions + alerts (Phase 5)
 *   - NEWS      : live market news feed with categories/search (Phase 5)
 *
 *   - live mode: order ticket (TradingPanel) on the right, TradingBlotter below
 *   - replay mode: replay ticket + replay book + playback controls; the chart
 *     only ever receives bars up to the replay cursor (the future is hidden)
 *   - live & replay: the EventStrip shows upcoming high-impact releases for
 *     the instrument's currencies with a countdown and optional warnings
 * Every live mutation hits the server; the client never touches live balances.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { INSTRUMENTS, TIMEFRAMES, type Timeframe } from "@shared/terminal";
import { useTrading } from "@/hooks/use-trading";
import { useReplay } from "@/hooks/use-replay";
import { PriceChart, type PriceMark } from "@/components/terminal/PriceChart";
import { TradingPanel } from "@/components/terminal/TradingPanel";
import { TradingBlotter } from "@/components/terminal/TradingBlotter";
import { Watchlist } from "@/components/terminal/Watchlist";
import { TerminalShell } from "@/components/terminal/TerminalShell";
import { NewAccountDialog } from "@/components/terminal/NewAccountDialog";
import {
  ReplayOverlay, ReplayBadge, ReplayControls, ReplayTicket, ReplayBook, useReplayJournalAutoSave,
} from "@/components/terminal/ReplayWorkspace";
import BacktestWorkspace from "@/components/terminal/BacktestWorkspace";
import AnalyticsWorkspace from "@/components/terminal/AnalyticsWorkspace";
import CalendarWorkspace from "@/components/terminal/CalendarWorkspace";
import NewsWorkspace from "@/components/terminal/NewsWorkspace";
import EventStrip from "@/components/terminal/EventStrip";
import { useEventWarning, useEconWarnSettings } from "@/hooks/use-terminal-econ";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Plus, RefreshCw, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

const SYMBOL_KEY = "it_terminal_symbol";
const TF_KEY = "it_terminal_tf";
const MODE_KEY = "it_terminal_mode";

type TerminalMode = "live" | "replay" | "backtest" | "analytics" | "calendar" | "news";
const MODES: { id: TerminalMode; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "replay", label: "Replay" },
  { id: "backtest", label: "Backtest" },
  { id: "analytics", label: "Analytics" },
  { id: "calendar", label: "Calendar" },
  { id: "news", label: "News" },
];

const ASSET_CLASSES = [
  { id: "crypto", label: "Crypto" },
  { id: "metal", label: "Metals" },
  { id: "forex", label: "Forex" },
  { id: "index", label: "Indices" },
] as const;

export default function TerminalPage() {
  const {
    accounts, account, positions, orders, metrics,
    loading, busy, setActiveId, resetAccount, refreshNow,
    modifyPosition,
  } = useTrading();
  const [newAccountOpen, setNewAccountOpen] = useState(false);
  const [mode, setMode] = useState<TerminalMode>(
    () => (localStorage.getItem(MODE_KEY) as TerminalMode) || "live",
  );

  const [symbol, setSymbol] = useState(() => localStorage.getItem(SYMBOL_KEY) || "BTCUSD");
  const [timeframe, setTimeframe] = useState<Timeframe>(
    () => (localStorage.getItem(TF_KEY) as Timeframe) || "5m",
  );

  useEffect(() => { localStorage.setItem(SYMBOL_KEY, symbol); }, [symbol]);
  useEffect(() => { localStorage.setItem(TF_KEY, timeframe); }, [timeframe]);
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  // replay state lives at the page level so the chart, ticket and book share it
  const r = useReplay();
  const chartBoxRef = useRef<HTMLDivElement | null>(null);
  useReplayJournalAutoSave(r, chartBoxRef);

  // Phase 5: high-impact event data for the strip + the OPT-IN confirmation
  // guard near major releases (only when the user enables it in the strip)
  const warnSettings = useEconWarnSettings();
  const eventWarn = useEventWarning(symbol);
  const eventGuard = mode === "live" && warnSettings.settings.confirmTrades && eventWarn
    ? { eventName: eventWarn.title, currency: eventWarn.currency, minutesUntil: eventWarn.minutesUntil }
    : null;

  // Chart price lines: pending-order levels of the selected symbol only.
  // Open positions render as draggable entry/SL/TP trade lines inside the chart.
  const marks = useMemo<PriceMark[]>(() => {
    if (mode === "replay") {
      const out: PriceMark[] = [];
      for (const o of r.wallet.orders) {
        out.push({ id: `o-${o.id}`, price: o.price, color: "#f59e0b", title: `${o.kind.toUpperCase()} ${o.lots.toFixed(2)}`, dashed: true });
      }
      return out;
    }
    const out: PriceMark[] = [];
    for (const o of orders) {
      if (o.symbol !== symbol) continue;
      out.push({ id: `o-${o.id}`, price: o.price, color: "#f59e0b", title: `${o.kind.toUpperCase()} ${o.lots.toFixed(2)}`, dashed: true });
    }
    return out;
  }, [mode, orders, symbol, r.wallet.orders]);

  const replayActive = r.phase === "ready";
  const chartSymbol = mode === "replay" && r.session ? r.session.symbol : symbol;
  const chartTf = (mode === "replay" && r.session ? r.session.timeframe : timeframe) as Timeframe;
  const chartPositions = mode === "replay"
    ? (replayActive ? r.wallet.positions.filter((p) => p.symbol === r.session?.symbol) as any[] : [])
    : positions.filter((p) => p.symbol === symbol);

  // ---- backtest / analytics / calendar / news: full-area workspaces ---------
  if (mode === "backtest" || mode === "analytics" || mode === "calendar" || mode === "news") {
    return (
      <div className="flex h-[calc(100dvh-4.25rem)] min-h-[640px] flex-col gap-2 p-2">
        <Toolbar
          mode={mode} onModeChange={setMode}
          symbol={symbol} onSymbolChange={setSymbol}
          timeframe={timeframe} onTimeframeChange={setTimeframe}
          accounts={[]} activeId={null} onAccountChange={setActiveId}
          metrics={null} busy={false} onRefresh={refreshNow}
          account={null} onReset={resetAccount}
          onNewAccount={() => setNewAccountOpen(true)}
        />
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30">
          {mode === "backtest" && <BacktestWorkspace />}
          {mode === "analytics" && <AnalyticsWorkspace />}
          {mode === "calendar" && <CalendarWorkspace symbol={symbol} />}
          {mode === "news" && <NewsWorkspace />}
        </div>
        <NewAccountDialog open={newAccountOpen} onClose={() => setNewAccountOpen(false)} />
      </div>
    );
  }

  // ---- loading gate (live account) ------------------------------------------
  if (loading && !account && mode === "live") {
    return (
      <div className="flex h-[60vh] items-center justify-center text-sm text-slate-400">
        Loading trading account…
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-4.25rem)] min-h-[640px] flex-col gap-2 p-2">
      <Toolbar
        mode={mode} onModeChange={setMode}
        symbol={symbol} onSymbolChange={setSymbol}
        timeframe={timeframe} onTimeframeChange={setTimeframe}
        accounts={mode === "live" ? accounts : []} activeId={account?.id ?? null} onAccountChange={setActiveId}
        metrics={mode === "live" ? metrics : null} busy={busy} onRefresh={refreshNow}
        account={mode === "live" ? account : null} onReset={resetAccount}
        onNewAccount={() => setNewAccountOpen(true)}
      />
      {/* Phase 5 event strip: upcoming high-impact releases + relevant news */}
      <EventStrip symbol={chartSymbol} onOpenCalendar={() => setMode("calendar")} />

      {mode === "live" ? (
        <TerminalShell
          watchlist={<Watchlist symbol={symbol} onSymbolChange={setSymbol} />}
          chart={
            <div ref={chartBoxRef} className="relative h-full min-h-0 w-full overflow-hidden rounded-lg border border-slate-800 bg-[#0b1220]">
              <PriceChart
                symbol={chartSymbol}
                timeframe={chartTf}
                marks={marks}
                accountId={account?.id ?? null}
                positions={chartPositions}
                onModifyPosition={modifyPosition}
                onSymbolChange={setSymbol}
                onTimeframeChange={setTimeframe}
              />
            </div>
          }
          ticket={
            <TradingPanel
              symbol={symbol}
              eventGuard={eventGuard}
              className="h-full w-full overflow-y-auto"
            />
          }
          blotter={<TradingBlotter symbol={symbol} className="h-full w-full" />}
        />
      ) : (
        <>
          {/* chart + replay ticket */}
          <div className="flex min-h-0 flex-[3] gap-2">
            <div ref={chartBoxRef} className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-800 bg-[#0b1220]">
              <PriceChart
                symbol={chartSymbol}
                timeframe={chartTf}
                marks={marks}
                accountId={null}
                positions={chartPositions}
                onModifyPosition={async (positionId, patch) => { r.modifyPosition(positionId, patch); }}
                onSymbolChange={() => { /* session-bound in replay */ }}
                onTimeframeChange={() => { /* session-bound in replay */ }}
                replayBars={mode === "replay" && replayActive ? r.bars : null}
                replayCursor={mode === "replay" && replayActive ? r.cursor : null}
                replayForming={mode === "replay" && replayActive ? r.forming?.bar ?? null : null}
                replayStatus={mode === "replay" && replayActive ? `REPLAY · ${r.session!.timeframe.toUpperCase()} · ${r.playing ? "playing" : "paused"}` : null}
              />
              {mode === "replay" && replayActive && <ReplayBadge />}
              {mode === "replay" && !replayActive && (
                <ReplayOverlay r={r} symbol={symbol} timeframe={timeframe} />
              )}
            </div>
            <ReplayTicket r={r} />
          </div>
          <ReplayControls r={r} />
          <ReplayBook r={r} />
        </>
      )}
      <NewAccountDialog open={newAccountOpen} onClose={() => setNewAccountOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar: mode switcher, instrument picker, timeframes, account strip
// ---------------------------------------------------------------------------

function Toolbar({
  mode, onModeChange,
  symbol, onSymbolChange, timeframe, onTimeframeChange,
  accounts, activeId, onAccountChange,
  metrics, busy, onRefresh, account, onReset, onNewAccount,
}: {
  mode: TerminalMode; onModeChange: (m: TerminalMode) => void;
  symbol: string; onSymbolChange: (s: string) => void;
  timeframe: Timeframe; onTimeframeChange: (tf: Timeframe) => void;
  accounts: { id: string; label: string; type: string }[];
  activeId: string | null; onAccountChange: (id: string) => void;
  metrics: { balance: number; equity: number; floatingPnl: number; usedMargin: number; freeMargin: number; marginLevel: number | null } | null;
  busy: boolean; onRefresh: () => void;
  account: { id: string; label: string } | null; onReset: () => void;
  onNewAccount: () => void;
}) {
  const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnl = metrics?.floatingPnl ?? 0;
  const liveOnly = mode === "live";
  const showMarkets = mode === "live" || mode === "replay";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5">
      {/* terminal mode switcher */}
      <div className="flex items-center gap-0.5 rounded-md border border-sky-700/60 bg-sky-950/40 p-0.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => onModeChange(m.id)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
              mode === m.id ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {showMarkets && (
        <>
          <div className={cn(mode === "replay" && "pointer-events-none opacity-60")} title={mode === "replay" ? "The replay session is bound to the instrument chosen at start" : undefined}>
            <Select value={symbol} onValueChange={onSymbolChange}>
              <SelectTrigger className="w-[170px] font-semibold">
                <SelectValue placeholder="Symbol" />
              </SelectTrigger>
              <SelectContent>
                {ASSET_CLASSES.map((c) => (
                  <SelectGroup key={c.id}>
                    <SelectLabel>{c.label}</SelectLabel>
                    {INSTRUMENTS.filter((i) => i.assetClass === c.id).map((i) => (
                      <SelectItem key={i.symbol} value={i.symbol}>
                        {i.symbol} <span className="ml-1 text-xs text-slate-400">{i.name}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={cn("flex items-center gap-0.5 rounded-md border border-slate-700/70 p-0.5", mode === "replay" && "pointer-events-none opacity-60")}>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => onTimeframeChange(tf)}
                className={cn(
                  "rounded px-2 py-1 text-xs font-medium transition-colors",
                  tf === timeframe ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200",
                )}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      )}

      {(liveOnly || mode === "replay") && <div className="mx-1 hidden h-6 w-px bg-slate-700 sm:block" />}

      {/* Account strip — server metrics, refreshed by the 10s heartbeat (live only) */}
      {liveOnly && account && (
        <Select value={activeId ?? undefined} onValueChange={onAccountChange}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {liveOnly && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <Stat label="Balance" value={metrics ? `$${money(metrics.balance)}` : "—"} />
          <Stat label="Equity" value={metrics ? `$${money(metrics.equity)}` : "—"} />
          <Stat
            label="Floating P/L"
            value={metrics ? `${pnl >= 0 ? "+" : "−"}$${money(Math.abs(pnl))}` : "—"}
            className={pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : undefined}
          />
          <Stat label="Used margin" value={metrics ? `$${money(metrics.usedMargin)}` : "—"} />
          <Stat label="Free margin" value={metrics ? `$${money(metrics.freeMargin)}` : "—"} />
          {metrics?.marginLevel != null && (
            <Stat label="Margin level" value={`${metrics.marginLevel.toFixed(0)}%`} />
          )}
        </div>
      )}

      {mode === "replay" && (
        <div className="text-[10px] text-slate-500">
          Replay wallet is configured in the chart overlay — the future is always hidden.
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {liveOnly && (
          <>
            <Button variant="outline" size="icon" onClick={onNewAccount} title="New DEMO / challenge account">
              <Plus className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={busy} title="Refresh account">
              <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="icon" disabled={busy || !account} title="Reset account to starting balance">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    All open positions, orders and history of “{account?.label}” are wiped and the balance
                    goes back to its starting amount. A failed challenge returns to Active status.
                    This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onReset}>Reset</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className={cn("font-semibold text-slate-100 tabular-nums", className)}>{value}</span>
    </div>
  );
}
