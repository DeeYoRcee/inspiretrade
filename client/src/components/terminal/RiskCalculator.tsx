/**
 * RiskCalculator — position sizing with real contract specifications from the
 * instrument catalog (lot size, risk in account currency, R:R). Reference
 * math for DEMO trading; a broker adapter must use the broker's own specs.
 */
import { useMemo, useState } from "react";
import { INSTRUMENTS, getInstrument } from "@shared/terminal";
import { useLanguage } from "@/lib/language-context";

export function RiskCalculator({
  symbol, price, balance, className,
}: {
  symbol: string;
  price: number | null;
  balance: number;
  className?: string;
}) {
  const { t } = useLanguage();
  const [sym, setSym] = useState(symbol);
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [balanceOv, setBalanceOv] = useState("");

  const inst = getInstrument(sym);
  const contract = inst?.contractSize ?? 1;
  const entryPx = Number(entry) || price || 0;
  const slPx = Number(sl) || 0;
  const tpPx = Number(tp) || 0;
  const bal = Number(balanceOv) || balance || 0;

  const calc = useMemo(() => {
    const riskUsd = (bal * (Number(riskPct) || 0)) / 100;
    const dist = Math.abs(entryPx - slPx);
    if (!dist || !riskUsd) return null;
    const lots = Math.max(0.01, Math.floor((riskUsd / (dist * contract)) * 100) / 100);
    const actualRisk = dist * lots * contract;
    const reward = tpPx ? Math.abs(tpPx - entryPx) * lots * contract : null;
    return {
      riskUsd, lots, actualRisk,
      reward,
      rr: reward != null && actualRisk ? reward / actualRisk : null,
      pips: dist / (inst?.pipSize ?? 1),
    };
  }, [bal, riskPct, entryPx, slPx, tpPx, contract, inst]);

  return (
    <div className={`space-y-2.5 p-3 text-xs ${className ?? ""}`}>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">{t("rcInstrument")}</span>
          <select value={sym} onChange={(e) => setSym(e.target.value)} className="num-input">
            {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">{t("rcBalance")}</span>
          <input type="number" value={balanceOv} onChange={(e) => setBalanceOv(e.target.value)} className="num-input" placeholder={String(Math.round(balance))} />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">{t("rcEntry")}</span>
          <input type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} className="num-input" placeholder={price ? price.toFixed(inst?.digits ?? 2) : "—"} />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">{t("rcRiskPct")}</span>
          <input type="number" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} className="num-input" />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">{t("rcStop")}</span>
          <input type="number" step="any" value={sl} onChange={(e) => setSl(e.target.value)} className="num-input" />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted-foreground">{t("rcTarget")}</span>
          <input type="number" step="any" value={tp} onChange={(e) => setTp(e.target.value)} className="num-input" />
        </label>
      </div>
      {calc ? (
        <div className="space-y-1 rounded-lg bg-card/50 p-2.5">
          <Row label={t("rcLots")} value={calc.lots.toFixed(2)} big />
          <Row label={t("rcRiskUsd")} value={`$${calc.actualRisk.toFixed(2)} (${calc.riskUsd.toFixed(2)} target)`} />
          <Row label={t("rcPips")} value={calc.pips.toLocaleString("en-US", { maximumFractionDigits: 1 })} />
          <Row label={t("rcReward")} value={calc.reward != null ? `$${calc.reward.toFixed(2)}` : "—"} />
          <Row label="R:R" value={calc.rr != null ? `1 : ${calc.rr.toFixed(2)}` : "—"} />
        </div>
      ) : (
        <div className="rounded-lg bg-card/50 p-2.5 text-center text-muted-foreground">{t("rcFillAll")}</div>
      )}
      <p className="text-[9px] leading-tight text-muted-foreground">
        {t("rcNote")} ({sym}: contract {contract.toLocaleString("en-US")}, pip {inst?.pipSize})
      </p>
    </div>
  );
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <b className={`font-number ${big ? "text-base text-emerald-400" : "text-foreground"}`}>{value}</b>
    </div>
  );
}
