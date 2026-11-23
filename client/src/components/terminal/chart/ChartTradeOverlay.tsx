/**
 * PHASE 61 §2/§3 — TradingView-style quick execution, on the chart itself.
 *
 * A compact BUY/SELL stack pinned to the top-right of every chart panel:
 *  - genuine two-sided server prices (Bid/Ask from the shared trading store —
 *    never fabricated, never the local spread estimate);
 *  - the instrument's real digit precision;
 *  - a per-panel lots preference + optional confirm step (localStorage);
 *  - BUY at Ask, SELL at Bid (the correct execution side, always);
 *  - every submit carries a requestId — the server rejects an exact duplicate
 *    submit with 409 DUPLICATE_REQUEST (double-click protection);
 *  - the executed price shown in the toast comes from the SERVER response
 *    (position.entry), never a client-side guess.
 *
 * Multi-chart safe: each instance is bound to its own panel symbol via
 * props, so an order always lands on the chart it was pressed on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Settings2 } from "lucide-react";
import { getInstrument } from "@shared/terminal";
import { tradingApi } from "@/lib/trading-api";
import { useServerQuote } from "@/hooks/use-server-quote";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface TradePrefs { lots: number; confirm: boolean; }
const LS_KEY = "it_chart_trade_prefs_v1";

function loadPrefs(): TradePrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<TradePrefs>;
      const lots = Math.round(Number(v.lots) * 100) / 100;
      return { lots: Number.isFinite(lots) && lots >= 0.01 ? Math.min(lots, 100) : 0.1, confirm: v.confirm === true };
    }
  } catch { /* private mode */ }
  return { lots: 0.1, confirm: false };
}

