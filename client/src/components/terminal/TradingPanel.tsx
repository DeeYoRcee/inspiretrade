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
import type { OrderKind } from "@shared/trading-engine";
import { useTrading } from "@/hooks/use-trading";
import { usePrice } from "@/lib/price-store";
import { cn } from "@/lib/utils";

export function TradingPanel({
  symbol, className,
}: {
  symbol: string;
  /** legacy prop (unused — the panel subscribes to the price store itself) */
  price?: number | null;
  className?: string;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const {
    account, metrics, busy,
    placeOrder, error, clearError,
  } = useTrading();
  const price = usePrice(symbol);

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

  const inst = getInstrument(symbol);
  const d = inst?.digits ?? 2;
  const contract = inst?.contractSize ?? 1;
  const balance = account?.balance ?? 0;
  const locked = !!account?.rules && account.status !== "active";

  // display entry: buy at ask / sell at bid — approximate with the mid + half spread
  const displayEntry = orderKind === "market"
    ? (price != null && inst ? (side === "buy" ? price + inst.pipSize * 1.25 : price - inst.pipSize * 1.25) : price)
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

  const submit = async () => {
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
            <button onClick={() => setSide("buy")} disabled={locked} className={cn("rounded-lg py-2 font-bold transition-colors disabled:opacity-40", side === "buy" ? "bg-emerald-500 text-black" : "bg-emerald-500/10 text-emerald-400")}>BUY</button>
            <button onClick={() => setSide("sell")} disabled={locked} className={cn("rounded-lg py-2 font-bold transition-colors disabled:opacity-40", side === "sell" ? "bg-red-500 text-black" : "bg-red-500/10 text-red-400")}>SELL</button>
          </div>
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
              <input type="number" step="0.01" min="0.01" value={lots} onChange={(e) => setLots(e.target.value)} className="num-input" />
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
