/**
 * TradingPanel — order execution, open positions, pending orders and trade
 * history against the SERVER-side simulated engine (/api/trading).
 *
 * Fills happen on the server at server-computed bid/ask (spread per
 * instrument); the client price below is only for live P/L display between
 * the 10s server syncs. Every balance/position/fill is stored in Firestore by
 * the server — clients cannot write the trading domain. No broker, no real
 * money: accounts are virtual DEMO balances.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { getInstrument } from "@shared/terminal";
import { positionPnlUsd, exitPriceFor, quoteFromMid, type OrderKind } from "@shared/trading-engine";
import { useTrading } from "@/hooks/use-trading";
import { usePrice } from "@/lib/price-store";
import { tradingApi, type ServerTrade } from "@/lib/trading-api";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { db, auth } from "@/lib/firebase";
import { push, ref } from "firebase/database";

type Tab = "order" | "positions" | "history";

export function TradingPanel({
  symbol, className,
}: {
  symbol: string;
  price?: number | null; // legacy prop (unused — the panel subscribes to the price store itself)
  className?: string;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const {
    accounts, account, positions, orders, metrics, busy,
    placeOrder, closePosition, modifyPosition, cancelOrder,
    createAccount, resetAccount, setActiveId, error, clearError,
  } = useTrading();
  const price = usePrice(symbol);

  const [tab, setTab] = useState<Tab>("order");
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

  const open = positions;
  const totalFloating = useMemo(
    () => open.reduce((s, p) => {
      const live = price != null && p.symbol === symbol ? price : account?.quotes?.[p.symbol]?.mid;
      if (live == null) return s;
      const instP = getInstrument(p.symbol);
      if (!instP) return s;
      const q = quoteFromMid(live, instP, "live", true);
      const exit = exitPriceFor(p.side, q);
      const pnl = positionPnlUsd(instP, p.side, p.lots, p.entry, exit, {});
      return s + pnl;
    }, 0),
    [open, price, symbol, account?.quotes],
  );

  const submit = async () => {
    if (busy) return;
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

  const saveToJournal = async (tr: ServerTrade) => {
    if (!auth.currentUser) return;
    try {
      await push(ref(db, `trades/${auth.currentUser.uid}`), {
        assetName: getInstrument(tr.symbol)?.name ?? tr.symbol,
        entryPrice: tr.entry,
        exitPrice: tr.exit,
        lotSize: tr.lots,
        profit: tr.pnl,
        type: tr.side === "buy" ? "BUY" : "SELL",
        category: getInstrument(tr.symbol)?.assetClass === "crypto" ? "CRYPTO" : "FOREX",
        timestamp: tr.closedAt,
        instrumentSymbol: tr.symbol,
        instrumentName: getInstrument(tr.symbol)?.name ?? tr.symbol,
        emotion: "neutral",
        comment: `Terminal ${account?.label ?? "DEMO"} (${tr.reason})`,
      });
      toast({ title: t("journalSaved") });
    } catch (e: any) {
      toast({ title: t("serverError"), description: String(e?.message || e), variant: "destructive" });
    }
  };

  const historyQ = useQuery({
    queryKey: ["tradingHistory", account?.id],
    enabled: tab === "history" && !!account,
    queryFn: () => tradingApi.getHistory(account!.id, 100),
  });

  useEffect(() => {
    if (tab === "history" && account) void qc.invalidateQueries({ queryKey: ["tradingHistory", account.id] });
  }, [tab, account?.id, qc]);

  const posLivePnl = (p: { symbol: string; side: "buy" | "sell"; lots: number; entry: number }) => {
    const live = p.symbol === symbol && price != null ? price : account?.quotes?.[p.symbol]?.mid;
    const instP = getInstrument(p.symbol);
    if (live == null || !instP) return null;
    const q = quoteFromMid(live, instP, "live", true);
    return positionPnlUsd(instP, p.side, p.lots, p.entry, exitPriceFor(p.side, q), {});
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {/* account selector + actions */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 p-1.5">
        <select
          value={account?.id ?? ""}
          onChange={(e) => setActiveId(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-border/60 bg-card px-2 py-1 text-[11px] font-semibold"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.label} · ${a.metrics?.balance?.toLocaleString?.() ?? a.balance}</option>
          ))}
          {!accounts.length && <option value="">No account yet</option>}
        </select>
        <button
          onClick={async () => { const acc = await createAccount(`DEMO ${accounts.length + 1}`, 100000); if (acc) toast({ title: `Account created`, description: `$100,000 virtual balance` }); }}
          disabled={busy}
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-400 disabled:opacity-40"
          title="Create a new virtual account"
        >+</button>
        <button
          onClick={async () => {
            if (!account || !window.confirm(`Reset "${account.label}" to $${account.startingBalance.toLocaleString()}? Positions must be closed first.`)) return;
            const ok = await resetAccount();
            if (ok) toast({ title: "Account reset", description: "Balance restored to the starting amount" });
          }}
          disabled={busy || !account}
          className="rounded-lg border border-border/60 px-2 py-1 text-[11px] text-muted-foreground disabled:opacity-40"
          title="Reset to starting balance"
        >⟳</button>
      </div>
      {account && (
        <div className="flex shrink-0 justify-between border-b border-border/40 px-2.5 py-1 text-[10px] text-muted-foreground">
          <span>Equity <b className="font-number text-foreground">${(metrics?.equity ?? 0).toFixed(2)}</b></span>
          <span>Free <b className="font-number text-foreground">${(metrics?.freeMargin ?? 0).toFixed(2)}</b></span>
          <span>Floating <b className={cn("font-number", totalFloating >= 0 ? "text-emerald-400" : "text-red-400")}>{totalFloating >= 0 ? "+" : ""}${totalFloating.toFixed(2)}</b></span>
        </div>
      )}

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
              ⚠ SIMULATED — server-side virtual execution, no broker, no real money
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => setSide("buy")} className={cn("rounded-lg py-2 font-bold transition-colors", side === "buy" ? "bg-emerald-500 text-black" : "bg-emerald-500/10 text-emerald-400")}>BUY</button>
              <button onClick={() => setSide("sell")} className={cn("rounded-lg py-2 font-bold transition-colors", side === "sell" ? "bg-red-500 text-black" : "bg-red-500/10 text-red-400")}>SELL</button>
            </div>
            <div className="flex gap-1.5">
              {(["market", "limit", "stop"] as const).map((k) => (
                <button key={k} onClick={() => setOrderKind(k)} className={cn("flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold capitalize", orderKind === k ? "border-emerald-500/50 text-emerald-400" : "border-border/60 text-muted-foreground")}>{k}</button>
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
            {riskDerived && (
              <button onClick={() => setLots(String(riskDerived))} className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-400">
                {t("sizeByRisk")}: {riskDerived} lots
              </button>
            )}
            <div className="space-y-1 rounded-lg bg-card/50 p-2 text-[11px] text-muted-foreground">
              <div className="flex justify-between"><span>Entry ({side})</span><b className="text-foreground">{displayEntry != null ? displayEntry.toFixed(d) : "—"}</b></div>
              <div className="flex justify-between"><span>Est. risk</span><b className="text-red-400">{estRisk != null ? `$${estRisk.toFixed(2)}` : "—"}</b></div>
              <div className="flex justify-between"><span>Est. profit</span><b className="text-emerald-400">{estReward != null ? `$${estReward.toFixed(2)}` : "—"}</b></div>
              <div className="flex justify-between"><span>R:R</span><b className="text-foreground">{rr ? `1 : ${rr.toFixed(2)}` : "—"}</b></div>
              <div className="flex justify-between"><span>Margin required</span><b className="font-number text-foreground">{displayEntry != null && inst ? `$${((lotsNum * inst.contractSize * displayEntry) / (account?.leverage || 100)).toFixed(2)}` : "—"}</b></div>
            </div>
            <button
              onClick={submit}
              disabled={busy || price == null}
              className={cn("w-full rounded-lg py-2.5 font-bold transition-opacity disabled:opacity-40", side === "buy" ? "bg-emerald-500 text-black" : "bg-red-500 text-black")}
            >
              {busy ? "Sending…" : `${side === "buy" ? "BUY" : "SELL"} ${lotsNum} ${symbol}`}
            </button>
          </div>
        )}

        {tab === "positions" && (
          <div className="space-y-2">
            {!open.length && !orders.length && <div className="py-6 text-center text-muted-foreground">{t("noOpenPositions")}</div>}
            {open.map((p) => {
              const pl = posLivePnl(p);
              const pd = getInstrument(p.symbol)?.digits ?? 2;
              return (
                <div key={p.id} className="rounded-lg border border-border/50 bg-card/50 p-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", p.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{p.side.toUpperCase()}</span>
                    <span className="font-semibold">{p.symbol}</span>
                    <span className="font-number text-muted-foreground">{p.lots} lots @ {p.entry.toFixed(pd)}</span>
                    <b className={cn("font-number ml-auto", (pl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400")}>{pl != null ? `${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}` : "—"}</b>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>SL <input type="number" step="any" className="num-input h-6 w-20" defaultValue={p.sl ?? ""} placeholder="—"
                      onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== p.sl) void modifyPosition(p.id, { sl: v }); }} /></span>
                    <span>TP <input type="number" step="any" className="num-input h-6 w-20" defaultValue={p.tp ?? ""} placeholder="—"
                      onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== p.tp) void modifyPosition(p.id, { tp: v }); }} /></span>
                    {p.lots >= 0.02 && (
                      <button onClick={async () => { const r = await closePosition(p.id, Math.max(0.01, Math.round(p.lots / 2 * 100) / 100)); if (r) toast({ title: `Closed 50% — ${r.closed.pnl >= 0 ? "+" : ""}$${r.closed.pnl.toFixed(2)}` }); }}
                        className="rounded border border-border/60 px-1.5 py-1 font-semibold hover:text-foreground">½</button>
                    )}
                    <button onClick={async () => { const r = await closePosition(p.id); if (r) toast({ title: `Closed ${p.symbol}`, description: `${r.closed.pnl >= 0 ? "+" : ""}$${r.closed.pnl.toFixed(2)} @ ${r.closed.exit.toFixed(pd)}` }); }}
                      className="ml-auto rounded bg-destructive/15 px-2 py-1 font-semibold text-red-400 hover:bg-destructive/25">Close</button>
                  </div>
                </div>
              );
            })}
            {orders.length > 0 && (
              <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pending orders</div>
            )}
            {orders.map((o) => (
              <div key={o.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", o.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{o.side.toUpperCase()}</span>
                <div className="min-w-0 flex-1 text-[11px]">
                  <span className="font-semibold">{o.symbol}</span> · {o.lots} lots
                  <span className="text-muted-foreground"> {o.kind} @ {o.price.toFixed(getInstrument(o.symbol)?.digits ?? 2)}</span>
                </div>
                <button onClick={async () => { if (await cancelOrder(o.id)) toast({ title: "Order cancelled" }); }}
                  className="rounded border border-border/60 px-2 py-1 font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            ))}
            {open.length > 0 && (
              <button onClick={async () => {
                if (!window.confirm(`Close all ${open.length} positions?`)) return;
                for (const p of open) await closePosition(p.id);
              }} className="w-full rounded-lg border border-destructive/40 py-1.5 text-[11px] font-semibold text-red-400">{t("closeAll")}</button>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-2">
            {historyQ.isLoading && <div className="py-6 text-center text-muted-foreground">Loading…</div>}
            {!historyQ.isLoading && !historyQ.data?.length && <div className="py-6 text-center text-muted-foreground">{t("noHistory")}</div>}
            {historyQ.data?.map((tr) => (
              <div key={tr.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", tr.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{tr.side === "buy" ? "B" : "S"}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold">{tr.symbol} · {tr.lots} lots · <span className="text-muted-foreground">{tr.reason}</span></div>
                  <div className="text-[10px] text-muted-foreground">
                    {tr.entry.toFixed(getInstrument(tr.symbol)?.digits ?? 2)} → {tr.exit.toFixed(getInstrument(tr.symbol)?.digits ?? 2)} · {new Date(tr.closedAt).toLocaleDateString()}
                  </div>
                </div>
                <b className={cn("font-number", tr.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{tr.pnl >= 0 ? "+" : ""}${tr.pnl.toFixed(2)}</b>
                <button onClick={() => saveToJournal(tr)} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" title="Save to journal">📖</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {user == null && <div className="border-t border-border/40 p-2 text-center text-[10px] text-muted-foreground">Sign in to trade on a virtual account.</div>}
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
