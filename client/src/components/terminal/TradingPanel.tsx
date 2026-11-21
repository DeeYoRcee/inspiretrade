/**
 * TradingPanel — the order ticket (right side of the terminal).
 *
 * Market / limit / stop orders with SL/TP and risk-based sizing, executed
 * SERVER-side via /api/trading: fills happen at server-computed bid/ask,
 * balances live in Firestore and clients cannot write them. Positions,
 * pending orders, history and statistics live in the TradingBlotter below
 * the chart.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { marketHoursInfo } from "@/lib/market-status";
import { useLanguage } from "@/lib/language-context";
import { getInstrument } from "@shared/terminal";
import { SPREAD_PIPS, type OrderKind } from "@shared/trading-engine";
import { Minus, Plus } from "lucide-react";
import { useTrading } from "@/hooks/use-trading";
import { usePrice } from "@/lib/price-store";
import { useServerQuote } from "@/hooks/use-server-quote";
import { useTerminalSettings } from "@/lib/terminal-settings";
import { useInstrumentSettings } from "@/lib/instrument-settings";
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
  // Phase 21 — trading defaults come from Terminal Settings; the instrument's
  // own overrides (Terminal Settings → Instrument) win when present. Field
  // init + symbol switches both re-apply them.
  const ts = useTerminalSettings();
  const per = useInstrumentSettings(symbol);
  const confirmOrders = ts.trading.oneClick ? false : ts.trading.confirmOrders;
  const [orderKind, setOrderKind] = useState<"market" | "limit" | "stop">(
    ts.trading.defaultOrderType === "limit" ? "limit" : "market",
  );
  const [lots, setLots] = useState(() => per.defaultLot ?? ts.trading.defaultLot);
  const [limitPrice, setLimitPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpPrice, setTpPrice] = useState("");
  const [riskPct, setRiskPct] = useState(() => per.defaultRisk ?? ts.trading.defaultRisk);

  useEffect(() => {
    if (!error) return;
    toast({ title: "Order failed", description: error, variant: "destructive" });
    clearError();
  }, [error, clearError, toast]);

  const d = inst?.digits ?? 2;
  const contract = inst?.contractSize ?? 1;
  const balance = account?.balance ?? 0;
  const locked = !!account?.rules && account.status !== "active";

  // instrument switch → fresh ticket with that instrument's defaults
  useEffect(() => {
    setLots(per.defaultLot ?? ts.trading.defaultLot);
    setRiskPct(per.defaultRisk ?? ts.trading.defaultRisk);
    setSlPrice("");
    setTpPrice("");
    setLimitPrice("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

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

  // SL/TP prefill from the instrument's pip-based defaults — once per symbol,
  // the first time a live entry price exists (buy = SL below / TP above)
  const slTlPrefilledRef = useRef(false);
  useEffect(() => { slTlPrefilledRef.current = false; }, [symbol]);
  const pipSize = inst?.pipSize ?? 0.01;
  useEffect(() => {
    if (slTlPrefilledRef.current || displayEntry == null) return;
    slTlPrefilledRef.current = true;
    if (per.slPips != null) {
      setSlPrice((side === "buy" ? displayEntry - Number(per.slPips) * pipSize : displayEntry + Number(per.slPips) * pipSize).toFixed(d));
    }
    if (per.tpPips != null) {
      setTpPrice((side === "buy" ? displayEntry + Number(per.tpPips) * pipSize : displayEntry - Number(per.tpPips) * pipSize).toFixed(d));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayEntry, symbol]);

  // Phase 27 §3: market-session awareness — a 1s tick re-evaluates the
  // shared authoritative hours; when closed, BUY/SELL/pending creation is
  // disabled with a banner (reason + next opening in the user's local time
  // + countdown). Reopening re-enables automatically; the backend guard
  // stays the authoritative block regardless of what this UI shows.
  const [mhTick, setMhTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMhTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const mh = useMemo(() => marketHoursInfo(symbol), [symbol, mhTick]);
  const marketClosed = !mh.open;
  const countdown = mh.nextOpenMs != null
    ? (() => {
        const left = Math.max(0, mh.nextOpenMs! - Date.now());
        const hh = Math.floor(left / 3600000), mm = Math.floor((left % 3600000) / 60000), ss = Math.floor((left % 60000) / 1000);
        return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      })()
    : null;

  const doSubmit = async () => {
    if (busy || locked || marketClosed) return;
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

  // MARKET orders confirm explicitly unless one-click trading or a disabled
  // confirmation is set in Terminal Settings; pending orders fire directly;
  // the opt-in event guard ALWAYS confirms (safety beats speed near releases)
  const [confirmMode, setConfirmMode] = useState<"market" | "event">("market");
  const submit = async () => {
    if (eventGuard) {
      setConfirmMode("event");
      setConfirmOpen(true);
      return;
    }
    if (orderKind === "market" && confirmOrders) {
      setConfirmMode("market");
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
          {marketClosed && (
            <div className="rounded-lg border border-slate-500/40 bg-slate-800/60 px-2 py-1.5">
              <p className="text-[11px] font-bold tracking-wide text-slate-200">MARKET CLOSED</p>
              <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
                {mh.reason === "weekend"
                  ? "The market is closed for the weekend."
                  : mh.reason === "daily-break"
                    ? "Daily maintenance break (17:00–18:00 New York)."
                    : mh.reason === "holiday"
                      ? "Market holiday — today differs from the regular schedule."
                      : "Trading is unavailable for this instrument at the moment."}
                {mh.nextOpenMs != null && (
                  <span className="block font-number text-slate-300">
                    Reopens {new Date(mh.nextOpenMs).toLocaleTimeString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} · in {countdown}
                  </span>
                )}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => setSide("buy")} disabled={locked || marketClosed} className={cn("rounded-lg py-1.5 font-bold transition-colors disabled:opacity-40", side === "buy" ? "bg-emerald-500 text-black" : "bg-emerald-500/10 text-emerald-400")}>
              <span className="block text-[11px] leading-tight">BUY</span>
              <span className="block font-number text-[10px] leading-tight opacity-80">{ask != null ? ask.toFixed(d) : "—"}</span>
            </button>
            <button onClick={() => setSide("sell")} disabled={locked || marketClosed} className={cn("rounded-lg py-1.5 font-bold transition-colors disabled:opacity-40", side === "sell" ? "bg-red-500 text-black" : "bg-red-500/10 text-red-400")}>
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
              <button key={k} onClick={() => setOrderKind(k)} disabled={locked || marketClosed} className={cn("flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold capitalize disabled:opacity-40", orderKind === k ? "border-emerald-500/50 text-emerald-400" : "border-border/60 text-muted-foreground")}>{k}</button>
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
