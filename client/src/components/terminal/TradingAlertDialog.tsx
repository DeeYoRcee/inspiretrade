/**
 * TradingAlertDialog — PHASE 47 Part 4: professional alert creation / editing.
 * Condition families: Price (above/below), Indicator (RSI / MACD / EMA-SMA
 * cross / price-vs-MA / Bollinger / ATR — real math, evaluated by the client
 * engine), Drawing (hline / trend / channel / fib / position levels).
 * Plus trigger frequency (once / once-per-bar / once-per-bar-close / repeat
 * with cooldown), expiration and a custom message.
 */
import { useEffect, useMemo, useState } from "react";
import { BellRing, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Bar, Timeframe } from "@shared/terminal";
import type { Drawing } from "@/lib/drawings";
import { toolDisplayName } from "./chart/LeftRail";
import { blankAlert, saveAlert, type TradingAlert, type IndicatorCond, type DrawingCond, type TriggerFrequency } from "@/lib/trading-alerts";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

const FREQ_LABEL: Record<TriggerFrequency, string> = {
  once: "Only once",
  oncePerBar: "Once per bar",
  oncePerBarClose: "Once per bar close",
  repeat: "Repeat (with cooldown)",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "h-8 w-full rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100";

export function TradingAlertDialog({
  open, symbol, timeframe, lastPrice, drawings, editing, initialPrice, onClose,
}: {
  open: boolean;
  symbol: string;
  timeframe: Timeframe;
  lastPrice: number | null;
  /** the open chart's drawings — drawing alerts need them; empty elsewhere */
  drawings: Drawing[];
  editing?: TradingAlert | null;
  /** context-menu creation: prefill the target with the right-click price */
  initialPrice?: number | null;
  onClose: () => void;
}) {
  const [a, setA] = useState<TradingAlert>(() => blankAlert(symbol, timeframe));

  useEffect(() => {
    if (!open) return;
    if (editing) { setA({ ...editing }); return; }
    const blank = blankAlert(symbol, timeframe);
    if (initialPrice != null && Number.isFinite(initialPrice) && initialPrice > 0) blank.price = initialPrice;
    else if (lastPrice != null) blank.price = lastPrice;
    setA(blank);
  }, [open, editing, symbol, timeframe, initialPrice, lastPrice]);

  const patch = (p: Partial<TradingAlert>) => setA((prev) => ({ ...prev, ...p }));
  const patchInd = (p: Partial<IndicatorCond>) => setA((prev) => ({ ...prev, indicator: { ...(prev.indicator ?? { ind: "rsi" }), ...p } }));
  const patchDraw = (p: Partial<DrawingCond>) => setA((prev) => ({ ...prev, drawing: { ...(prev.drawing ?? { drawingId: drawings[0]?.id ?? "", target: "level", dir: "crossAbove" }), ...p } }));

  const selectedDrawing = useMemo(() => drawings.find((d) => d.id === a.drawing?.drawingId), [drawings, a.drawing?.drawingId]);

  if (!open) return null;

  const expiresLocal = a.expiresAt ? new Date(a.expiresAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";

  const submit = async () => {
    if (a.kind === "price" && (!a.price || a.price <= 0)) { toast({ title: "Enter a target price", variant: "destructive" }); return; }
    if (a.kind === "drawing" && !a.drawing?.drawingId) { toast({ title: "Pick a drawing first", variant: "destructive" }); return; }
    try {
      await saveAlert(a);
      toast({ title: editing ? "Alert updated" : "Alert created", description: `${a.symbol} · ${a.kind} · ${FREQ_LABEL[a.frequency]}` });
      onClose();
    } catch (e: any) {
      toast({ title: "Could not save the alert", description: String(e?.message || e), variant: "destructive" });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[92dvh] w-[min(430px,96vw)] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-100">
            <BellRing className="h-4 w-4 text-sky-400" /> {editing ? "Edit alert" : "New trading alert"} · {symbol} · {timeframe.toUpperCase()}
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {/* condition family */}
          <div className="flex gap-1 rounded-lg border border-slate-700/70 bg-slate-950/60 p-1">
            {(["price", "indicator", "drawing"] as const).map((k) => (
              <button
                key={k}
                onClick={() => patch({ kind: k })}
                className={cn("flex-1 rounded px-2 py-1.5 font-semibold capitalize transition-colors", a.kind === k ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                {k === "price" ? "Price" : k}
              </button>
            ))}
          </div>

          {a.kind === "price" && (
            <div className="grid grid-cols-2 gap-2">
              <Row label="Condition">
                <select className={inputCls} value={a.direction ?? "above"} onChange={(e) => patch({ direction: e.target.value as "above" | "below" })}>
                  <option value="above">Price crosses ABOVE</option>
                  <option value="below">Price crosses BELOW</option>
                </select>
              </Row>
              <Row label="Target price">
                <div className="flex gap-1">
                  <input type="number" step="any" className={inputCls} value={a.price ?? ""} onChange={(e) => patch({ price: Number(e.target.value) })} />
                  {lastPrice != null && (
                    <Button variant="outline" size="sm" className="h-8 shrink-0 px-2 text-[10px]" onClick={() => patch({ price: lastPrice })}>now</Button>
                  )}
                </div>
              </Row>
            </div>
          )}

          {a.kind === "indicator" && (
            <div className="space-y-2">
              <Row label="Indicator condition">
                <select className={inputCls} value={a.indicator?.ind ?? "rsi"} onChange={(e) => patchInd({ ind: e.target.value as IndicatorCond["ind"] })}>
                  <option value="rsi">RSI overbought / oversold</option>
                  <option value="macd">MACD bullish / bearish crossover</option>
                  <option value="emaCross">EMA crossover (golden / death)</option>
                  <option value="smaCross">SMA crossover (golden / death)</option>
                  <option value="priceVsMa">Price crossing moving average</option>
                  <option value="bb">Bollinger band touch</option>
                  <option value="atr">ATR threshold</option>
                </select>
              </Row>
              {(a.indicator?.ind === "rsi" || a.indicator?.ind === "atr") && (
                <div className="grid grid-cols-3 gap-2">
                  <Row label="Direction">
                    <select className={inputCls} value={a.indicator?.dir ?? (a.indicator?.ind === "rsi" ? "above" : "above")} onChange={(e) => patchInd({ dir: e.target.value })}>
                      {a.indicator?.ind === "rsi"
                        ? <><option value="above">Overbought ≥</option><option value="below">Oversold ≤</option></>
                        : <><option value="above">Above ≥</option><option value="below">Below ≤</option></>}
                    </select>
                  </Row>
                  <Row label="Level">
                    <input type="number" step="any" className={inputCls} value={a.indicator?.value ?? (a.indicator?.ind === "rsi" ? 70 : 0)} onChange={(e) => patchInd({ value: Number(e.target.value) })} />
                  </Row>
                  <Row label="Period">
                    <input type="number" className={inputCls} value={a.indicator?.period ?? 14} onChange={(e) => patchInd({ period: Number(e.target.value) })} />
                  </Row>
                </div>
              )}
              {(a.indicator?.ind === "macd") && (
                <Row label="Crossover">
                  <select className={inputCls} value={a.indicator?.dir ?? "bullish"} onChange={(e) => patchInd({ dir: e.target.value })}>
                    <option value="bullish">Bullish</option>
                    <option value="bearish">Bearish</option>
                  </select>
                </Row>
              )}
              {(a.indicator?.ind === "emaCross" || a.indicator?.ind === "smaCross") && (
                <div className="grid grid-cols-3 gap-2">
                  <Row label="Crossover">
                    <select className={inputCls} value={a.indicator?.dir ?? "golden"} onChange={(e) => patchInd({ dir: e.target.value })}>
                      <option value="golden">Golden</option>
                      <option value="death">Death</option>
                    </select>
                  </Row>
                  <Row label="Fast period"><input type="number" className={inputCls} value={a.indicator?.period ?? 9} onChange={(e) => patchInd({ period: Number(e.target.value) })} /></Row>
                  <Row label="Slow period"><input type="number" className={inputCls} value={a.indicator?.period2 ?? 21} onChange={(e) => patchInd({ period2: Number(e.target.value) })} /></Row>
                </div>
              )}
              {(a.indicator?.ind === "priceVsMa") && (
                <div className="grid grid-cols-3 gap-2">
                  <Row label="Direction">
                    <select className={inputCls} value={a.indicator?.dir ?? "above"} onChange={(e) => patchInd({ dir: e.target.value })}>
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                    </select>
                  </Row>
                  <Row label="MA period"><input type="number" className={inputCls} value={a.indicator?.period ?? 50} onChange={(e) => patchInd({ period: Number(e.target.value) })} /></Row>
                </div>
              )}
              {(a.indicator?.ind === "bb") && (
                <div className="grid grid-cols-3 gap-2">
                  <Row label="Band">
                    <select className={inputCls} value={a.indicator?.dir ?? "upper"} onChange={(e) => patchInd({ dir: e.target.value })}>
                      <option value="upper">Upper</option>
                      <option value="lower">Lower</option>
                    </select>
                  </Row>
                  <Row label="Period"><input type="number" className={inputCls} value={a.indicator?.period ?? 20} onChange={(e) => patchInd({ period: Number(e.target.value) })} /></Row>
                  <Row label="Multiplier"><input type="number" step="0.1" className={inputCls} value={a.indicator?.value ?? 2} onChange={(e) => patchInd({ value: Number(e.target.value) })} /></Row>
                </div>
              )}
              <p className="text-[10px] leading-snug text-slate-500">Indicator alerts are evaluated on this chart's REAL candles while the terminal is open ({symbol} · {timeframe.toUpperCase()}).</p>
            </div>
          )}

          {a.kind === "drawing" && (
            <div className="space-y-2">
              {drawings.length === 0 ? (
                <p className="text-[11px] text-amber-300">Open the chart with at least one drawing (horizontal line, trend line, channel, Fibonacci, Long/Short position) to attach an alert to it.</p>
              ) : (
                <>
                  <Row label="Drawing">
                    <select className={inputCls} value={a.drawing?.drawingId ?? ""} onChange={(e) => patchDraw({ drawingId: e.target.value })}>
                      {drawings.map((d) => (
                        <option key={d.id} value={d.id}>{d.name || toolDisplayName(d.type)}{d.type === "fib-retracement" || d.type === "fib-extension" ? " (fib)" : ""}</option>
                      ))}
                    </select>
                  </Row>
                  {selectedDrawing && (selectedDrawing.type === "fib-retracement" || selectedDrawing.type === "fib-extension") && (
                    <Row label="Fibonacci level">
                      <select className={inputCls} value={a.drawing?.fibIndex ?? 0} onChange={(e) => patchDraw({ fibIndex: Number(e.target.value), target: "fib" })}>
                        {selectedDrawing.levels?.length
                          ? selectedDrawing.levels.map((l, i) => <option key={i} value={i}>{(l.ratio * 100).toFixed(1)}%</option>)
                          : <option value={0}>0%</option>}
                      </select>
                    </Row>
                  )}
                  {selectedDrawing && (selectedDrawing.type === "long-position" || selectedDrawing.type === "short-position") && (
                    <Row label="Position level">
                      <select className={inputCls} value={a.drawing?.target ?? "entry"} onChange={(e) => patchDraw({ target: e.target.value as DrawingCond["target"] })}>
                        <option value="entry">Entry</option>
                        <option value="sl">Stop loss</option>
                        <option value="tp">Take profit</option>
                      </select>
                    </Row>
                  )}
                  <Row label="Crossing">
                    <select className={inputCls} value={a.drawing?.dir ?? "crossAbove"} onChange={(e) => patchDraw({ dir: e.target.value as DrawingCond["dir"] })}>
                      <option value="crossAbove">Price crosses ABOVE the level</option>
                      <option value="crossBelow">Price crosses BELOW the level</option>
                    </select>
                  </Row>
                  <p className="text-[10px] leading-snug text-slate-500">The alert follows the drawing: move the drawing and the alert level moves with it; delete the drawing and the alert pauses automatically.</p>
                </>
              )}
            </div>
          )}

          {/* frequency + expiration + message */}
          <div className="grid grid-cols-2 gap-2">
            <Row label="Trigger frequency">
              <select className={inputCls} value={a.frequency} onChange={(e) => patch({ frequency: e.target.value as TriggerFrequency })}>
                {(Object.keys(FREQ_LABEL) as TriggerFrequency[]).map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
              </select>
            </Row>
            {a.frequency === "repeat" && (
              <Row label="Cooldown (minutes)">
                <input type="number" min={1} max={1440} className={inputCls} value={a.cooldownMin ?? 60} onChange={(e) => patch({ cooldownMin: Number(e.target.value) })} />
              </Row>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Expires (optional)">
              <input type="datetime-local" className={inputCls} value={expiresLocal} onChange={(e) => { const t = e.target.value ? new Date(e.target.value).getTime() : null; patch({ expiresAt: t && Number.isFinite(t) ? t : null }); }} />
            </Row>
            <Row label="Custom message (optional)">
              <input className={inputCls} placeholder="e.g. Gold breakout!" value={a.message ?? ""} onChange={(e) => patch({ message: e.target.value })} />
            </Row>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-sky-600 hover:bg-sky-500" onClick={() => void submit()}>
            <BellRing className="mr-1 h-3.5 w-3.5" /> {editing ? "Save changes" : "Create alert"}
          </Button>
        </div>
      </div>
    </div>
  );
}
