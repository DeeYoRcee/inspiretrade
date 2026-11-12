/**
 * ReplayTradingPanel — simulated replay trading desk (§3/§13).
 * Order ticket (market/limit/stop, lots by risk, SL/TP), account bar
 * (equity / balance / floating / used & free margin), open positions with
 * modify SL-TP + partial close, pending order management, closed trade
 * history with one-click journaling. Everything is SIMULATED — no broker
 * order leaves the browser.
 */
import { useMemo, useState } from "react";
import { BookOpen, Settings2, X } from "lucide-react";
import { getInstrument } from "@shared/terminal";
import { lotsForRisk, pipSize, pnlOf, type ReplayClosedTrade } from "@/lib/terminal/replay-engine";
import { Stat } from "./ToolDrawer";
import type { ReplaySession } from "@/hooks/use-replay";
import { cn } from "@/lib/utils";

type OrdType = "market" | "limit" | "stop";

export function ReplayTradingPanel({ rs, onJournal }: {
  rs: ReplaySession;
  onJournal: (t: ReplayClosedTrade) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<OrdType>("market");
  const [lots, setLots] = useState(0.1);
  const [price, setPrice] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [riskPct, setRiskPct] = useState(1);
  const [showCfg, setShowCfg] = useState(false);
  const [partial, setPartial] = useState<Record<string, string>>({});

  const sym = rs.symbol;
  const inst = getInstrument(sym);
  void inst;
  const digits = getInstrument(sym)?.digits ?? 4;
  const pip = pipSize(sym);
  const px = rs.cursorBar?.close ?? 0;
  const slNum = sl ? Number(sl) : null;
  const tpNum = tp ? Number(tp) : null;

  // risk-based sizing helper
  const suggestedLots = useMemo(() => {
    const dist = slNum != null ? Math.abs(px - slNum) : 0;
    if (!dist) return null;
    return lotsForRisk(sym, (rs.equity * riskPct) / 100, dist);
  }, [slNum, px, rs.equity, riskPct, sym]);

  const submit = () => {
    const req = { symbol: sym, side, lots, sl: slNum, tp: tpNum };
    let ok = false;
    if (type === "market") ok = !!rs.open(req);
    else {
      if (!price) { rs.setNotice("Enter a price for the pending order"); return; }
      ok = !!rs.pending({ ...req, type, price: Number(price) });
    }
    if (ok) setPrice("");
  };

  const positions = rs.engine.positions.filter((p) => p.symbol === sym);
  const orders = rs.engine.orders.filter((o) => o.symbol === sym);
  const closed = rs.engine.closed.filter((t) => t.symbol === sym).slice().reverse();

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2.5 text-[11px]">
      {/* account bar */}
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Equity" value={`$${rs.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} tone={rs.equity >= rs.cfg.startingBalance ? "up" : "down"} />
        <Stat label="Balance" value={`$${rs.engine.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <Stat label="Floating" value={`${rs.floating >= 0 ? "+" : ""}$${rs.floating.toFixed(2)}`} tone={rs.floating >= 0 ? "up" : "down"} />
        <Stat label="Used margin" value={`$${rs.usedMargin.toFixed(2)}`} />
        <Stat label="Free margin" value={`$${rs.freeMargin.toFixed(2)}`} />
        <Stat label="Leverage" value={`1:${rs.cfg.leverage}`} />
      </div>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>SIMULATED REPLAY TRADING — no real orders are sent.</span>
        <button onClick={() => setShowCfg((v) => !v)} className="flex items-center gap-1 hover:text-foreground"><Settings2 className="h-3 w-3" />setup</button>
      </div>

      {showCfg && (
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border/50 bg-card/40 p-2">
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Balance</span>
            <input type="number" defaultValue={rs.cfg.startingBalance} onBlur={(e) => rs.setCfg({ startingBalance: Number(e.target.value) })} className="num-input h-6 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Leverage</span>
            <input type="number" defaultValue={rs.cfg.leverage} onBlur={(e) => rs.setCfg({ leverage: Math.max(1, Number(e.target.value)) })} className="num-input h-6 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Currency</span>
            <input value={rs.cfg.currency} disabled className="num-input h-6 w-full opacity-60" title="USD reference model" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Spread (pips)</span>
            <input type="number" step="any" defaultValue={rs.cfg.spreadPips} onBlur={(e) => rs.setCfg({ spreadPips: Number(e.target.value) })} className="num-input h-6 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Commission %/side</span>
            <input type="number" step="any" defaultValue={rs.cfg.commissionPct} onBlur={(e) => rs.setCfg({ commissionPct: Number(e.target.value) })} className="num-input h-6 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Slippage (pips)</span>
            <input type="number" step="any" defaultValue={rs.cfg.slippagePips} onBlur={(e) => rs.setCfg({ slippagePips: Number(e.target.value) })} className="num-input h-6 w-full" /></label>
          <p className="col-span-3 text-[9px] text-muted-foreground">Changing balance resets the simulated account. Spread/commission/slippage apply to NEW orders.</p>
        </div>
      )}

      {/* order ticket */}
      <div className="rounded-xl border border-border/50 bg-card/40 p-2">
        <div className="mb-1.5 flex items-center gap-1.5">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className={cn("flex-1 rounded-lg py-1 text-[11px] font-black", s === "buy" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400", side !== s && "opacity-40")}>
              {s.toUpperCase()}
            </button>
          ))}
          <div className="flex overflow-hidden rounded-lg border border-border/60 text-[10px]">
            {(["market", "limit", "stop"] as OrdType[]).map((t) => (
              <button key={t} onClick={() => setType(t)} className={cn("px-2 py-1 font-bold uppercase", type === t ? "bg-muted text-foreground" : "text-muted-foreground")}>{t}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <label className="space-y-0.5 col-span-1"><span className="text-[9px] uppercase text-muted-foreground">Lots</span>
            <input type="number" step="0.01" min="0.01" value={lots} onChange={(e) => setLots(Number(e.target.value))} className="num-input h-7 w-full" /></label>
          {type !== "market" && (
            <label className="space-y-0.5 col-span-2"><span className="text-[9px] uppercase text-muted-foreground">Order price</span>
              <input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={px.toFixed(digits)} className="num-input h-7 w-full" /></label>
          )}
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">Risk %</span>
            <input type="number" step="any" value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} title="For risk-based sizing" className="num-input h-7 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">SL price</span>
            <input type="number" step="any" value={sl} onChange={(e) => setSl(e.target.value)} placeholder={side === "buy" ? (px - 50 * pip).toFixed(digits) : (px + 50 * pip).toFixed(digits)} className="num-input h-7 w-full" /></label>
          <label className="space-y-0.5"><span className="text-[9px] uppercase text-muted-foreground">TP price</span>
            <input type="number" step="any" value={tp} onChange={(e) => setTp(e.target.value)} placeholder={side === "buy" ? (px + 100 * pip).toFixed(digits) : (px - 100 * pip).toFixed(digits)} className="num-input h-7 w-full" /></label>
        </div>
        <div className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground">
          <span>
            {slNum && suggestedLots ? <>risk {riskPct}% → <button className="text-sky-400 underline" onClick={() => setLots(suggestedLots)}>use {suggestedLots} lots</button></> : "set SL for risk-based sizing"}
            {slNum && tpNum && px ? <> · R:R <b className="text-foreground">1:{(Math.abs(tpNum - px) / Math.abs(px - slNum)).toFixed(2)}</b></> : null}
          </span>
          <span>spread {rs.cfg.spreadPips}p · slip {rs.cfg.slippagePips}p · comm {rs.cfg.commissionPct}%</span>
        </div>
        <button onClick={submit} className={cn("mt-1.5 w-full rounded-lg py-2 text-xs font-black", side === "buy" ? "bg-emerald-500/25 text-emerald-300 hover:bg-emerald-500/35" : "bg-red-500/25 text-red-300 hover:bg-red-500/35")}>
          {type === "market" ? `${side.toUpperCase()} ${lots} LOTS @ MARKET` : `PLACE ${side.toUpperCase()} ${type.toUpperCase()} @ ${price || "…"}`}
        </button>
      </div>

      {/* positions */}
      {positions.length > 0 && (
        <section className="min-h-0 space-y-1 overflow-y-auto">
          <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Open positions ({positions.length})</div>
          {positions.map((p) => {
            const bid = rs.cursorBar?.close ?? p.entry;
            const pnl = pnlOf(p, p.lots, bid, rs.cfg);
            return (
              <div key={p.id} className="rounded-lg border border-border/40 bg-card/40 p-1.5">
                <div className="flex items-center gap-1.5">
                  <b className={p.side === "buy" ? "text-emerald-400" : "text-red-400"}>{p.side === "buy" ? "LONG" : "SHORT"}</b>
                  <span className="font-number">{p.lots}</span>
                  <span className="font-number text-muted-foreground">@ {p.entry.toFixed(digits)}</span>
                  <b className={cn("ml-auto font-number", pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}</b>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <input type="number" step="any" placeholder={`SL ${p.sl?.toFixed(digits) ?? "—"}`} defaultValue={p.sl ?? ""} key={`sl-${p.id}-${p.sl}`}
                    onBlur={(e) => e.target.value && rs.modify(p.id, { sl: Number(e.target.value) })} className="num-input h-6 w-24 text-[10px]" title="Modify SL (blur to apply)" />
                  <input type="number" step="any" placeholder={`TP ${p.tp?.toFixed(digits) ?? "—"}`} defaultValue={p.tp ?? ""} key={`tp-${p.id}-${p.tp}`}
                    onBlur={(e) => e.target.value && rs.modify(p.id, { tp: Number(e.target.value) })} className="num-input h-6 w-24 text-[10px]" title="Modify TP (blur to apply)" />
                  <input type="number" step="0.01" min="0.01" placeholder="lots" value={partial[p.id] ?? ""} onChange={(e) => setPartial((m) => ({ ...m, [p.id]: e.target.value }))}
                    className="num-input h-6 w-16 text-[10px]" title="Partial close lots" />
                  {partial[p.id] && <button onClick={() => { rs.close(p.id, Number(partial[p.id])); setPartial((m) => ({ ...m, [p.id]: "" })); }} className="rounded border border-border/60 px-1.5 py-0.5 text-[9px] hover:text-foreground">Partial</button>}
                  <button onClick={() => rs.close(p.id)} className="ml-auto rounded bg-red-500/20 px-2 py-0.5 text-[9px] font-bold text-red-400 hover:bg-red-500/30">CLOSE</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* pending orders */}
      {orders.length > 0 && (
        <section className="min-h-0 space-y-1 overflow-y-auto">
          <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Pending orders ({orders.length})</div>
          {orders.map((o) => (
            <div key={o.id} className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1">
              <b className={o.side === "buy" ? "text-emerald-400" : "text-red-400"}>{o.side.toUpperCase()}</b>
              <span className="uppercase text-muted-foreground">{o.type}</span>
              <span className="font-number">{o.lots}</span>
              <span className="font-number">@ {o.price.toFixed(digits)}</span>
              <button onClick={() => rs.cancelOrder(o.id)} className="ml-auto text-muted-foreground hover:text-red-400" title="Cancel"><X className="h-3 w-3" /></button>
            </div>
          ))}
        </section>
      )}

      {/* closed history */}
      <section className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Trade history ({closed.length})</div>
        {!closed.length && <div className="py-3 text-center text-[10px] text-muted-foreground">No closed trades yet — trade on the historical chart above.</div>}
        {closed.map((t) => (
          <div key={t.id} className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-card/40 px-2 py-1 text-[10px]">
            <b className={t.side === "buy" ? "text-emerald-400" : "text-red-400"}>{t.side === "buy" ? "L" : "S"}</b>
            <span className="font-number">{t.lots}</span>
            <span className="font-number text-muted-foreground">{t.entry.toFixed(digits)}→{t.exit.toFixed(digits)}</span>
            <span className="uppercase text-muted-foreground">{t.reason}{t.slConservative ? "*" : null}</span>
            <b className={cn("font-number", t.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</b>
            {t.journalId ? (
              <span className="ml-auto text-emerald-400" title="Journaled"><BookOpen className="h-3 w-3" /></span>
            ) : (
              <button onClick={() => onJournal(t)} className="ml-auto text-muted-foreground hover:text-sky-400" title="Add to journal"><BookOpen className="h-3 w-3" /></button>
            )}
          </div>
        ))}
        {closed.some((t) => t.slConservative) && <p className="text-[9px] text-muted-foreground">(*) SL &amp; TP were both touched inside one candle — the conservative stop-first assumption was applied.</p>}
      </section>
    </div>
  );
}