export function ChartTradeOverlay({ symbol, accountId }: { symbol: string; accountId: string | null }) {
  const { toast } = useToast();
  // PHASE 61 §2 (fixed in the reliability pass): the accounts endpoint does
  // NOT carry per-symbol quotes — poll the server quote action directly
  // (the same authoritative source the ticket and the market panel use).
  const quote = useServerQuote(symbol);
  const inst = getInstrument(symbol);
  const dg = inst?.digits ?? 2;

  const [prefs, setPrefs] = useState<TradePrefs>(loadPrefs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lotsDraft, setLotsDraft] = useState(String(prefs.lots));
  const [armedSide, setArmedSide] = useState<"buy" | "sell" | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }, [prefs]);

  // disarm the confirm arm after 4s of inactivity
  useEffect(() => {
    if (!armedSide) return;
    const t = setTimeout(() => setArmedSide(null), 4000);
    return () => clearTimeout(t);
  }, [armedSide]);

  const quoteFresh = !!quote && quote.live === true
    && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid > 0 && quote.ask > quote.bid
    && Date.now() - (quote.time ?? 0) < 90_000;

  const execute = useCallback(async (side: "buy" | "sell") => {
    if (inFlight.current || !accountId || !quoteFresh) return;
    inFlight.current = true;
    try {
      const result = await tradingApi.placeOrder({
        accountId,
        symbol,
        side,
        lots: prefs.lots,
        kind: "market",
        price: null,
        sl: null,
        tp: null,
        expiryAt: null,
      });
      const entry = result?.position?.entry;
      if (entry != null) {
        toast({
          title: `${side === "buy" ? "BUY" : "SELL"} ${prefs.lots.toFixed(2)} ${symbol}`,
          description: `Filled @ ${entry.toFixed(dg)} · server-confirmed`,
        });
      } else {
        // a market order can settle as a pending fill receipt in rare races —
        // the store refresh will reflect the true state either way
        toast({ title: "Order submitted", description: `${symbol} — check the blotter for the fill` });
      }
    } catch (e) {
      toast({
        title: "Order rejected",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      inFlight.current = false;
      setArmedSide(null);
    }
  }, [accountId, dg, prefs.lots, quoteFresh, symbol, toast]);

  const press = (side: "buy" | "sell") => {
    if (inFlight.current) return;
    // §3 — balance between fast execution and accidental-trade protection:
    // instant when confirm is off, two-press arm otherwise
    if (prefs.confirm && armedSide !== side) { setArmedSide(side); return; }
    void execute(side);
  };

  const bid = quoteFresh ? quote!.bid : null;
  const ask = quoteFresh ? quote!.ask : null;

  return (
    <div data-chart-ui className="absolute right-2 top-9 z-40 w-[124px] select-none rounded-xl border border-slate-700/80 bg-[#0d1526]/95 p-1.5 shadow-2xl backdrop-blur">
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="truncate text-[9px] font-bold uppercase tracking-wider text-slate-400">{symbol}</span>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          aria-label="Trade settings"
        >
          <Settings2 className="h-3 w-3" />
        </button>
      </div>

      {settingsOpen && (
        <div className="mb-1 space-y-1 rounded-lg border border-slate-700/70 bg-slate-900/80 p-1.5">
          <label className="flex items-center justify-between gap-1 text-[10px] text-slate-400">
            Lots
            <input
              type="number" step="0.01" min="0.01" max="100" inputMode="decimal"
              value={lotsDraft}
              onChange={(e) => setLotsDraft(e.target.value)}
              onBlur={() => {
                const v = Number(lotsDraft);
                if (Number.isFinite(v) && v >= 0.01) setPrefs((p) => ({ ...p, lots: Math.min(Math.round(v * 100) / 100, 100) }));
                else setLotsDraft(String(prefs.lots));
              }}
              className="num-input w-14 px-1 py-0.5 text-[10px]"
            />
          </label>
          <label className="flex items-center justify-between gap-1 text-[10px] text-slate-400">
            Confirm
            <input
              type="checkbox"
              checked={prefs.confirm}
              onChange={(e) => setPrefs((p) => ({ ...p, confirm: e.target.checked }))}
              className="accent-emerald-500"
            />
          </label>
        </div>
      )}

      {/* SELL — executes at Bid */}
      <button
        disabled={!quoteFresh || inFlight.current}
        onClick={() => press("sell")}
        className={cn(
          "mb-1 w-full rounded-lg border py-1 text-left transition-colors disabled:opacity-50",
          armedSide === "sell"
            ? "border-red-400 bg-red-500/30 animate-pulse"
            : "border-red-500/40 bg-red-500/10 hover:bg-red-500/25",
        )}
        title={quoteFresh ? `Sell ${prefs.lots.toFixed(2)} @ ${bid!.toFixed(dg)}` : "Waiting for a live quote"}
      >
        <span className="flex items-center justify-between px-1.5">
          <span className="text-[10px] font-bold text-red-400">{armedSide === "sell" ? "CONFIRM?" : inFlight.current ? "…" : "SELL"}</span>
          <span className="font-number text-[10px] text-red-300">{bid != null ? bid.toFixed(dg) : "—"}</span>
        </span>
      </button>

      {/* BUY — executes at Ask */}
      <button
        disabled={!quoteFresh || inFlight.current}
        onClick={() => press("buy")}
        className={cn(
          "w-full rounded-lg border py-1 text-left transition-colors disabled:opacity-50",
          armedSide === "buy"
            ? "border-emerald-400 bg-emerald-500/30 animate-pulse"
            : "border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/25",
        )}
        title={quoteFresh ? `Buy ${prefs.lots.toFixed(2)} @ ${ask!.toFixed(dg)}` : "Waiting for a live quote"}
      >
        <span className="flex items-center justify-between px-1.5">
          <span className="text-[10px] font-bold text-emerald-400">{armedSide === "buy" ? "CONFIRM?" : inFlight.current ? <Loader2 className="h-3 w-3 animate-spin" /> : "BUY"}</span>
          <span className="font-number text-[10px] text-emerald-300">{ask != null ? ask.toFixed(dg) : "—"}</span>
        </span>
      </button>
    </div>
  );
}
