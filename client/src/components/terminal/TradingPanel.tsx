/**
 * TradingPanel — DEMO order execution, open positions and trade history.
 * Every element is labeled DEMO/SIMULATED: no real broker is contacted and no
 * real money can move. The execution adapter interface (see
 * use-terminal-trading.ts) is the future seam for an MT5/broker bridge.
 */
import { useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { getInstrument } from "@shared/terminal";
import { useTerminalTrading, type DemoPosition } from "@/hooks/use-terminal-trading";
import { cn } from "@/lib/utils";
import { db, auth } from "@/lib/firebase";
import { push, ref } from "firebase/database";

type Tab = "order" | "positions" | "history";

export function TradingPanel({
  symbol, price, className,
}: {
  symbol: string;
  price: number | null;
  className?: string;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { account, positions, openPosition, closePosition, updatePosition, floatingProfit } = useTerminalTrading();
  const [tab, setTab] = useState<Tab>("order");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderKind, setOrderKind] = useState<"market" | "limit">("market");
  const [lots, setLots] = useState("0.10");
  const [limitPrice, setLimitPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpPrice, setTpPrice] = useState("");
  const [riskPct, setRiskPct] = useState("1");
  const [busy, setBusy] = useState(false);

  const inst = getInstrument(symbol);
  const d = inst?.digits ?? 2;
  const contract = inst?.contractSize ?? 1;
  const balance = account?.balance ?? 0;

  const entryPx = orderKind === "limit" && limitPrice ? Number(limitPrice) : price;
  const slPx = slPrice ? Number(slPrice) : null;
  const lotsNum = Math.max(0.01, Number(lots) || 0.01);

  // position size from risk %: lots = risk$ / (SL distance × contract size)
  const riskDerived = useMemo(() => {
    if (!entryPx || !slPx || !balance) return null;
    const dist = Math.abs(entryPx - slPx);
    if (!dist) return null;
    const riskUsd = (balance * Number(riskPct || 0)) / 100;
    return Math.max(0.01, Math.round((riskUsd / (dist * contract)) * 100) / 100);
  }, [entryPx, slPx, balance, riskPct, contract]);

  const estRisk = entryPx && slPx ? Math.abs(entryPx - slPx) * lotsNum * contract : null;
  const estReward = entryPx && tpPrice ? Math.abs(Number(tpPrice) - entryPx) * lotsNum * contract : null;
  const rr = estRisk && estReward ? estReward / estRisk : null;

  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const totalFloating = open.reduce((s, p) => s + (price != null ? floatingProfit(p, price, getInstrument(p.symbol)) : 0), 0);

  const submit = async () => {
    if (!price || busy) return;
    setBusy(true);
    const res = await openPosition({
      symbol, side, lots: lotsNum, price,
      limitPrice: orderKind === "limit" && limitPrice ? Number(limitPrice) : undefined,
      sl: slPx, tp: tpPrice ? Number(tpPrice) : null,
    });
    setBusy(false);
    if (res.ok) toast({ title: `${side === "buy" ? "BUY" : "SELL"} ${symbol} — DEMO executed`, description: `${lotsNum} lots @ ${(res.position?.entry ?? price).toFixed(d)}` });
    else toast({ title: "Order failed", description: res.error, variant: "destructive" });
  };

  const closeAll = async () => {
    if (price == null) return;
    for (const p of open) {
      await closePosition(p, price, floatingProfit(p, price, getInstrument(p.symbol)));
    }
  };

  const saveToJournal = async (p: DemoPosition) => {
    if (!auth.currentUser) return;
    try {
      await push(ref(db, `trades/${auth.currentUser.uid}`), {
        assetName: inst?.name ?? p.symbol,
        entryPrice: p.entry,
        exitPrice: p.exit ?? p.entry,
        lotSize: p.lots,
        profit: p.profit ?? 0,
        type: p.side === "buy" ? "BUY" : "SELL",
        category: inst?.assetClass === "crypto" ? "CRYPTO" : "FOREX",
        timestamp: p.closedAt ?? Date.now(),
        instrumentSymbol: p.symbol,
        instrumentName: inst?.name ?? p.symbol,
        emotion: "neutral",
        comment: "From InspireTrade Terminal (DEMO execution)",
      });
      toast({ title: t("journalSaved") });
    } catch (e: any) {
      toast({ title: t("serverError"), description: String(e?.message || e), variant: "destructive" });
    }
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 gap-1 border-b border-border/40 p-1.5">
        {(["order", "positions", "history"] as Tab[]).map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={cn(
              "flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors",
              tab === tb ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tb === "order" ? t("tpOrder") : tb === "positions" ? `${t("tpPositions")} (${open.length})` : t("tpHistory")}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 text-xs">
        {tab === "order" && (
          <div className="space-y-2.5">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-300">
              ⚠ DEMO EXECUTION — simulated order, no real broker
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => setSide("buy")} className={cn("rounded-lg py-2 font-bold transition-colors", side === "buy" ? "bg-emerald-500 text-black" : "bg-emerald-500/10 text-emerald-400")}>BUY</button>
              <button onClick={() => setSide("sell")} className={cn("rounded-lg py-2 font-bold transition-colors", side === "sell" ? "bg-red-500 text-black" : "bg-red-500/10 text-red-400")}>SELL</button>
            </div>
            <div className="flex gap-1.5">
              {(["market", "limit"] as const).map((k) => (
                <button key={k} onClick={() => setOrderKind(k)} className={cn("flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold capitalize", orderKind === k ? "border-emerald-500/50 text-emerald-400" : "border-border/60 text-muted-foreground")}>{k}</button>
              ))}
            </div>
            {orderKind === "limit" && (
              <Field label="Limit price"><input type="number" step="any" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} className="num-input" placeholder={price?.toFixed(d)} /></Field>
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
            {riskDerived && (
              <button onClick={() => setLots(String(riskDerived))} className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-400">
                {t("sizeByRisk")}: {riskDerived} lots
              </button>
            )}
            <div className="space-y-1 rounded-lg bg-card/50 p-2 text-[11px] text-muted-foreground">
              <div className="flex justify-between"><span>Est. risk</span><b className="text-red-400">{estRisk != null ? `$${estRisk.toFixed(2)}` : "—"}</b></div>
              <div className="flex justify-between"><span>Est. profit</span><b className="text-emerald-400">{estReward != null ? `$${estReward.toFixed(2)}` : "—"}</b></div>
              <div className="flex justify-between"><span>R:R</span><b className="text-foreground">{rr ? `1 : ${rr.toFixed(2)}` : "—"}</b></div>
            </div>
            <button
              onClick={submit}
              disabled={busy || !price}
              className={cn("w-full rounded-lg py-2.5 font-bold transition-opacity disabled:opacity-40", side === "buy" ? "bg-emerald-500 text-black" : "bg-red-500 text-black")}
            >
              {side === "buy" ? "BUY" : "SELL"} {lotsNum} {symbol}
            </button>
          </div>
        )}

        {tab === "positions" && (
          <div className="space-y-2">
            {!open.length && <div className="py-6 text-center text-muted-foreground">{t("noOpenPositions")}</div>}
            {open.map((p) => {
              const pl = price != null ? floatingProfit(p, price, getInstrument(p.symbol)) : 0;
              return (
                <div key={p.id} className="rounded-lg border border-border/50 bg-card/50 p-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", p.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{p.side.toUpperCase()}</span>
                    <span className="font-semibold">{p.symbol}</span>
                    <span className="font-number text-muted-foreground">{p.lots} lots @ {p.entry.toFixed(getInstrument(p.symbol)?.digits ?? 2)}</span>
                    <b className={cn("font-number ml-auto", pl >= 0 ? "text-emerald-400" : "text-red-400")}>{pl >= 0 ? "+" : ""}${pl.toFixed(2)}</b>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>SL <input type="number" step="any" className="num-input h-6 w-20" defaultValue={p.sl ?? ""} onBlur={(e) => updatePosition(p, { sl: e.target.value ? Number(e.target.value) : null })} /></span>
                    <span>TP <input type="number" step="any" className="num-input h-6 w-20" defaultValue={p.tp ?? ""} onBlur={(e) => updatePosition(p, { tp: e.target.value ? Number(e.target.value) : null })} /></span>
                    <button onClick={() => closePosition(p, price ?? p.entry, pl)} className="ml-auto rounded bg-destructive/15 px-2 py-1 font-semibold text-red-400 hover:bg-destructive/25">Close</button>
                  </div>
                </div>
              );
            })}
            {open.length > 0 && (
              <button onClick={closeAll} className="w-full rounded-lg border border-destructive/40 py-1.5 text-[11px] font-semibold text-red-400">{t("closeAll")}</button>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-2">
            {!closed.length && <div className="py-6 text-center text-muted-foreground">{t("noHistory")}</div>}
            {closed.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", p.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{p.side === "buy" ? "B" : "S"}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold">{p.symbol} · {p.lots} lots</div>
                  <div className="text-[10px] text-muted-foreground">
                    {p.entry.toFixed(getInstrument(p.symbol)?.digits ?? 2)} → {p.exit?.toFixed(getInstrument(p.symbol)?.digits ?? 2)} · {new Date(p.closedAt ?? 0).toLocaleDateString()}
                  </div>
                </div>
                <b className={cn("font-number", (p.profit ?? 0) >= 0 ? "text-emerald-400" : "text-red-400")}>{(p.profit ?? 0) >= 0 ? "+" : ""}${(p.profit ?? 0).toFixed(2)}</b>
                <button onClick={() => saveToJournal(p)} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" title="Save to journal">📖</button>
              </div>
            ))}
          </div>
        )}
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
