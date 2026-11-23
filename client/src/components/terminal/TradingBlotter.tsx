/**
 * TradingBlotter — the professional positions panel below the chart.
 *
 * Tabs: Positions | Pending Orders | History | Account Statistics.
 * All data comes from the SERVER account state (10s heartbeat); the live
 * current price and floating P/L between syncs come from the shared price
 * store. Closing a position (single, half or all) always asks for
 * confirmation. SL/TP edit inline; pending orders open a modify dialog.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { getInstrument } from "@shared/terminal";
import { exitPriceFor, positionPnlUsd, quoteFromMid } from "@shared/trading-engine";
import { useTrading } from "@/hooks/use-trading";
import { tradingApi, type ServerOrder, type ServerPosition, type ServerTrade } from "@/lib/trading-api";
import { usePriceMap } from "@/lib/price-store";
import { useAuth } from "@/hooks/use-auth";
import { db, auth } from "@/lib/firebase";
import { push, ref } from "firebase/database";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Tab = "positions" | "orders" | "history" | "stats";

export function TradingBlotter({ symbol, className }: { symbol: string; className?: string }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const {
    account, metrics, busy,
    positions, orders,
    closePosition, closeAll, modifyPosition, modifyOrder, cancelOrder,
  } = useTrading();
  const priceMap = usePriceMap();

  const [tab, setTab] = useState<Tab>("positions");
  const [editingOrder, setEditingOrder] = useState<ServerOrder | null>(null);

  // live conversion prices: server quote mids + the live chart price
  const prices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [s, q] of Object.entries(account?.quotes ?? {})) out[s] = q.mid;
    for (const [s, v] of Object.entries(priceMap)) if (v != null) out[s] = v;
    return out;
  }, [account?.quotes, priceMap]);

  const livePnl = (p: ServerPosition): number | null => {
    const instP = getInstrument(p.symbol);
    const mid = prices[p.symbol];
    if (!instP || mid == null) return null;
    const q = quoteFromMid(mid, instP, "live", true);
    return positionPnlUsd(instP, p.side, p.lots, p.entry, exitPriceFor(p.side, q), prices);
  };

  const historyQ = useQuery({
    queryKey: ["tradingHistory", account?.id],
    enabled: !!account && (tab === "history" || tab === "stats"),
    queryFn: () => tradingApi.getHistory(account!.id, 200),
  });

  // ---- auto-journal: every closed server trade lands in the user's journal ----
  // Deduped by a per-uid localStorage marker so refreshes and refetches never
  // create duplicate entries (the user can still journal manually too).
  const autoSavedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    const trades: ServerTrade[] | undefined = historyQ.data;
    if (!uid || !trades?.length) return;
    if (!autoSavedRef.current) {
      try { autoSavedRef.current = new Set(JSON.parse(localStorage.getItem(`it_journal_auto_${uid}`) || "[]")); }
      catch { autoSavedRef.current = new Set(); }
    }
    const saved = autoSavedRef.current!;
    let dirty = false;
    for (const tr of trades) {
      const key = `${tr.symbol}-${tr.entry}-${tr.closedAt}-${tr.side}`;
      if (saved.has(key)) continue;
      saved.add(key);
      dirty = true;
      void saveToJournal(tr, true);
    }
    if (dirty) {
      try { localStorage.setItem(`it_journal_auto_${uid}`, JSON.stringify([...saved].slice(-500))); }
      catch { /* quota — best effort */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyQ.data]);

  useEffect(() => {
    if (account && (tab === "history" || tab === "stats")) {
      void qc.invalidateQueries({ queryKey: ["tradingHistory", account.id] });
    }
  }, [tab, account?.id, qc]);

  const saveToJournal = async (tr: ServerTrade, silent = false) => {
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
        exitTime: tr.closedAt,
        instrumentSymbol: tr.symbol,
        instrumentName: getInstrument(tr.symbol)?.name ?? tr.symbol,
        emotion: "neutral",
        comment: `Terminal ${account?.label ?? "DEMO"} (${tr.reason})`,
      });
      if (!silent) toast({ title: t("journalSaved") });
    } catch (e: any) {
      if (!silent) toast({ title: t("serverError"), description: String(e?.message || e), variant: "destructive" });
    }
  };

  const closeWithConfirm = async (p: ServerPosition) => {
    const r = await closePosition(p.id);
    if (r) toast({ title: `Closed ${p.symbol}`, description: `${r.closed.pnl >= 0 ? "+" : ""}$${r.closed.pnl.toFixed(2)} @ ${r.closed.exit.toFixed(getInstrument(p.symbol)?.digits ?? 2)}` });
  };

  const closeHalf = async (p: ServerPosition) => {
    const r = await closePosition(p.id, Math.max(0.01, Math.round((p.lots / 2) * 100) / 100));
    if (r) toast({ title: `Closed 50% of ${p.symbol}`, description: `${r.closed.pnl >= 0 ? "+" : ""}$${r.closed.pnl.toFixed(2)}` });
  };

  return (
    <div className={cn("flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-900/60 text-xs", className)}>
      {/* tab strip */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-1.5 py-1">
        {([
          ["positions", `Positions (${positions.length})`],
          ["orders", `Orders (${orders.length})`],
          ["history", t("tpHistory")],
          ["stats", "Statistics"],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors",
              tab === id ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        {tab === "positions" && positions.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button disabled={busy} className="ml-auto rounded-md border border-destructive/40 px-2 py-1 text-[11px] font-semibold text-red-400 hover:bg-destructive/10 disabled:opacity-40">
                {t("closeAll")}
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close all {positions.length} positions?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every open position is closed at the current server price and the realized P/L
                  lands on the account balance. Pending orders are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => { void closeAll(); }}>Close all</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" && (
          <PositionsTable
            positions={positions} prices={prices} livePnl={livePnl} busy={busy}
            onClose={closeWithConfirm} onCloseHalf={closeHalf}
            onModify={(p, patch) => modifyPosition(p.id, patch)}
          />
        )}
        {tab === "orders" && (
          <OrdersTable
            orders={orders} busy={busy}
            onCancel={async (o) => { if (await cancelOrder(o.id)) toast({ title: "Order cancelled" }); }}
            onEdit={(o) => setEditingOrder(o)}
          />
        )}
        {tab === "history" && (
          <HistoryTable q={historyQ} onJournal={saveToJournal} />
        )}
        {tab === "stats" && (
          <StatsTab
            metrics={metrics} account={account}
            historyQ={historyQ}
            onCreateChallengeHint={tab === "stats"}
          />
        )}
      </div>

      {/* pending-order modify dialog */}
      {editingOrder && account && (
        <ModifyOrderDialog
          order={editingOrder}
          busy={busy}
          onClose={() => setEditingOrder(null)}
          onSave={async (patch) => {
            const ok = await modifyOrder(editingOrder.id, patch);
            if (ok) {
              toast({ title: "Order updated" });
              setEditingOrder(null);
            }
          }}
        />
      )}
      {user == null && (
        <div className="border-t border-border/40 p-2 text-center text-[10px] text-muted-foreground">
          Sign in to trade on a virtual account.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function PositionsTable({
  positions, prices, livePnl, busy, onClose, onCloseHalf, onModify,
}: {
  positions: ServerPosition[];
  prices: Record<string, number>;
  livePnl: (p: ServerPosition) => number | null;
  busy: boolean;
  onClose: (p: ServerPosition) => void;
  onCloseHalf: (p: ServerPosition) => void;
  onModify: (p: ServerPosition, patch: { sl?: number | null; tp?: number | null; tsPct?: number }) => void;
}) {
  const { t } = useLanguage();
  if (!positions.length) return <div className="py-8 text-center text-muted-foreground">{t("noOpenPositions")}</div>;
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-[11px]">
      <thead className="sticky top-0 bg-slate-900/95 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
        <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-semibold">
          <th>Symbol</th><th>Side</th><th className="text-right">Volume</th>
          <th className="text-right">Entry</th><th className="text-right">Current</th>
          <th className="text-right">SL</th><th className="text-right">TP</th>
          <th className="text-right">Swap</th><th className="text-right">P/L</th>
          <th className="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const inst = getInstrument(p.symbol);
          const dg = inst?.digits ?? 2;
          const mid = prices[p.symbol];
          const pl = livePnl(p);
          const swap = p.swapAccrued ?? 0;
          return (
            <tr key={p.id} className="border-t border-border/30 hover:bg-card/40 [&>td]:px-2 [&>td]:py-1">
              <td className="font-semibold">{p.symbol}</td>
              <td><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", p.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{p.side.toUpperCase()}</span></td>
              <td className="text-right font-number">{p.lots.toFixed(2)}</td>
              <td className="text-right font-number">{p.entry.toFixed(dg)}</td>
              <td className="text-right font-number">{mid != null ? mid.toFixed(dg) : "—"}</td>
              <td className="text-right">
                <input type="number" step="any" className="num-input h-6 w-20 text-right" defaultValue={p.sl ?? ""} placeholder="—"
                  onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== p.sl) onModify(p, { sl: v }); }} />
              </td>
              <td className="text-right">
                <input type="number" step="any" className="num-input h-6 w-20 text-right" defaultValue={p.tp ?? ""} placeholder="—"
                  onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== p.tp) onModify(p, { tp: v }); }} />
              </td>
              <td className={cn("text-right font-number", swap < 0 && "text-red-400", swap > 0 && "text-emerald-400")}>{swap ? `${swap > 0 ? "+" : ""}$${swap.toFixed(2)}` : "—"}</td>
              <td className={cn("text-right font-number font-semibold", (pl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400")}>
                {pl != null ? `${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}` : "—"}
              </td>
              <td>
                <div className="flex items-center justify-end gap-1">
                  {/* P54 §4 — breakeven: SL to the entry price (server re-validates
                      against the live price and rejects with a clear error if the
                      market has already moved past entry) */}
                  <button
                    disabled={busy || (p.side === "buy" ? p.sl != null && p.sl >= p.entry : p.sl != null && p.sl <= p.entry)}
                    onClick={() => onModify(p, { sl: p.entry })}
                    className="rounded border border-border/60 px-1.5 py-0.5 font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
                    title="Breakeven — move Stop Loss to the entry price"
                  >BE</button>
                  {/* P54 §4 — trailing stop: ratcheting SL in % of price (0 = off) */}
                  <select
                    aria-label="Trailing stop"
                    title="Trailing stop — the stop follows the price in your favor"
                    disabled={busy}
                    value={p.tsPct ? String(p.tsPct) : "0"}
                    onChange={(e) => onModify(p, { tsPct: Number(e.target.value) })}
                    className={cn(
                      "h-5 rounded border border-border/60 bg-transparent px-0.5 text-[10px] font-semibold",
                      p.tsPct ? "text-emerald-400" : "text-muted-foreground",
                    )}
                  >
                    <option value="0">TS off</option>
                    <option value="0.5">TS 0.5%</option>
                    <option value="1">TS 1%</option>
                    <option value="2">TS 2%</option>
                  </select>
                  {p.lots >= 0.02 && (
                    <button disabled={busy} onClick={() => onCloseHalf(p)} className="rounded border border-border/60 px-1.5 py-0.5 font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40" title="Close half">½</button>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button disabled={busy} className="rounded bg-destructive/15 px-2 py-0.5 font-semibold text-red-400 hover:bg-destructive/25 disabled:opacity-40">Close</button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Close {p.side.toUpperCase()} {p.lots.toFixed(2)} {p.symbol}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The position closes at the current server price; the realized result is booked
                          to the account balance immediately.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onClose(p)}>Close position</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}

// ---------------------------------------------------------------------------
// Pending orders
// ---------------------------------------------------------------------------

function OrdersTable({
  orders, busy, onCancel, onEdit,
}: {
  orders: ServerOrder[];
  busy: boolean;
  onCancel: (o: ServerOrder) => void;
  onEdit: (o: ServerOrder) => void;
}) {
  if (!orders.length) return <div className="py-8 text-center text-muted-foreground">No pending orders.</div>;
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-[11px]">
      <thead className="sticky top-0 bg-slate-900/95 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
        <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-semibold">
          <th>Symbol</th><th>Side</th><th>Type</th><th className="text-right">Volume</th>
          <th className="text-right">Trigger</th><th className="text-right">SL</th><th className="text-right">TP</th>
          <th className="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const dg = getInstrument(o.symbol)?.digits ?? 2;
          return (
            <tr key={o.id} className="border-t border-border/30 hover:bg-card/40 [&>td]:px-2 [&>td]:py-1">
              <td className="font-semibold">{o.symbol}</td>
              <td><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", o.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{o.side.toUpperCase()}</span></td>
              <td className="font-semibold capitalize text-amber-400">{o.side === "buy" ? (o.kind === "limit" ? "Buy Limit" : "Buy Stop") : (o.kind === "limit" ? "Sell Limit" : "Sell Stop")}</td>
              <td className="text-right font-number">{o.lots.toFixed(2)}</td>
              <td className="text-right font-number">{o.price.toFixed(dg)}</td>
              <td className="text-right font-number">{o.sl?.toFixed(dg) ?? "—"}</td>
              <td className="text-right font-number">{o.tp?.toFixed(dg) ?? "—"}</td>
              <td>
                <div className="flex items-center justify-end gap-1">
                  <button disabled={busy} onClick={() => onEdit(o)} className="rounded border border-border/60 px-2 py-0.5 font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40">Modify</button>
                  <button disabled={busy} onClick={() => onCancel(o)} className="rounded bg-destructive/15 px-2 py-0.5 font-semibold text-red-400 hover:bg-destructive/25 disabled:opacity-40">Cancel</button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}

function ModifyOrderDialog({
  order, busy, onClose, onSave,
}: {
  order: ServerOrder;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: { price?: number; lots?: number; sl?: number | null; tp?: number | null }) => void;
}) {
  const dg = getInstrument(order.symbol)?.digits ?? 2;
  const [price, setPrice] = useState(String(order.price));
  const [lots, setLots] = useState(String(order.lots));
  const [sl, setSl] = useState(order.sl != null ? String(order.sl) : "");
  const [tp, setTp] = useState(order.tp != null ? String(order.tp) : "");
  const num = (v: string, fallback: number | null) => (v === "" ? fallback : Number(v));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Modify {order.side === "buy" ? "Buy" : "Sell"} {order.kind} — {order.symbol}</DialogTitle>
          <DialogDescription>Trigger price, volume, Stop Loss and Take Profit are re-validated against the live market price server-side.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="col-span-2"><span className="mb-0.5 block text-[10px] text-muted-foreground">Trigger price</span>
            <input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} className="num-input" /></label>
          <label><span className="mb-0.5 block text-[10px] text-muted-foreground">Volume (lots)</span>
            <input type="number" step="0.01" min="0.01" value={lots} onChange={(e) => setLots(e.target.value)} className="num-input" /></label>
          <div />
          <label><span className="mb-0.5 block text-[10px] text-muted-foreground">Stop Loss (empty = none)</span>
            <input type="number" step="any" value={sl} onChange={(e) => setSl(e.target.value)} className="num-input" placeholder={order.sl?.toFixed(dg) ?? "—"} /></label>
          <label><span className="mb-0.5 block text-[10px] text-muted-foreground">Take Profit (empty = none)</span>
            <input type="number" step="any" value={tp} onChange={(e) => setTp(e.target.value)} className="num-input" placeholder={order.tp?.toFixed(dg) ?? "—"} /></label>
        </div>
        <DialogFooter>
          <button onClick={onClose} className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
          <button
            disabled={busy}
            onClick={() => onSave({
              price: Number(price), lots: Number(lots),
              sl: num(sl, null), tp: num(tp, null),
            })}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40"
          >Save</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTable({ q, onJournal }: { q: { isLoading: boolean; data?: ServerTrade[] | null }; onJournal: (tr: ServerTrade) => void }) {
  const { t } = useLanguage();
  // P54 §5 — history filters: instrument, direction, close reason, date range
  const [fSymbol, setFSymbol] = useState("all");
  const [fSide, setFSide] = useState("all");
  const [fReason, setFReason] = useState("all");
  const [fDays, setFDays] = useState(0); // 0 = all time
  const all = q.data ?? [];
  const symbols = useMemo(() => [...new Set(all.map((x) => x.symbol))].sort(), [all]);
  const reasons = useMemo(() => [...new Set(all.map((x) => x.reason))].sort(), [all]);
  const rows = useMemo(() => all.filter((tr) =>
    (fSymbol === "all" || tr.symbol === fSymbol) &&
    (fSide === "all" || tr.side === fSide) &&
    (fReason === "all" || tr.reason === fReason) &&
    (fDays <= 0 || tr.closedAt >= Date.now() - fDays * 86400_000),
  ), [all, fSymbol, fSide, fReason, fDays]);
  if (q.isLoading) return <div className="py-8 text-center text-muted-foreground">Loading…</div>;
  if (!all.length) return <div className="py-8 text-center text-muted-foreground">{t("noHistory")}</div>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-2 py-1.5 text-[11px]">
        <select value={fSymbol} onChange={(e) => setFSymbol(e.target.value)} aria-label="Filter by instrument" className="h-6 rounded border border-border/60 bg-transparent px-1 text-slate-300">
          <option value="all">All instruments</option>
          {symbols.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={fSide} onChange={(e) => setFSide(e.target.value)} aria-label="Filter by direction" className="h-6 rounded border border-border/60 bg-transparent px-1 text-slate-300">
          <option value="all">Buy & Sell</option><option value="buy">Buy</option><option value="sell">Sell</option>
        </select>
        <select value={fReason} onChange={(e) => setFReason(e.target.value)} aria-label="Filter by close reason" className="h-6 rounded border border-border/60 bg-transparent px-1 text-slate-300">
          <option value="all">All reasons</option>
          {reasons.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={String(fDays)} onChange={(e) => setFDays(Number(e.target.value))} aria-label="Filter by date" className="h-6 rounded border border-border/60 bg-transparent px-1 text-slate-300">
          <option value="0">All time</option><option value="1">Last 24h</option><option value="7">7 days</option><option value="30">30 days</option>
        </select>
        <span className="ml-auto text-[10px] text-muted-foreground">{rows.length} / {all.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-muted-foreground">No trades match the filters</div>
      ) : (
      <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-[11px]">
      <thead className="sticky top-0 bg-slate-900/95 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
        <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-semibold">
          <th>Closed</th><th>Symbol</th><th>Side</th><th className="text-right">Volume</th>
          <th className="text-right">Entry</th><th className="text-right">Exit</th>
          <th className="text-right">Swap</th><th>Reason</th><th className="text-right">P/L</th><th />
        </tr>
      </thead>
      <tbody>
        {rows.map((tr) => {
          const dg = getInstrument(tr.symbol)?.digits ?? 2;
          return (
            <tr key={tr.id} className="border-t border-border/30 hover:bg-card/40 [&>td]:px-2 [&>td]:py-1">
              <td className="text-muted-foreground">{new Date(tr.closedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
              <td className="font-semibold">{tr.symbol}</td>
              <td><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", tr.side === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")}>{tr.side === "buy" ? "B" : "S"}</span></td>
              <td className="text-right font-number">{tr.lots.toFixed(2)}</td>
              <td className="text-right font-number">{tr.entry.toFixed(dg)}</td>
              <td className="text-right font-number">{tr.exit.toFixed(dg)}</td>
              <td className={cn("text-right font-number", (tr.swap ?? 0) < 0 && "text-red-400", (tr.swap ?? 0) > 0 && "text-emerald-400")}>{tr.swap ? `${tr.swap > 0 ? "+" : ""}$${tr.swap.toFixed(2)}` : "—"}</td>
              <td className="text-muted-foreground">{tr.reason}</td>
              <td className={cn("text-right font-number font-semibold", tr.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{tr.pnl >= 0 ? "+" : ""}${tr.pnl.toFixed(2)}</td>
              <td>
                <button onClick={() => onJournal(tr)} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" title="Save to journal">📖</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function StatsTab({
  metrics, account, historyQ,
}: {
  metrics: { balance: number; equity: number; floatingPnl: number; usedMargin: number; freeMargin: number; marginLevel: number | null } | null;
  account: ReturnType<typeof useTrading>["account"];
  historyQ: { isLoading: boolean; data?: ServerTrade[] | null };
  onCreateChallengeHint: boolean;
}) {
  if (!account || !metrics) return <div className="py-8 text-center text-muted-foreground">No account yet.</div>;
  const trades = historyQ.data ?? [];
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  const rule = account.ruleState;

  return (
    <div className="space-y-4 p-3">
      {/* status */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(
          "rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide",
          account.status === "active" && "bg-emerald-500/15 text-emerald-400",
          account.status === "passed" && "bg-sky-500/15 text-sky-400",
          account.status === "failed" && "bg-red-500/15 text-red-400",
        )}>
          {account.status === "active" ? "ACTIVE" : account.status === "passed" ? "PASSED ✓" : "FAILED ✕"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {account.label} · {account.type} · 1:{account.leverage} leverage · ${account.startingBalance.toLocaleString()} start
        </span>
        {account.status === "failed" && account.failedReason && (
          <span className="text-[11px] font-semibold text-red-400">{account.failedReason}</span>
        )}
      </div>

      {/* account numbers */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatBox label="Balance" value={`$${metrics.balance.toFixed(2)}`} />
        <StatBox label="Equity" value={`$${metrics.equity.toFixed(2)}`} />
        <StatBox label="Floating P/L" value={`${metrics.floatingPnl >= 0 ? "+" : ""}$${metrics.floatingPnl.toFixed(2)}`} tone={metrics.floatingPnl > 0 ? "up" : metrics.floatingPnl < 0 ? "down" : undefined} />
        <StatBox label="Used margin" value={`$${metrics.usedMargin.toFixed(2)}`} />
        <StatBox label="Free margin" value={`$${metrics.freeMargin.toFixed(2)}`} />
        <StatBox label="Margin level" value={metrics.marginLevel != null ? `${metrics.marginLevel.toFixed(0)}%` : "—"} />
      </div>

      {/* prop rules progress */}
      {rule && account.rules && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <RuleStateBar
            label="Daily loss limit"
            detail={rule.dailyLossLimitUsd != null ? `$${Math.max(0, rule.dailyLossUsd).toFixed(2)} / $${rule.dailyLossLimitUsd.toFixed(2)}` : "off"}
            value={rule.dailyLossUsed}
            tone="danger"
          />
          <RuleStateBar
            label="Max drawdown"
            detail={rule.maxDrawdownUsd != null ? `$${Math.max(0, rule.drawdownUsd).toFixed(2)} / $${rule.maxDrawdownUsd.toFixed(2)}` : "off"}
            value={rule.drawdownUsed}
            tone="danger"
          />
          <RuleStateBar
            label="Profit target"
            detail={rule.targetUsd != null ? `$${Math.max(0, metrics.equity - account.startingBalance).toFixed(2)} / $${rule.targetUsd.toFixed(2)}` : "off"}
            value={rule.targetProgress}
            tone="good"
          />
          <RuleStateBar
            label="Trading days"
            detail={`${account.tradingDays} / ${account.rules.minTradingDays} min`}
            value={account.rules.minTradingDays > 0 ? account.tradingDays / account.rules.minTradingDays : 1}
            tone="good"
          />
          <p className="col-span-full text-[11px] text-muted-foreground">
            Peak equity: <b className="font-number text-foreground">${rule.peakEquity.toFixed(2)}</b>
            {account.rules.maxLotsTotal != null && <> · Max combined lots: <b className="text-foreground">{account.rules.maxLotsTotal}</b></>}
            {account.rules.maxLotsPerOrder != null && <> · Max per order: <b className="text-foreground">{account.rules.maxLotsPerOrder}</b></>}
            {account.rules.maxOpenPositions != null && <> · Max positions/orders: <b className="text-foreground">{account.rules.maxOpenPositions}</b></>}
            {rule.targetReached && !rule.canPass && (
              <> · <span className="text-amber-400">Target reached — close all positions{account.tradingDays < account.rules.minTradingDays ? ` and trade ${account.rules.minTradingDays - account.tradingDays} more day(s) to pass` : " to pass"}</span></>
            )}
          </p>
        </div>
      )}

      {/* trade stats (from the fills ledger) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatBox label="Closed trades" value={String(trades.length)} />
        <StatBox label="Win rate" value={trades.length ? `${((wins.length / trades.length) * 100).toFixed(0)}%` : "—"} />
        <StatBox label="Profit factor" value={pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2)} />
        <StatBox label="Total P/L" value={`${trades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}$${trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`} tone={trades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "up" : "down"} />
        <StatBox label="Best trade" value={wins.length ? `+$${Math.max(...wins.map((t) => t.pnl)).toFixed(2)}` : "—"} tone="up" />
        <StatBox label="Worst trade" value={losses.length ? `-$${Math.abs(Math.min(...losses.map((t) => t.pnl))).toFixed(2)}` : "—"} tone="down" />
      </div>
      {historyQ.isLoading && <p className="text-[11px] text-muted-foreground">Loading trade stats…</p>}
    </div>
  );
}

function StatBox({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-number text-sm font-semibold", tone === "up" && "text-emerald-400", tone === "down" && "text-red-400")}>{value}</div>
    </div>
  );
}

function RuleStateBar({ label, detail, value, tone }: { label: string; detail: string; value: number; tone: "danger" | "good" }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 px-2.5 py-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        <span className="font-number text-foreground">{detail}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border/50">
        <div
          className={cn("h-full rounded-full transition-all", tone === "danger" ? (value >= 1 ? "bg-red-500" : value > 0.75 ? "bg-amber-500" : "bg-sky-500") : "bg-emerald-500")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
