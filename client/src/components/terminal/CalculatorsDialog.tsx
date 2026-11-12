/**
 * CalculatorsDialog — professional calculator toolbox: position size, pip
 * value, lot size, risk/reward, margin, P/L, Fibonacci, drawdown and
 * compounding. Contract specs come from the instrument catalog; for
 * non-USD-quoted instruments the current price converts honestly and the
 * currency used is displayed.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { INSTRUMENTS, getInstrument } from "@shared/terminal";
import { pipValue, positionSize, margin, profitLoss, fibonacci, drawdown, compounding, riskReward } from "@/lib/terminal/calculators";
import { cn } from "@/lib/utils";

type Tab = "position" | "pip" | "lot" | "rr" | "margin" | "pl" | "fib" | "dd" | "compound";

const TABS: { id: Tab; label: string }[] = [
  { id: "position", label: "Position size" },
  { id: "pip", label: "Pip value" },
  { id: "lot", label: "Lot size" },
  { id: "rr", label: "Risk / Reward" },
  { id: "margin", label: "Margin" },
  { id: "pl", label: "Profit / Loss" },
  { id: "fib", label: "Fibonacci" },
  { id: "dd", label: "Drawdown" },
  { id: "compound", label: "Compounding" },
];

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex items-center justify-between gap-2 py-1">
    <span className="text-[11px] text-muted-foreground">{label}</span>{children}
  </label>
);
const Out = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className={cn("flex items-center justify-between rounded-lg px-2 py-1.5", strong ? "bg-emerald-500/10" : "bg-card/60")}>
    <span className="text-[11px] text-muted-foreground">{label}</span>
    <b className={cn("font-number text-sm", strong && "text-emerald-400")}>{value}</b>
  </div>
);

export function CalculatorsDialog({ open, onOpenChange, symbol: currentSymbol, prices }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  symbol: string;
  prices: Record<string, number>;
}) {
  const [tab, setTab] = useState<Tab>("position");
  const [symbol, setSymbol] = useState(currentSymbol);
  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(1);
  const [slPips, setSlPips] = useState(30);
  const [tpPips, setTpPips] = useState(60);
  const [lots, setLots] = useState(1);
  const [leverage, setLeverage] = useState(100);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [entry, setEntry] = useState("");
  const [exit, setExit] = useState("");
  const [fibLow, setFibLow] = useState("");
  const [fibHigh, setFibHigh] = useState("");
  const [equityText, setEquityText] = useState("10000, 9000, 11000, 10500, 12000");
  const [ratePct, setRatePct] = useState(5);
  const [periods, setPeriods] = useState(12);
  const [perPeriod, setPerPeriod] = useState(0);

  const inst = getInstrument(symbol);
  const price = prices[symbol];
  // quote→USD rate: for USDJPY-style pairs the price itself converts; for
  // EUR/GBP-quoted indices we don't have the cross here → label stays quote ccy
  const quoteToUsd = useMemo(() => {
    if (!inst) return 1;
    if (inst.quote === "USD") return 1;
    if (symbol.startsWith("USD") && price) return price; // USDJPY: JPY per USD
    return 1;
  }, [inst, symbol, price]);

  const pv = pipValue(symbol, lots, quoteToUsd);
  const ps = positionSize(symbol, balance, riskPct, slPips, quoteToUsd);
  const mg = margin(symbol, lots, price ?? 0, leverage, quoteToUsd);
  const pl = entry && exit ? profitLoss(symbol, side, Number(entry), Number(exit), lots, quoteToUsd) : null;
  const rr = entry ? riskReward(Number(entry), Number(entry) - slPips * (inst?.pipSize ?? 0), Number(entry) + tpPips * (inst?.pipSize ?? 0)) : null;
  const fibs = fibLow && fibHigh ? fibonacci(Number(fibLow), Number(fibHigh)) : [];
  const dd = useMemo(() => drawdown(equityText.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x))), [equityText]);
  const comp = useMemo(() => compounding(balance, ratePct, periods, perPeriod), [balance, ratePct, periods, perPeriod]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border/60 bg-[#0d1117] sm:max-w-md">
        <DialogHeader><DialogTitle className="text-sm">Trading calculators</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("rounded-lg border px-2 py-1 text-[10px] font-semibold", tab === t.id ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-1 rounded-xl border border-border/50 bg-card/30 p-2.5">
          {tab !== "fib" && tab !== "dd" && tab !== "compound" && (
            <Row label="Instrument">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="num-input h-7 w-32">
                {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
              </select>
            </Row>
          )}

          {tab === "position" && (
            <>
              <Row label="Account balance"><input type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Risk %"><input type="number" step="any" value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Stop loss (pips)"><input type="number" value={slPips} onChange={(e) => setSlPips(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <div className="space-y-1 pt-1">
                <Out label="Risk amount" value={`${ps.riskUsd.toFixed(2)} USD`} />
                <Out label="Pip value / lot" value={`${ps.pipValuePerLot.toFixed(2)} ${pv.currency}`} />
                <Out label="Position size" value={`${ps.lots} lots`} strong />
                {ps.lots < 0.01 && <p className="text-[10px] text-amber-400">SL too small or risk too low — size rounds below the 0.01 lot minimum.</p>}
              </div>
            </>
          )}

          {tab === "pip" && (
            <>
              <Row label="Lots"><input type="number" step="any" value={lots} onChange={(e) => setLots(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <div className="space-y-1 pt-1">
                <Out label="Per 1.00 lot" value={`${pv.valuePerLot.toFixed(2)} ${pv.currency}`} />
                <Out label={`For ${lots} lots`} value={`${pv.valueTotal.toFixed(2)} ${pv.currency}`} strong />
                {pv.converted && <p className="text-[10px] text-muted-foreground">Converted from {inst?.quote} at the live rate.</p>}
              </div>
            </>
          )}

          {tab === "lot" && (
            <>
              <Row label="Balance"><input type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Risk %"><input type="number" step="any" value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="SL distance (pips)"><input type="number" value={slPips} onChange={(e) => setSlPips(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Out label="Lot size" value={`${positionSize(symbol, balance, riskPct, slPips, quoteToUsd).lots} lots`} strong />
            </>
          )}

          {tab === "rr" && (
            <>
              <Row label="Entry price"><input type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={price ? String(price) : ""} className="num-input h-7 w-28" /></Row>
              <Row label="SL (pips)"><input type="number" value={slPips} onChange={(e) => setSlPips(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="TP (pips)"><input type="number" value={tpPips} onChange={(e) => setTpPips(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              {rr && <div className="space-y-1 pt-1">
                <Out label="Risk" value={rr.risk.toFixed(inst?.digits ?? 4)} />
                <Out label="Reward" value={rr.reward.toFixed(inst?.digits ?? 4)} />
                <Out label="R:R" value={`1 : ${rr.rr}`} strong />
              </div>}
            </>
          )}

          {tab === "margin" && (
            <>
              <Row label="Lots"><input type="number" step="any" value={lots} onChange={(e) => setLots(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Leverage 1:x"><input type="number" value={leverage} onChange={(e) => setLeverage(Math.max(1, Number(e.target.value)))} className="num-input h-7 w-28" /></Row>
              <div className="space-y-1 pt-1">
                <Out label="Notional" value={price ? `${mg.notional.toFixed(2)} ${mg.currency}` : "live price loading…"} />
                <Out label="Margin required" value={price ? `${mg.margin.toFixed(2)} ${mg.currency}` : "…"} strong />
              </div>
            </>
          )}

          {tab === "pl" && (
            <>
              <Row label="Side">
                <select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")} className="num-input h-7 w-24"><option value="buy">Buy</option><option value="sell">Sell</option></select>
              </Row>
              <Row label="Lots"><input type="number" step="any" value={lots} onChange={(e) => setLots(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Entry"><input type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} className="num-input h-7 w-28" /></Row>
              <Row label="Exit"><input type="number" step="any" value={exit} onChange={(e) => setExit(e.target.value)} className="num-input h-7 w-28" /></Row>
              {pl && <div className="space-y-1 pt-1">
                <Out label="Pips" value={pl.pips.toFixed(1)} />
                <Out label="Profit / Loss" value={`${pl.pnl >= 0 ? "+" : ""}${pl.pnl.toFixed(2)} ${pl.currency}`} strong />
              </div>}
            </>
          )}

          {tab === "fib" && (
            <>
              <Row label="Swing low"><input type="number" step="any" value={fibLow} onChange={(e) => setFibLow(e.target.value)} className="num-input h-7 w-28" /></Row>
              <Row label="Swing high"><input type="number" step="any" value={fibHigh} onChange={(e) => setFibHigh(e.target.value)} className="num-input h-7 w-28" /></Row>
              <div className="mt-1 space-y-0.5">
                {fibs.map((f) => (
                  <div key={f.kind + f.level} className="flex justify-between rounded px-2 py-1 odd:bg-card/60">
                    <span className="text-[11px] text-muted-foreground">{(f.level * 100).toFixed(1)}% {f.kind === "extension" ? "ext" : "ret"}</span>
                    <b className="font-number">{f.price.toFixed(inst?.digits ?? 4)}</b>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "dd" && (
            <>
              <div className="py-1 text-[11px] text-muted-foreground">Equity series (comma separated)</div>
              <textarea value={equityText} onChange={(e) => setEquityText(e.target.value)} rows={2} className="num-input w-full" />
              <div className="space-y-1 pt-1">
                <Out label="Max drawdown" value={dd.maxDD.toFixed(2)} strong />
                <Out label="Max DD %" value={`${dd.maxDDPct.toFixed(2)}%`} />
                <Out label="Peak → trough" value={`${dd.peak.toFixed(2)} → ${dd.trough.toFixed(2)}`} />
              </div>
            </>
          )}

          {tab === "compound" && (
            <>
              <Row label="Start balance"><input type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Return % / period"><input type="number" step="any" value={ratePct} onChange={(e) => setRatePct(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <Row label="Periods"><input type="number" value={periods} onChange={(e) => setPeriods(Math.max(1, Math.min(120, Number(e.target.value))))} className="num-input h-7 w-28" /></Row>
              <Row label="Add / period"><input type="number" value={perPeriod} onChange={(e) => setPerPeriod(Number(e.target.value))} className="num-input h-7 w-28" /></Row>
              <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                {comp.map((v, i) => (
                  <div key={i} className="flex justify-between rounded px-2 py-0.5 odd:bg-card/60">
                    <span className="text-[11px] text-muted-foreground">{i === 0 ? "start" : `period ${i}`}</span>
                    <b className="font-number">{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <p className="text-[9px] text-muted-foreground">Reference CFD contract specs ({inst ? `${inst.contractSize.toLocaleString()} units/lot, ${inst.pipSize} pip` : "—"}). Demo environment — a live broker's symbol metadata overrides these.</p>
      </DialogContent>
    </Dialog>
  );
}
