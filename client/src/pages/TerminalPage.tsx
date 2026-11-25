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
import { MarketInfoPanel } from "@/components/terminal/MarketInfoPanel";
import { TerminalShell, type ShellPanel } from "@/components/terminal/TerminalShell";
import AlertsPanel from "@/components/terminal/AlertsPanel";
import { NewAccountDialog } from "@/components/terminal/NewAccountDialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { MoreVertical } from "lucide-react";
import {
  ReplayBadge, ReplayControls, ReplayTicket, ReplayBook, useReplayJournalAutoSave,
} from "@/components/terminal/ReplayWorkspace";
import { useToast } from "@/hooks/use-toast";
import { validateReplayStart } from "@shared/replay-engine";
import { historyAvailability } from "@/lib/history-loader";
import CalendarWorkspace from "@/components/terminal/CalendarWorkspace";
import NewsWorkspace from "@/components/terminal/NewsWorkspace";
import EventStrip from "@/components/terminal/EventStrip";
import { useEventWarning, useEconWarnSettings } from "@/hooks/use-terminal-econ";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Plus, RefreshCw, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { InstrumentSettingsPanel } from "@/components/terminal/InstrumentSettingsPanel";
import { MultiChartWorkspace, LayoutPicker } from "@/components/terminal/MultiChartWorkspace";
import type { LayoutId } from "@/lib/chart-layouts";
import { loadShortcuts, matchesShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { InstrumentExplorer } from "@/components/terminal/InstrumentExplorer";
import { getTerminalSettings } from "@/lib/terminal-settings";
import { getInstrumentSettings } from "@/lib/instrument-settings";
import { touchRecent } from "@/lib/watchlists";
import { getInstrument, availableTimeframes, TF_SECONDS } from "@shared/terminal";

const SYMBOL_KEY = "it_terminal_symbol";
const TF_KEY = "it_terminal_tf";
const MODE_KEY = "it_terminal_mode";
const PANEL_KEY = "it_terminal_panel";

type TerminalMode = "live" | "calendar" | "news";
const MODES: { id: TerminalMode; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "calendar", label: "Calendar" },
  { id: "news", label: "News" },
];
// P76 — bar replay is no longer a separate terminal mode: it runs INSIDE the
// live chart (toolbar replay button → click a candle → playback bar below the
// chart). A stale "replay" value in localStorage simply falls back to "live".

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
    modifyPosition, modifyOrder, cancelOrder, closePosition,
  } = useTrading();
  const [newAccountOpen, setNewAccountOpen] = useState(false);
  const { toast } = useToast();
  const [mode, setMode] = useState<TerminalMode>((() => { const saved = localStorage.getItem(MODE_KEY) as TerminalMode | null; return saved && MODES.some((mm) => mm.id === saved) ? saved : "live"; })());
  // right rail panel (watchlist / ticket / alerts / info) — persisted
  // P56 UX — the 6-layout grid picker now lives in the events strip; the
  // workspace owns the same state through layout/onLayoutChange
  const [mcLayout, setMcLayout] = useState<LayoutId>(() => {
    try { const v = localStorage.getItem("it_mc_layout") as LayoutId | null; if (v) return v; } catch { /* ignore */ }
    return "1";
  });
  useEffect(() => { try { localStorage.setItem("it_mc_layout", mcLayout); } catch { /* ignore */ } }, [mcLayout]);

  // user request: the terminal ALWAYS opens with no watchlist/ticket panel
  // open (the reference screenshot state); the rail is one click away
  const [rightPanel, setRightPanel] = useState<ShellPanel>(null);
  const selectPanel = (p: ShellPanel) => {
    setRightPanel(p);
    try { if (p) localStorage.setItem(PANEL_KEY, p); else localStorage.removeItem(PANEL_KEY); } catch { /* private mode */ }
  };

  const [symbol, setSymbolRaw] = useState(() => localStorage.getItem(SYMBOL_KEY) || getTerminalSettings().general.defaultSymbol);
  const [timeframe, setTimeframeRaw] = useState<Timeframe>(() => {
    const sym = localStorage.getItem(SYMBOL_KEY) || getTerminalSettings().general.defaultSymbol;
    // the instrument's own default timeframe wins, then the last session's
    // choice, then the global default (Phase 21 per-instrument settings) —
    // anything the instrument genuinely cannot serve falls back to 5m
    const pick = (tf: Timeframe | undefined | null) => tf && availableTimeframes(sym).includes(tf) ? tf : null;
    return pick(getInstrumentSettings(sym).timeframe as Timeframe | undefined)
      || pick(localStorage.getItem(TF_KEY) as Timeframe | undefined)
      || pick(getTerminalSettings().general.defaultTf)
      || "5m";
  });
  // switching instruments applies THAT instrument's own timeframe default
  const setSymbol = (s: string) => {
    setSymbolRaw(s);
    touchRecent(s);
    const per = getInstrumentSettings(s).timeframe as Timeframe | undefined;
    if (per && availableTimeframes(s).includes(per)) setTimeframeRaw(per);
    else if (!availableTimeframes(s).includes(timeframe)) {
      // the current TF may be unsupported on the new instrument (e.g. 1s on FX)
      const tfs = availableTimeframes(s);
      setTimeframeRaw(tfs[Math.min(4, tfs.length - 1)]); // fall back to 1m/5m range
    }
  };
  const setTimeframe = (tf: Timeframe) => setTimeframeRaw(tf);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  // P55 §11 — panel shortcuts (openTicket / openWatchlist / openAlerts) toggle
  // the right rail; a second press on the active panel's shortcut closes it
  useEffect(() => {
    const h = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (action === "openTicket") selectPanel(rightPanel === "ticket" ? null : "ticket");
      else if (action === "openWatchlist") selectPanel(rightPanel === "watchlist" ? null : "watchlist");
      else if (action === "openAlerts") selectPanel(rightPanel === "alerts" ? null : "alerts");
      else return;
    };
    window.addEventListener("it-shortcut", h);
    return () => window.removeEventListener("it-shortcut", h);
  });

  useEffect(() => { localStorage.setItem(SYMBOL_KEY, symbol); }, [symbol]);
  useEffect(() => { localStorage.setItem(TF_KEY, timeframe); }, [timeframe]);
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  // TradingView-style timeframe hotkeys — the number row switches timeframes
  // (1m 3m 5m 15m 30m 1h 2h 4h 1d 1W; "0" = 10th). Skips text inputs and
  // modifier combos so typing and system shortcuts stay untouched.
  // P55 §11 — PLUS the customizable action bindings: a matching key presses
  // the action through a window event (ticket/panel listeners act on it).
  // P55 §9 — interface visibility prefs (Terminal settings → Look & feel)
  const [interface_, setInterface_] = useState(() => getTerminalSettings().interface);
  useEffect(() => {
    const refresh = () => setInterface_(getTerminalSettings().interface);
    window.addEventListener("it-terminal-settings-changed", refresh);
    return () => window.removeEventListener("it-terminal-settings-changed", refresh);
  }, []);
  const shortcutsRef = useRef(loadShortcuts());
  useEffect(() => {
    const refresh = () => { shortcutsRef.current = loadShortcuts(); };
    window.addEventListener("it-shortcuts-changed", refresh);
    return () => window.removeEventListener("it-shortcuts-changed", refresh);
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement | null)?.isContentEditable) return;
      // P55 §11 — customizable actions first (may carry modifiers)
      for (const [action, binding] of Object.entries(shortcutsRef.current)) {
        if (binding && matchesShortcut(e, binding)) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("it-shortcut", { detail: { action } }));
          return;
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const idx = "1234567890".indexOf(e.key);
      const tfs = availableTimeframes(symbolRef.current); if (idx < 0 || idx >= tfs.length) return;
      setTimeframeRaw(tfs[idx]);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Phase 21 — the full instrument explorer (the terminal settings dialog is
  // reachable from the chart toolbar's General settings gear — the duplicate
  // top-bar button was removed per user request)
  const [explorerOpen, setExplorerOpen] = useState(false);
  // Phase 34: per-instrument settings sheet (chart type, price, appearance)
  const [instSettingsOpen, setInstSettingsOpen] = useState(false);

  // replay state lives at the page level so the chart, ticket and book share it
  const r = useReplay();
  const chartBoxRef = useRef<HTMLDivElement | null>(null);
  useReplayJournalAutoSave(r, chartBoxRef);
  // P76 — chart-integrated bar replay: the toolbar button arms candle
  // selection on the PRIMARY chart; clicking a historical candle starts the
  // session; the playback bar renders below the chart; exit restores live.
  const [replaySelectOpen, setReplaySelectOpen] = useState(false);
  const replayActive = r.phase === "ready";

  const startReplayFromCandle = async (timeSec: number) => {
    setReplaySelectOpen(false);
    const err = validateReplayStart(
      timeSec, TF_SECONDS[chartTf] ?? 300, historyAvailability(symbol, chartTf).maxDaysBack, Date.now(),
    );
    if (err) { toast({ title: "Replay start rejected", description: err, variant: "destructive" }); return; }
    const res = await r.startFromCandle(symbol, chartTf, timeSec, 100000);
    if (!res.ok) toast({ title: "Replay failed to start", description: res.error ?? "history load error", variant: "destructive" });
  };
  const exitReplay = () => { setReplaySelectOpen(false); r.exitReplay(); };

  // P76 — keyboard shortcuts, only while replay selection or a session is on:
  // Space play/pause · ←/→ step back/forward · Esc cancel/exit. Guarded
  // against text inputs, dialogs and drawing-tool text fields.
  useEffect(() => {
    if (!replaySelectOpen && !replayActive) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (r.playing) r.pause(); else r.play();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        r.stepForward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        r.stepBackward();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (replaySelectOpen) setReplaySelectOpen(false);
        else exitReplay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaySelectOpen, replayActive, r.playing]);

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
    if (replayActive) {
      const out: PriceMark[] = [];
      for (const o of r.wallet.orders) {
        out.push({ id: `o-${o.id}`, price: o.price, color: "#f59e0b", title: `${o.kind.toUpperCase()} ${o.lots.toFixed(2)}`, dashed: true });
      }
      return out;
    }
    // PHASE 63 §6 — live pending orders render ONCE as draggable order-entry
    // TradeLines inside the chart; the duplicate PriceMark line is retired.
    // (Replay keeps its own marks — different wallet system.)
    void orders; void symbol;
    return [];
  }, [replayActive, orders, symbol, r.wallet.orders]);

  // during a replay session the chart is bound to the session's symbol/tf —
  // the toolbar pickers are locked (exit replay to switch, like TradingView)
  const chartSymbol = replayActive && r.session ? r.session.symbol : symbol;
  const chartTf = (replayActive && r.session ? r.session.timeframe : timeframe) as Timeframe;
  const chartPositions = replayActive
    ? r.wallet.positions.filter((p) => p.symbol === r.session?.symbol) as any[]
    : positions.filter((p) => p.symbol === symbol);

  // ---- backtest / analytics / calendar / news: full-area workspaces ---------
  if (mode === "calendar" || mode === "news") {
    return (
      <div data-term="1" className="flex h-[calc(100dvh-4.25rem-3.75rem-env(safe-area-inset-bottom))] min-h-0 flex-col gap-2 p-2 md:h-[calc(100dvh-4.25rem)] sm:min-h-[640px]">
        <Toolbar
          mode={mode} onModeChange={setMode}
          symbol={symbol} onSymbolChange={setSymbol}
          timeframe={timeframe} onTimeframeChange={setTimeframe}
          onOpenExplorer={() => setExplorerOpen(true)} onOpenInstrumentSettings={() => setInstSettingsOpen(true)}
          accounts={[]} activeId={null} onAccountChange={setActiveId}
          metrics={null} busy={false} onRefresh={refreshNow}
          account={null} onReset={resetAccount}
          onNewAccount={() => setNewAccountOpen(true)}
        />
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30">
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
      <div className="flex h-[60vh] items-center justify-center">
        <span className="text-sm text-slate-400">loading…</span>
      </div>
    );
  }

  return (
    /* P42 — data-term opts the LIVE terminal into the theme remap: panel
       chrome follows the site theme, while the chart canvas keeps its own
       dark background (the [data-chart-dark] subtree is excluded in CSS) */
    <div data-term="1" className="flex h-[calc(100dvh-4.25rem-3.75rem-env(safe-area-inset-bottom))] min-h-0 flex-col gap-2 p-2 md:h-[calc(100dvh-4.25rem)] sm:min-h-[640px]">
      <Toolbar
        mode={mode} onModeChange={setMode}
        symbol={symbol} onSymbolChange={setSymbol}
        timeframe={timeframe} onTimeframeChange={setTimeframe}
        onOpenExplorer={() => setExplorerOpen(true)} onOpenInstrumentSettings={() => setInstSettingsOpen(true)}
        accounts={mode === "live" ? accounts : []} activeId={account?.id ?? null} onAccountChange={setActiveId}
        metrics={mode === "live" ? metrics : null} busy={busy} onRefresh={refreshNow}
        account={mode === "live" ? account : null} onReset={resetAccount}
        onNewAccount={() => setNewAccountOpen(true)}
      />
      {/* Phase 5 event strip: upcoming high-impact releases + relevant news */}
      <EventStrip symbol={chartSymbol} rightSlot={<LayoutPicker layout={mcLayout} onChange={setMcLayout} />} />

      {/* P76 — compact playback bar directly below the chart area */}
      {replayActive && (
        <ReplayControls r={r} onExit={exitReplay} />
      )}
      {mode === "live" && (
        <TerminalShell
          activePanel={rightPanel}
          onPanelSelect={selectPanel}
          hideBlotter={!interface_?.bottomBlotter}
          hideRail={!interface_?.rightRail}
          panel={
            /* P76 — while a replay session runs, the right rail shows the
               isolated replay-wallet order ticket (the previous panel
               returns on exit) */
            replayActive ? <ReplayTicket r={r} className="h-full w-full overflow-y-auto" />
              : rightPanel === "watchlist" ? <Watchlist symbol={symbol} onSymbolChange={setSymbol} onBrowse={() => setExplorerOpen(true)} className="h-full w-full" />
              : rightPanel === "ticket" ? (
                <TradingPanel
                  symbol={symbol}
                  eventGuard={eventGuard}
                  className="h-full w-full overflow-y-auto"
                />
              )
              : rightPanel === "alerts" ? <div className="h-full w-full overflow-y-auto"><AlertsPanel /></div>
              : rightPanel === "info" ? (
                <div className="h-full w-full overflow-y-auto">
                  <p className="border-b border-slate-800 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">Instrument details</p>
                  <MarketInfoPanel symbol={symbol} timeframe={timeframe} />
                </div>
              )
              : null
          }
          chart={
            /* P48 — multi-chart workspace: layouts 1/2h/2v/3/4/6, resizable
               panels, optional sync + saved presets. The primary panel stays
               wired to the terminal state (ticket/blotter/watchlist), so the
               single-chart behavior is bit-for-bit preserved. P76 — the
               PRIMARY panel carries the replay selection + session props. */
            <div ref={chartBoxRef} className="relative h-full min-h-0 min-w-0 w-full overflow-hidden rounded-lg border border-slate-800 bg-[#0b1220]">
              <MultiChartWorkspace
                symbol={chartSymbol}
                timeframe={chartTf}
                onSymbolChange={setSymbol}
                onTimeframeChange={setTimeframe}
                orders={orders}
                positions={positions}
                accountId={account?.id ?? null}
                onModifyPosition={modifyPosition}
                onModifyOrder={modifyOrder}
                onCancelOrder={cancelOrder}
                onClosePosition={closePosition}
                accountBalance={metrics?.balance ?? null}
                onOpenAlerts={() => selectPanel("alerts")}
                onOpenReplay={() => { if (!replayActive) setReplaySelectOpen(true); }}
                layout={mcLayout}
                onLayoutChange={setMcLayout}
                /* P76 — replay state flows ONLY into the primary panel */
                replaySelect={replaySelectOpen && !replayActive}
                onReplaySelect={startReplayFromCandle}
                onReplaySelectCancel={() => setReplaySelectOpen(false)}
                replayBars={replayActive ? r.bars : null}
                replayCursor={replayActive ? r.cursor : null}
                replayForming={replayActive ? r.forming?.bar ?? null : null}
                replayStatus={replayActive ? `REPLAY · ${r.session!.timeframe.toUpperCase()} · ${r.playing ? "playing" : "paused"}` : null}
                replayPositions={replayActive ? (chartPositions as any[]) : null}
                replayMarks={replayActive ? marks : null}
              />
              {replayActive && <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2"><ReplayBadge status={`REPLAY · ${r.session!.timeframe.toUpperCase()} · ${r.playing ? "playing" : "paused"}`} /></div>}
            </div>
          }
          blotter={
            /* P76 — the bottom blotter shows the replay wallet book during a
               session (positions / orders / closed); live blotter on exit */
            replayActive ? <ReplayBook r={r} className="h-full w-full" />
              : <TradingBlotter symbol={symbol} className="h-full w-full" />
          }
        />
      )}
      <NewAccountDialog open={newAccountOpen} onClose={() => setNewAccountOpen(false)} />
      <InstrumentExplorer
        open={explorerOpen}
        current={symbol}
        onClose={() => setExplorerOpen(false)}
        onSelect={setSymbol}
      />
      <InstrumentSettingsPanel symbol={symbol} open={instSettingsOpen} onClose={() => setInstSettingsOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar: mode switcher, instrument picker, timeframes, account strip
// ---------------------------------------------------------------------------

function Toolbar({
  mode, onModeChange,
  symbol, onSymbolChange, timeframe, onTimeframeChange,
  onOpenExplorer, onOpenInstrumentSettings,
  accounts, activeId, onAccountChange,
  metrics, busy, onRefresh, account, onReset, onNewAccount,
  replayLocked = false,
}: {
  mode: TerminalMode; onModeChange: (m: TerminalMode) => void;
  /** P76 — a running replay session binds the chart to its symbol/tf */
  replayLocked?: boolean;
  symbol: string; onSymbolChange: (s: string) => void;
  timeframe: Timeframe; onTimeframeChange: (tf: Timeframe) => void;
  onOpenExplorer: () => void;
  onOpenInstrumentSettings: () => void;
  accounts: { id: string; label: string; type: string }[];
  activeId: string | null; onAccountChange: (id: string) => void;
  metrics: { balance: number; equity: number; floatingPnl: number; usedMargin: number; freeMargin: number; marginLevel: number | null } | null;
  busy: boolean; onRefresh: () => void;
  account: { id: string; label: string } | null; onReset: () => void;
  onNewAccount: () => void;
}) {
  const [resetOpen, setResetOpen] = useState(false);
  const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnl = metrics?.floatingPnl ?? 0;
  const liveOnly = mode === "live";
  const showMarkets = mode === "live";

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
          <div className={cn(replayLocked && "pointer-events-none opacity-60")} title={replayLocked ? "A replay session is running — exit replay to switch instrument" : undefined}>
            {/* Phase 21 — the toolbar symbol button opens the full instrument
                explorer (search, categories, favorites, live prices) */}
            <button
              onClick={onOpenExplorer}
              className="flex h-9 w-[150px] items-center justify-between rounded-md border border-slate-700/70 px-2 text-sm font-semibold sm:w-[210px] sm:px-3 text-slate-100 transition-colors hover:border-slate-500"
            >
              <span className="min-w-0 truncate">
                {symbol} <span className="ml-1 text-xs font-normal text-slate-400">{getInstrument(symbol)?.name}</span>
              </span>
              <Search className="ml-2 h-3.5 w-3.5 shrink-0 text-slate-500" />
            </button>
          </div>

          <div className={cn("flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-slate-700/70 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", replayLocked && "pointer-events-none opacity-60")}>
            {availableTimeframes(symbol).map((tf) => (
              <button
                key={tf}
                onClick={() => onTimeframeChange(tf)}
                className={cn(
                  "shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors",
                  tf === timeframe ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200",
                )}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Phase 34 — per-instrument settings */}
          <button
            onClick={onOpenInstrumentSettings}
            title={`Instrument settings · ${symbol}`}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700/70 text-slate-400 transition-colors hover:border-primary/60 hover:text-primary"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        </>
      )}

      {liveOnly && <div className="mx-1 hidden h-6 w-px bg-slate-700 sm:block" />}

      {/* Account strip — server metrics, refreshed by the 10s heartbeat (live only) */}
      {liveOnly && account && (
        <Select value={activeId ?? undefined} onValueChange={onAccountChange}>
          <SelectTrigger className="w-[120px] sm:w-[150px]">
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

      {replayLocked && (
        <div className="text-[10px] text-amber-300/80">
          Replay running — the future is hidden; exit replay to switch instrument.
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {liveOnly && (
          <>
            {/* P42 — the three account actions collapsed into ONE menu button:
                same power, half the toolbar space, a single consistent style */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" title="Account actions — new demo / refresh / reset">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={onNewAccount}>
                  <Plus className="mr-2 h-4 w-4" /> New DEMO / challenge account
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRefresh} disabled={busy}>
                  <RefreshCw className={cn("mr-2 h-4 w-4", busy && "animate-spin")} /> Refresh account
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={busy || !account}
                  onSelect={(e) => { e.preventDefault(); setResetOpen(true); }}
                >
                  <RotateCcw className="mr-2 h-4 w-4" /> Reset account…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
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
