/**
 * InspireTrade Terminal — the main trading workspace page (REBUILT).
 *
 * The old 1,287-line monolith (drawing tools, indicators, replay, screener,
 * heatmap, MTF, templates, …) is deleted. This page is the real product:
 *   - live REAL-data chart (PriceChart: candles + volume, position lines)
 *   - account strip driven by the SERVER-authoritative engine (/api/trading)
 *   - TradingPanel: market/limit/stop orders, SL/TP, positions, history
 * Every mutation hits the server; the client never touches balances.
 */
import { useEffect, useMemo, useState } from "react";
import { INSTRUMENTS, TIMEFRAMES, type Timeframe } from "@shared/terminal";
import { useTrading } from "@/hooks/use-trading";
import { PriceChart, type PriceMark } from "@/components/terminal/PriceChart";
import { TradingPanel } from "@/components/terminal/TradingPanel";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RefreshCw, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

const SYMBOL_KEY = "it_terminal_symbol";
const TF_KEY = "it_terminal_tf";

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
  } = useTrading();

  const [symbol, setSymbol] = useState(() => localStorage.getItem(SYMBOL_KEY) || "BTCUSD");
  const [timeframe, setTimeframe] = useState<Timeframe>(
    () => (localStorage.getItem(TF_KEY) as Timeframe) || "5m",
  );

  useEffect(() => { localStorage.setItem(SYMBOL_KEY, symbol); }, [symbol]);
  useEffect(() => { localStorage.setItem(TF_KEY, timeframe); }, [timeframe]);

  // Chart price lines: entry / SL / TP for open positions + pending order
  // levels of the selected symbol.
  const marks = useMemo<PriceMark[]>(() => {
    const out: PriceMark[] = [];
    for (const p of positions) {
      if (p.symbol !== symbol) continue;
      const qty = p.lots.toFixed(2);
      out.push({ id: `e-${p.id}`, price: p.entry, color: "#3b82f6", title: `${p.side} ${qty} @`, dashed: true });
      if (p.sl) out.push({ id: `sl-${p.id}`, price: p.sl, color: "#ef4444", title: "SL", dashed: true });
      if (p.tp) out.push({ id: `tp-${p.id}`, price: p.tp, color: "#22c55e", title: "TP", dashed: true });
    }
    for (const o of orders) {
      if (o.symbol !== symbol) continue;
      out.push({ id: `o-${o.id}`, price: o.price, color: "#f59e0b", title: `${o.kind.toUpperCase()} ${o.lots.toFixed(2)}`, dashed: true });
    }
    return out;
  }, [positions, orders, symbol]);

  if (loading && !account) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-sm text-slate-400">
        Loading trading account…
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-4.25rem)] min-h-[560px] flex-col gap-2 p-2">
      <Toolbar
        symbol={symbol} onSymbolChange={setSymbol}
        timeframe={timeframe} onTimeframeChange={setTimeframe}
        accounts={accounts} activeId={account?.id ?? null} onAccountChange={setActiveId}
        metrics={metrics} busy={busy} onRefresh={refreshNow}
        account={account} onReset={resetAccount}
      />
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-800 bg-[#0b1220]">
          <PriceChart symbol={symbol} timeframe={timeframe} marks={marks} />
        </div>
        <TradingPanel symbol={symbol} className="w-[380px] shrink-0 overflow-y-auto" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar: instrument picker, timeframes, account strip
// ---------------------------------------------------------------------------

function Toolbar({
  symbol, onSymbolChange, timeframe, onTimeframeChange,
  accounts, activeId, onAccountChange,
  metrics, busy, onRefresh, account, onReset,
}: {
  symbol: string; onSymbolChange: (s: string) => void;
  timeframe: Timeframe; onTimeframeChange: (tf: Timeframe) => void;
  accounts: { id: string; label: string; type: string }[];
  activeId: string | null; onAccountChange: (id: string) => void;
  metrics: { balance: number; equity: number; floatingPnl: number; usedMargin: number; freeMargin: number; marginLevel: number | null } | null;
  busy: boolean; onRefresh: () => void;
  account: { id: string; label: string } | null; onReset: () => void;
}) {
  const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnl = metrics?.floatingPnl ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5">
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

      <div className="flex items-center gap-0.5 rounded-md border border-slate-700/70 p-0.5">
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

      <div className="mx-1 hidden h-6 w-px bg-slate-700 sm:block" />

      {/* Account strip — server metrics, refreshed by the 10s heartbeat */}
      {account && (
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

      <div className="ml-auto flex items-center gap-1.5">
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
                goes back to its starting amount. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onReset}>Reset</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
