/**
 * TradingPanel — the order ticket (right side of the terminal).
 *
 * Market / limit / stop orders with SL/TP and risk-based sizing, executed
 * SERVER-side via /api/trading: fills happen at server-computed bid/ask,
 * balances live in Firestore and clients cannot write them. Positions,
 * pending orders, history and statistics live in the TradingBlotter below
 * the chart.
 */
import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { getInstrument } from "@shared/terminal";
import { SPREAD_PIPS, type OrderKind } from "@shared/trading-engine";
import { Minus, Plus } from "lucide-react";
import { useTrading } from "@/hooks/use-trading";
import { usePrice } from "@/lib/price-store";
import { useServerQuote } from "@/hooks/use-server-quote";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export interface EventGuardInfo {
  eventName: string;
  currency: string;
  minutesUntil: number;
}

export function TradingPanel({
  symbol, className, eventGuard,
}: {
  symbol: string;
  /** legacy prop (unused — the panel subscribes to the price store itself) */
  price?: number | null;
  className?: string;
  /** OPT-IN warning: set only when the user enables "confirm trades near events" */
  eventGuard?: EventGuardInfo | null;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const {
    account, metrics, busy,
    placeOrder, error, clearError,
  } = useTrading();
  const price = usePrice(symbol);
  const inst = getInstrument(symbol);
  // Phase 19 §1: the displayed bid/ask comes from the ENGINE's quote endpoint
  // (same price service that fills the order — genuine TrueFX spreads for
  // majors, SPREAD_PIPS around the gold-api spot mid for metals, × the
  // platform multiplier). The price-bus estimate below is only the offline
  // fallback; the fill itself was ALWAYS server-side.
  const serverQuote = useServerQuote(symbol);
  const spread = ((SPREAD_PIPS[symbol] ?? 2) * (inst?.pipSize ?? 0.01));
  const fbBid = price != null ? price - spread / 2 : null;
  const fbAsk = price != null ? price + spread / 2 : null;
  const bid = serverQuote?.bid ?? fbBid;
  const ask = serverQuote?.ask ?? fbAsk;

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderKind, setOrderKind] = useState<"market" | "limit" | "stop">("market");
  const [lots, setLots] = useState("0.10");
  const [limitPrice, setLimitPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpPrice, setTpPrice] = useState("");
  const [riskPct, setRiskPct] = useState("1");

  useEffect(() => {
    if (!error) return;
    toast({ title: "Order failed", description: error, variant: "destructive" });
    clearError();
  }, [error, clearError, toast]);

  const d = inst?.digits ?? 2;
  const contract = inst?.contractSize ?? 1;
  const balance = account?.balance ?? 0;
  const locked = !!account?.rules && account.status !== "active";

  // display entry: buy fills at ask / sell fills at bid — same model as the engine
  const displayEntry = orderKind === "market"
    ? (side === "buy" ? ask : bid)
    : (limitPrice ? Number(limitPrice) : null);
  const slPx = slPrice ? Number(slPrice) : null;
  const lotsNum = Math.max(0.01, Number(lots) || 0.01);

  // position size from risk %: lots = risk$ / (SL distance × contract size)
  const riskDerived = useMemo(() => {
    if (!displayEntry || !slPx || !balance) return null;
    const dist = Math.abs(displayEntry - slPx);
    if (!dist) return null;
    const riskUsd = (balance * Number(riskPct || 0)) / 100;
    return Math.max(0.01, Math.round((riskUsd / (dist * contract)) * 100) / 100);
  }, [displayEntry, slPx, balance, riskPct, contract]);

  const estRisk = displayEntry && slPx ? Math.abs(displayEntry - slPx) * lotsNum * contract : null;
  const estReward = displayEntry && tpPrice ? Math.abs(Number(tpPrice) - displayEntry) * lotsNum * contract : null;
  const rr = estRisk && estReward ? estReward / estRisk : null;

  const [confirmOpen, setConfirmOpen] = useState(false);

  const doSubmit = async () => {
    if (busy || locked) return;
    const kind: OrderKind = orderKind;
    const res = await placeOrder({
      symbol, side, lots: lotsNum, kind,
      price: orderKind !== "market" && limitPrice ? Number(limitPrice) : null,
      sl: slPx, tp: tpPrice ? Number(tpPrice) : null,
    });
    if (res) {
      if (res.position) toast({ title: `${side === "buy" ? "BUY" : "SELL"} ${symbol} — filled`, description: `${lotsNum} lots @ ${res.position.entry.toFixed(d)} (server ${res.quote?.source ?? ""})` });
      else if (res.order) toast({ title: `${side === "buy" ? "Buy" : "Sell"} ${orderKind} placed`, description: `${symbol} trigger ${res.order.price}` });
    }
  };

  // every MARKET order asks for an explicit confirmation (professional ticket
  // behavior); pending orders fire directly unless the event guard is active
  // ("confirm trades near major events" — opt-in, never blocks automatically)
  const [confirmMode, setConfirmMode] = useState<"market" | "event">("market");
  const submit = async () => {
    if (orderKind === "market" || eventGuard) {
      setConfirmMode(eventGuard ? "event" : "market");
      setConfirmOpen(true);
      return;
    }
    await doSubmit();
  };

  const marginRequired = displayEntry != null && inst
    ? (lotsNum * inst.contractSize * displayEntry) / (account?.leverage || 100)
    : null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 text-xs">
        <div className="space-y-2.5">
          {locked ? (
            <div className={cn(
              "rounded-lg border px-2 py-1.5 text-[11px] font-semibold",
              account?.status === "failed"
                ? "border-red-500/40 bg-red-500/10 text-red-300"
                : "border-sky-500/40 bg-sky-500/10 text-sky-300",
            )}>
              {account?.status === "failed"
                ? `Challenge FAILED — trading disabled. ${account.failedReason ?? ""}`
                : "Challenge PASSED — target reached. Create a new challenge to keep trading."}
            </div>
          ) : (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-300">
              ⚠ SIMULATED — server-side virtual execution, no broker, no real money
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => setSide("buy")} disabled={locked} className={cn("rounded-lg py-1.5 font-bold transition-colors disabled:opacity-40", side === "buy" ? "bg-emerald-500 text-black" : "bg-emerald-500/10 text-emerald-400")}>
              <span className="block text-[11px] leading-tight">BUY</span>
              <span className="block font-number text-[10px] leading-tight opacity-80">{ask != null ? ask.toFixed(d) : "—"}</span>
            </button>
            <button onClick={() => setSide("sell")} disabled={locked} className={cn("rounded-lg py-1.5 font-bold transition-colors disabled:opacity-40", side === "sell" ? "bg-red-500 text-black" : "bg-red-500/10 text-red-400")}>
              <span className="block text-[11px] leading-tight">SELL</span>
              <span className="block font-number text-[10px] leading-tight opacity-80">{bid != null ? bid.toFixed(d) : "—"}</span>
            </button>
          </div>
          <p className="text-center font-number text-[10px] text-slate-500">
            spread {(serverQuote ? Math.abs(serverQuote.ask - serverQuote.bid) : spread).toFixed(d > 4 ? 5 : d)}
            {serverQuote ? ` · ${serverQuote.source}${serverQuote.live ? "" : " (delayed)"}` : " · estimating…"}
          </p>
          <div className="flex gap-1.5">
            {(["market", "limit", "stop"] as const).map((k) => (
              <button key={k} onClick={() => setOrderKind(k)} disabled={locked} className={cn("flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold capitalize disabled:opacity-40", orderKind === k ? "border-emerald-500/50 text-emerald-400" : "border-border/60 text-muted-foreground")}>{k}</button>
            ))}
          </div>
          {orderKind !== "market" && (
            <Field label={`${orderKind === "limit" ? "Limit" : "Stop"} trigger price`}>
              <input type="number" step="any" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} className="num-input" placeholder={price?.toFixed(d)} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Lots">
              <div className="flex items-stretch gap-1">
                <button type="button" onClick={() => setLots(String(Math.max(0.01, Math.round((lotsNum - 0.01) * 100) / 100)))} className="w-6 rounded border border-border/60 text-slate-400 hover:text-foreground" title="− 0.01"><Minus className="h-3 w-3" /></button>
                <input type="number" step="0.01" min="0.01" value={lots} onChange={(e) => setLots(e.target.value)} className="num-input" />
                <button type="button" onClick={() => setLots(String(Math.round((lotsNum + 0.01) * 100) / 100))} className="w-6 rounded border border-border/60 text-slate-400 hover:text-foreground" title="+ 0.01"><Plus className="h-3 w-3" /></button>
              </div>
            </Field>
            <Field label="Risk %">
              <input type="number" step="0.1" min="0" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} className="num-input" />
            </Field>
            <Field label="Stop Loss">
              <input type="number" step="any" value={slPrice} onChange={(e) => setSlPrice(e.target.value)} className="num-input" placeholder="—" />
            </Field>
            <Field label="Take Profit">
              <input type="number" step="any" value={tpPrice} onChange={(e) => setTpPrice(e.target.value)} className="num-input" placeholder="—" />
            </Field>
          </div>
          {riskDerived && !locked && (
            <button onClick={() => setLots(String(riskDerived))} className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-400">
              {t("sizeByRisk")}: {riskDerived} lots
            </button>
          )}
          <div className="space-y-1 rounded-lg bg-card/50 p-2 text-[11px] text-muted-foreground">
            <div className="flex justify-between"><span>Entry ({side})</span><b className="text-foreground">{displayEntry != null ? displayEntry.toFixed(d) : "—"}</b></div>
            <div className="flex justify-between"><span>Est. risk</span><b className="text-red-400">{estRisk != null ? `$${estRisk.toFixed(2)}` : "—"}</b></div>
            <div className="flex justify-between"><span>Est. profit</span><b className="text-emerald-400">{estReward != null ? `$${estReward.toFixed(2)}` : "—"}</b></div>
            <div className="flex justify-between"><span>R:R</span><b className="text-foreground">{rr ? `1 : ${rr.toFixed(2)}` : "—"}</b></div>
            <div className="flex justify-between"><span>Margin required (1:{account?.leverage ?? 100})</span><b className="font-number text-foreground">{marginRequired != null ? `$${marginRequired.toFixed(2)}` : "—"}</b></div>
            {metrics && <div className="flex justify-between"><span>Free margin</span><b className="font-number text-foreground">${metrics.freeMargin.toFixed(2)}</b></div>}
          </div>
          <button
            onClick={submit}
            disabled={busy || price == null || locked}
            className={cn("w-full rounded-lg py-2.5 font-bold transition-opacity disabled:opacity-40", side === "buy" ? "bg-emerald-500 text-black" : "bg-red-500 text-black")}
          >
            {busy ? "Sending…" : `${side === "buy" ? "BUY" : "SELL"} ${lotsNum} ${symbol}`}
          </button>
        </div>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="border-slate-700 bg-slate-900 text-slate-100">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmMode === "event"
                ? "Major event imminent — place this order?"
                : `Confirm ${side.toUpperCase()} ${symbol} — ${orderKind} order`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                {confirmMode === "event" && (
                  <p>
                    {eventGuard?.currency} "{eventGuard?.eventName}" starts in about {eventGuard?.minutesUntil} min.
                    Spreads can widen and prices can gap around the release. Confirm to send the order anyway.
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-slate-700/70 p-2 text-[11px] text-slate-300">
                  <dt className="text-slate-500">Side</dt><dd className={side === "buy" ? "font-bold text-emerald-400" : "font-bold text-red-400"}>{side.toUpperCase()} {lotsNum} lots</dd>
                  <dt className="text-slate-500">Est. entry</dt><dd className="font-number">{displayEntry != null ? displayEntry.toFixed(d) : "—"}</dd>
                  {slPx != null && (<><dt className="text-slate-500">Stop loss</dt><dd className="font-number">{slPx.toFixed(d)}</dd></>)}
                  {tpPrice && (<><dt className="text-slate-500">Take profit</dt><dd className="font-number">{Number(tpPrice).toFixed(d)}</dd></>)}
                  <dt className="text-slate-500">Est. risk</dt><dd className="font-number text-red-400">{estRisk != null ? `$${estRisk.toFixed(2)}` : "—"}</dd>
                  <dt className="text-slate-500">Margin required</dt><dd className="font-number">{marginRequired != null ? `$${marginRequired.toFixed(2)}` : "—"}</dd>
                  <dt className="text-slate-500">Free margin after</dt><dd className="font-number">{metrics && marginRequired != null ? `$${(metrics.freeMargin - marginRequired).toFixed(2)}` : "—"}</dd>
                </dl>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); void doSubmit(); }}>Place order</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
