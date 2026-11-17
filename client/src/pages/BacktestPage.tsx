/**
 * BacktestPage — historical strategy testing workspace.
 *
 * Runs the deterministic built-in strategies over REAL historical candles via
 * the shared bar-step broker (identical execution assumptions to replay and
 * live: spread, commission, conservative intra-bar SL/TP). Signals are
 * evaluated on closed bars and executed at the NEXT bar's open — no look-ahead
 * (unit-tested in tests/replay-engine.test.ts).
 */
import { useMemo, useState } from "react";
import { FlaskConical, Play, Save, X } from "lucide-react";
import { Line, LineChart, Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { INSTRUMENTS, type Timeframe } from "@shared/terminal";
import {
  runBacktest, STRATEGY_LABELS, DEFAULT_STRATEGY_PARAMS,
  type BacktestResult, type BacktestTradeRow, type StrategyId, type StrategyParams,
} from "@shared/backtest";
import { historyAvailability, loadHistoryRange } from "@/lib/history-loader";
import { PriceChart } from "@/components/terminal/PriceChart";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { db, auth } from "@/lib/firebase";
import { push, ref as dbRef, set, get, remove } from "firebase/database";

const REPLAY_TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function BacktestPage() {
  const [symbol, setSymbol] = useState("BTCUSD");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [fromDate, setFromDate] = useState(() => dayOf(Date.now() - 90 * 86400000));
  const [toDate, setToDate] = useState(() => dayOf(Date.now() - 86400000));
  const [strategy, setStrategy] = useState<StrategyId>("sma_cross");
  const [params, setParams] = useState<StrategyParams>({ ...DEFAULT_STRATEGY_PARAMS });
  const [balance, setBalance] = useState(10000);
  const [sizing, setSizing] = useState<"risk" | "fixed">("risk");
  const [riskPct, setRiskPct] = useState(1);
  const [fixedLots, setFixedLots] = useState(0.1);
  const [commission, setCommission] = useState(0);
  const [spreadOverride, setSpreadOverride] = useState("");
  const [closeOnOpposite, setCloseOnOpposite] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [bars, setBars] = useState<any[]>([]);
  const [review, setReview] = useState<BacktestTradeRow | null>(null);
  const [savedRuns, setSavedRuns] = useState<any[]>([]);

  const availability = historyAvailability(symbol, tf);
  const minDate = availability.maxDaysBack != null
    ? dayOf(Date.now() - availability.maxDaysBack * 86400000)
    : dayOf(Date.now() - 400 * 86400000);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const from = new Date(`${fromDate}T00:00:00Z`).getTime() / 1000;
      const to = new Date(`${toDate}T23:59:59Z`).getTime() / 1000;
      if (!(to > from)) throw new Error("The end date must be after the start date");
      setProgressText("Loading real historical candles…");
      const loaded = await loadHistoryRange(symbol, tf, Math.floor(from), Math.floor(to), (d, t) => {
        setProgressText(`Loading history… ${d}/${t}`);
      });
      setBars(loaded.bars);
      setProgressText("Running simulation…");
      // yield a frame so the progress renders before the heavy synchronous run
      await new Promise((res) => setTimeout(res, 30));
      const res = runBacktest({
        symbol, timeframe: tf, strategy, params,
        startBalance: Math.max(100, balance),
        riskPct: sizing === "risk" ? riskPct : null,
        fixedLots: sizing === "fixed" ? fixedLots : 0,
        commissionPerLot: commission,
        spreadPips: spreadOverride ? Number(spreadOverride) : null,
        leverage: 100,
        closeOnOpposite,
      }, loaded.bars);
      setResult(res);
      toast({
        title: `Backtest complete — ${res.stats.totalTrades} trades`,
        description: `Net ${res.stats.netProfit >= 0 ? "+" : ""}${money(res.stats.netProfit)} USD · win rate ${res.stats.winRate}%`,
      });
    } catch (e: any) {
      toast({ title: "Backtest failed", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setRunning(false);
      setProgressText(null);
    }
  };

  const loadSaved = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const snap = await get(dbRef(db, `backtests/${uid}`));
    if (!snap.exists()) { setSavedRuns([]); return; }
    const val = snap.val() as Record<string, any>;
    setSavedRuns(Object.entries(val).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).slice(0, 10));
  };

  const saveRun = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid || !result) return;
    const id = `bt-${Date.now().toString(36)}`;
    await set(dbRef(db, `backtests/${uid}/${id}`), {
      id, savedAt: Date.now(),
      symbol, timeframe: tf, from: fromDate, to: toDate, strategy,
      netProfit: result.stats.netProfit, winRate: result.stats.winRate,
      totalTrades: result.stats.totalTrades, maxDrawdownPct: result.maxDrawdownPct,
      finalBalance: result.finalBalance, commission, riskPct: sizing === "risk" ? riskPct : null,
    });
    toast({ title: "Run saved", description: "Stored in Firebase under your account." });
    void loadSaved();
  };

  const curveData = useMemo(() => {
    if (!result) return [];
    // subsample to ≤1200 points for smooth rendering
    const c = result.equityCurve;
    const stepN = Math.max(1, Math.floor(c.length / 1200));
    return c.filter((_, i) => i % stepN === 0).map((p) => ({
      t: dayOf(p.t), equity: p.equity, balance: p.balance,
      dd: 0,
    }));
  }, [result]);

  const drawdownData = useMemo(() => {
    if (!result) return [];
    let peak = result.config.startBalance;
    return curveData.map((p) => {
      peak = Math.max(peak, p.equity);
      return { ...p, dd: peak > 0 ? Math.round(((peak - p.equity) / peak) * 10000) / 100 : 0 };
    });
  }, [curveData, result]);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-5 w-5 text-sky-400" />
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Backtesting</h1>
          <p className="text-xs text-slate-400">
            Deterministic strategies on real historical candles · signals on closed bars, execution at the next open · no look-ahead.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* config */}
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <Row label="Instrument">
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={selectCls}>
              {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} — {i.name}</option>)}
            </select>
          </Row>
          <Row label="Timeframe">
            <div className="flex flex-wrap gap-1">
              {REPLAY_TFS.map((t) => (
                <button key={t} onClick={() => setTf(t as Timeframe)}
                  className={btn(tf === t)}>{t.toUpperCase()}</button>
              ))}
            </div>
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="From (UTC)">
              <input type="date" value={fromDate} min={minDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} className={inputCls} />
            </Row>
            <Row label="To (UTC)">
              <input type="date" value={toDate} min={fromDate} max={dayOf(Date.now() - 86400000)} onChange={(e) => setToDate(e.target.value)} className={inputCls} />
            </Row>
          </div>
          <p className="text-[10px] text-slate-500">{availability.note}</p>
          <Row label="Strategy">
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as StrategyId)} className={selectCls}>
              {(Object.keys(STRATEGY_LABELS) as StrategyId[]).map((id) => (
                <option key={id} value={id}>{STRATEGY_LABELS[id]}</option>
              ))}
            </select>
          </Row>
          <div className="grid grid-cols-3 gap-2">
            {strategy === "sma_cross" && (
              <>
                <Num label="Fast" value={params.fastPeriod} min={2} onChange={(v) => setParams({ ...params, fastPeriod: v })} />
                <Num label="Slow" value={params.slowPeriod} min={3} onChange={(v) => setParams({ ...params, slowPeriod: v })} />
              </>
            )}
            {strategy === "rsi_reversion" && (
              <>
                <Num label="RSI len" value={params.rsiPeriod} min={2} onChange={(v) => setParams({ ...params, rsiPeriod: v })} />
                <Num label="OS" value={params.rsiOversold} min={5} max={49} onChange={(v) => setParams({ ...params, rsiOversold: v })} />
                <Num label="OB" value={params.rsiOverbought} min={51} max={95} onChange={(v) => setParams({ ...params, rsiOverbought: v })} />
              </>
            )}
            {strategy === "breakout" && (
              <Num label="Channel" value={params.channelPeriod} min={5} onChange={(v) => setParams({ ...params, channelPeriod: v })} />
            )}
            <Num label="R:R" value={params.riskReward} min={0.5} step={0.5} onChange={(v) => setParams({ ...params, riskReward: v })} />
            <Num label="ATR×" value={params.atrMultiple} min={0.5} step={0.5} onChange={(v) => setParams({ ...params, atrMultiple: v })} />
          </div>
          <Row label="Starting balance ($)">
            <input type="number" value={balance} min={100} step={1000} onChange={(e) => setBalance(Number(e.target.value) || 0)} className={inputCls} />
          </Row>
          <Row label="Position sizing">
            <div className="flex gap-1">
              <button onClick={() => setSizing("risk")} className={btn(sizing === "risk")}>Risk %</button>
              <button onClick={() => setSizing("fixed")} className={btn(sizing === "fixed")}>Fixed lots</button>
            </div>
          </Row>
          {sizing === "risk" ? (
            <Num label="Risk per trade (%)" value={riskPct} min={0.1} max={20} step={0.1} onChange={setRiskPct} />
          ) : (
            <Num label="Lots per trade" value={fixedLots} min={0.01} step={0.01} onChange={setFixedLots} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <Num label="Commission / lot $" value={commission} min={0} step={0.5} onChange={setCommission} />
            <Num label="Spread pips (blank = live)" value={spreadOverride === "" ? "" : Number(spreadOverride)} min={0} step={0.1} onChange={(v) => setSpreadOverride(v === "" ? "" : String(v))} />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={closeOnOpposite} onChange={(e) => setCloseOnOpposite(e.target.checked)} />
            Close the open position when an opposite signal appears
          </label>
          <Button onClick={() => void run()} disabled={running} className="w-full bg-sky-600 hover:bg-sky-500">
            <Play className="mr-1 h-3.5 w-3.5" /> {running ? "Running…" : "Run backtest"}
          </Button>
          {progressText && <div className="text-xs text-sky-300">{progressText}</div>}
          {error && <div className="text-xs text-red-400">{error}</div>}
        </div>

        {/* results */}
        <div className="space-y-4">
          {!result && (
            <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-800 text-sm text-slate-500">
              Configure the run and press “Run backtest”.
            </div>
          )}
          {result && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                <Metric label="Net profit" value={`$${money(result.stats.netProfit)}`} good={result.stats.netProfit >= 0} />
                <Metric label="Final balance" value={`$${money(result.finalBalance)}`} />
                <Metric label="Trades" value={String(result.stats.totalTrades)} />
                <Metric label="Win rate" value={`${result.stats.winRate}%`} />
                <Metric label="Profit factor" value={result.stats.profitFactor === Infinity ? "∞" : String(result.stats.profitFactor)} />
                <Metric label="Max drawdown" value={`${money(result.maxDrawdownUsd)} $ · ${result.maxDrawdownPct}%`} bad={result.maxDrawdownPct > 20} />
                <Metric label="Avg win" value={`$${money(result.stats.avgWin)}`} good />
                <Metric label="Avg loss" value={`$${money(result.stats.avgLoss)}`} bad />
                <Metric label="Avg R:R (realized)" value={result.stats.avgRiskReward != null ? String(result.stats.avgRiskReward) : "—"} />
                <Metric label="Longs / Shorts" value={`${result.stats.longs.count} / ${result.stats.shorts.count}`} />
                <Metric label="Best streak" value={`${result.stats.maxConsecutiveWins}W / ${result.stats.maxConsecutiveLosses}L`} />
                <Metric label="Peak equity" value={`$${money(result.peakEquity)}`} />
              </div>

              <ChartCard title="Equity & balance">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={curveData}>
                    <CartesianGrid stroke="#1e293b" />
                    <XAxis dataKey="t" tick={{ fill: "#64748b", fontSize: 10 }} minTickGap={40} />
                    <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={60} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="equity" name="Equity" stroke="#38bdf8" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="balance" name="Balance" stroke="#a78bfa" dot={false} strokeWidth={1.5} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Drawdown %">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={drawdownData}>
                    <CartesianGrid stroke="#1e293b" />
                    <XAxis dataKey="t" tick={{ fill: "#64748b", fontSize: 10 }} minTickGap={40} />
                    <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={40} unit="%" />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 12 }} />
                    <Area type="monotone" dataKey="dd" name="Drawdown %" stroke="#f43f5e" fill="#f43f5e33" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <div className="rounded-lg border border-slate-800 bg-slate-900/60">
                <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                  <span className="text-sm font-semibold text-slate-100">Trade history ({result.trades.length})</span>
                  <Button size="sm" variant="outline" onClick={() => void saveRun()}><Save className="mr-1 h-3.5 w-3.5" /> Save run</Button>
                </div>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase text-slate-500">
                      <tr>
                        <th className="px-2 py-1 text-left">#</th><th className="px-2 py-1 text-left">Side</th>
                        <th className="px-2 py-1 text-right">Lots</th><th className="px-2 py-1 text-right">Entry</th>
                        <th className="px-2 py-1 text-right">Exit</th><th className="px-2 py-1 text-right">P/L</th>
                        <th className="px-2 py-1 text-right">R:R</th><th className="px-2 py-1 text-left">Reason</th>
                        <th className="px-2 py-1 text-left">Opened</th><th className="px-2 py-1 text-left">Closed</th>
                        <th className="px-2 py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => (
                        <tr key={t.id + t.closedAt} className="border-t border-slate-800/60 hover:bg-slate-800/40">
                          <td className="px-2 py-1 text-slate-500">{i + 1}</td>
                          <td className={`px-2 py-1 font-semibold ${t.side === "buy" ? "text-emerald-400" : "text-red-400"}`}>{t.side.toUpperCase()}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-300">{t.lots.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-300">{t.entry.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-300">{t.exit.toFixed(2)}</td>
                          <td className={`px-2 py-1 text-right font-semibold tabular-nums ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{t.pnl >= 0 ? "+" : "−"}{money(Math.abs(t.pnl))}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-400">{t.realizedRR ?? "—"}</td>
                          <td className="px-2 py-1 uppercase text-slate-400">{t.reason}</td>
                          <td className="px-2 py-1 text-slate-500">{dayOf(t.openedAt)}</td>
                          <td className="px-2 py-1 text-slate-500">{dayOf(t.closedAt)}</td>
                          <td className="px-2 py-1 text-right">
                            <Button size="sm" variant="outline" onClick={() => setReview(t)}>Review</Button>
                          </td>
                        </tr>
                      ))}
                      {result.trades.length === 0 && (
                        <tr><td colSpan={11} className="px-3 py-6 text-center text-xs text-slate-500">The strategy produced no trades in this window — widen the range or loosen the parameters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {savedRuns.length > 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="mb-2 text-sm font-semibold text-slate-100">Saved runs</div>
              <div className="space-y-1.5">
                {savedRuns.map((r2) => (
                  <div key={r2.id} className="flex items-center gap-3 rounded-md border border-slate-800 px-2 py-1.5 text-xs">
                    <span className="font-medium text-slate-200">{r2.symbol} · {String(r2.timeframe).toUpperCase()}</span>
                    <span className="text-slate-500">{r2.strategy} · {r2.from} → {r2.to}</span>
                    <span className={r2.netProfit >= 0 ? "ml-auto font-semibold text-emerald-400" : "ml-auto font-semibold text-red-400"}>
                      {r2.netProfit >= 0 ? "+" : ""}{money(r2.netProfit)}
                    </span>
                    <Button size="icon" variant="ghost" onClick={async () => { const uid = auth.currentUser?.uid; if (uid) { await remove(dbRef(db, `backtests/${uid}/${r2.id}`)); void loadSaved(); } }}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {savedRuns.length === 0 && (
            <Button variant="outline" size="sm" onClick={() => void loadSaved()}>Load saved runs</Button>
          )}
        </div>
      </div>

      {review && result && (
        <TradeReview
          trade={review} bars={bars} symbol={result.config.symbol} tf={result.config.timeframe}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}

function TradeReview({ trade, bars, symbol, tf, onClose }: {
  trade: BacktestTradeRow; bars: any[]; symbol: string; tf: Timeframe; onClose: () => void;
}) {
  const slice = useMemo(() => {
    const from = Math.max(0, trade.entryBar - 40);
    const to = Math.min(bars.length - 1, trade.exitBar + 20);
    return bars.slice(from, to + 1);
  }, [bars, trade.entryBar, trade.exitBar]);

  const marks = useMemo(() => {
    const out = [];
    out.push({ id: "entry", price: trade.entry, color: "#3b82f6", title: `${trade.side.toUpperCase()} ${trade.lots.toFixed(2)} @ ${trade.entry.toFixed(2)}`, dashed: false });
    if (trade.exit) out.push({ id: "exit", price: trade.exit, color: trade.pnl >= 0 ? "#22c55e" : "#ef4444", title: `EXIT ${trade.exit.toFixed(2)} (${trade.reason})`, dashed: true });
    if (trade.sl) out.push({ id: "sl", price: trade.sl, color: "#ef4444", title: "SL", dashed: true });
    if (trade.tp) out.push({ id: "tp", price: trade.tp, color: "#22c55e", title: "TP", dashed: true });
    return out;
  }, [trade]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-5xl space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-100">
            {symbol} · {tf.toUpperCase()} · {trade.side.toUpperCase()} {trade.lots.toFixed(2)} ·
            <span className={trade.pnl >= 0 ? "ml-1 text-emerald-400" : "ml-1 text-red-400"}>
              {trade.pnl >= 0 ? "+" : "−"}{money(Math.abs(trade.pnl))} USD
            </span>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="h-[420px] overflow-hidden rounded-md border border-slate-800 bg-[#0b1220]">
          <PriceChart
            symbol={symbol}
            timeframe={tf}
            marks={marks as any}
            accountId={null}
            positions={[]}
            onModifyPosition={async () => {}}
            onSymbolChange={() => {}}
            onTimeframeChange={() => {}}
            replayBars={slice}
            replayCursor={slice.length - 1}
            replayStatus={`Trade review · ${trade.reason}`}
          />
        </div>
        <div className="text-[10px] text-slate-500">
          Entry {trade.entry.toFixed(2)} → exit {trade.exit.toFixed(2)} ({trade.reason}) · opened {new Date(trade.openedAt).toISOString().slice(0, 16).replace("T", " ")} UTC · closed {new Date(trade.closedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
        </div>
      </div>
    </div>
  );
}

const selectCls = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
const inputCls = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
const btn = (active: boolean) =>
  active ? "rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white" : "rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Num({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number | ""; min?: number; max?: number; step?: number; onChange: (v: any) => void;
}) {
  return (
    <Row label={label}>
      <input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        className={inputCls}
      />
    </Row>
  );
}

function Metric({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${good ? "text-emerald-400" : bad ? "text-red-400" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="mb-2 text-sm font-semibold text-slate-100">{title}</div>
      {children}
    </div>
  );
}
