/**
 * TradingAlertsManager — PHASE 47 Part 4: the dedicated alerts manager.
 * Active / triggered views, search + kind filter, pause/resume, edit,
 * duplicate, delete and the per-alert trigger history ring. Live via the
 * RTDB subscription (cross-device), matching the terminal's dark chrome.
 */
import { useEffect, useMemo, useState } from "react";
import { BellOff, BellRing, Copy, History, Pencil, Pause, Play, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TradingAlertDialog } from "./TradingAlertDialog";
import { priceBusUpdateMany } from "@/lib/price-store";
import { getAllPrices } from "@/lib/price-store";
import type { Timeframe } from "@shared/terminal";
import type { Drawing } from "@/lib/drawings";
import {
  fetchAlerts, patchAlert, removeAlert, subscribeAlerts, MAX_ALERTS_PER_USER, type TradingAlert,
} from "@/lib/trading-alerts";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

const KIND_BADGE: Record<TradingAlert["kind"], { label: string; cls: string }> = {
  price: { label: "price", cls: "bg-sky-900/60 text-sky-300" },
  dailyHL: { label: "daily H/L", cls: "bg-indigo-900/60 text-indigo-300" },
  indicator: { label: "indicator", cls: "bg-violet-900/60 text-violet-300" },
  drawing: { label: "drawing", cls: "bg-emerald-900/60 text-emerald-300" },
};

function describe(a: TradingAlert): string {
  switch (a.kind) {
    case "price": return `${a.direction === "above" ? "crosses above" : "crosses below"} ${a.price}`;
    case "dailyHL": return `previous-day ${a.direction === "above" ? "high" : "low"} breakout`;
    case "indicator": {
      const c = a.indicator!;
      if (c.ind === "rsi") return `RSI(${c.period ?? 14}) ${c.dir === "below" ? "≤" : "≥"} ${c.value ?? 70}`;
      if (c.ind === "macd") return `MACD ${c.dir === "bearish" ? "bearish" : "bullish"} cross`;
      if (c.ind === "emaCross") return `EMA(${c.period ?? 9}/${c.period2 ?? 21}) ${c.dir === "death" ? "death" : "golden"} cross`;
      if (c.ind === "smaCross") return `SMA(${c.period ?? 9}/${c.period2 ?? 21}) ${c.dir === "death" ? "death" : "golden"} cross`;
      if (c.ind === "priceVsMa") return `price ${c.dir === "below" ? "≤" : "≥"} MA(${c.period ?? 50})`;
      if (c.ind === "bb") return `Bollinger ${c.dir === "lower" ? "lower" : "upper"} band`;
      return `ATR(${c.period ?? 14}) ${c.dir === "below" ? "≤" : "≥"} ${c.value ?? 0}`;
    }
    case "drawing": return `drawing level ${a.drawing?.dir === "crossBelow" ? "cross below" : "cross above"}`;
    default: return "";
  }
}

function fmtWhen(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export function TradingAlertsManager({
  symbol, timeframe, lastPrice, drawings, className,
}: {
  symbol: string;
  timeframe: Timeframe;
  lastPrice: number | null;
  drawings?: Drawing[];
  className?: string;
}) {
  const [alerts, setAlerts] = useState<TradingAlert[]>([]);
  const [view, setView] = useState<"active" | "triggered">("active");
  const [q, setQ] = useState("");
  const [kindF, setKindF] = useState<"all" | TradingAlert["kind"]>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TradingAlert | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  useEffect(() => subscribeAlerts(setAlerts), []);
  // seed live prices for the watched symbols so the manager can show "now"
  useEffect(() => {
    void fetchAlerts().then((list) => {
      const map: Record<string, number> = {};
      const all = getAllPrices();
      for (const a of list) if (all[a.symbol] != null) map[a.symbol] = all[a.symbol];
      if (Object.keys(map).length) priceBusUpdateMany(map);
    }).catch(() => {});
  }, [alerts.length]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return alerts
      .filter((a) => (view === "active" ? !a.paused && !a.done : !!(a.lastTriggeredAt || a.history?.length)))
      .filter((a) => (kindF === "all" ? true : a.kind === kindF))
      .filter((a) => !needle || a.symbol.toLowerCase().includes(needle) || describe(a).toLowerCase().includes(needle))
      .sort((x, y) => (y.lastTriggeredAt ?? y.createdAt) - (x.lastTriggeredAt ?? x.createdAt));
  }, [alerts, view, q, kindF]);

  const togglePause = async (a: TradingAlert) => {
    await patchAlert(a.id, { paused: !a.paused, done: false });
    toast({ title: a.paused ? "Alert resumed" : "Alert paused", description: `${a.symbol} · ${describe(a)}` });
  };

  const duplicate = async (a: TradingAlert) => {
    if (alerts.length >= MAX_ALERTS_PER_USER) { toast({ title: `Alert limit (${MAX_ALERTS_PER_USER}) reached`, variant: "destructive" }); return; }
    const copy: TradingAlert = { ...a, id: `ta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), lastTriggeredAt: undefined, lastBarTime: undefined, history: [], paused: true };
    const { saveAlert } = await import("@/lib/trading-alerts");
    await saveAlert(copy);
    toast({ title: "Alert duplicated (paused)", description: "Resume it when you are ready." });
  };

  const del = async (a: TradingAlert) => {
    await removeAlert(a.id);
    toast({ title: "Alert deleted", description: "It can no longer trigger." });
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <div className="flex gap-1 rounded-md border border-slate-700/70 bg-slate-950/60 p-0.5">
          {(["active", "triggered"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded px-2.5 py-1 text-[11px] font-semibold capitalize", view === v ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200")}>{v}</button>
          ))}
        </div>
        <div className="relative ml-auto min-w-0 flex-1 max-w-[220px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search alerts…" className="h-7 w-full rounded border border-slate-700 bg-slate-950 pl-7 pr-2 text-[11px] text-slate-200" />
        </div>
        <Button size="sm" className="h-7 shrink-0 bg-sky-600 hover:bg-sky-500" onClick={() => { setEditing(null); setDialogOpen(true); }} title="New trading alert">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {(["all", "price", "dailyHL", "indicator", "drawing"] as const).map((k) => (
          <button key={k} onClick={() => setKindF(k)} className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold", kindF === k ? "border-sky-500/60 bg-sky-600/20 text-sky-200" : "border-slate-700/70 text-slate-500 hover:text-slate-300")}>
            {k === "all" ? "All" : KIND_BADGE[k].label}
          </button>
        ))}
        <span className="ml-auto self-center text-[10px] text-slate-500">{filtered.length} alert{filtered.length === 1 ? "" : "s"}</span>
      </div>

      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {filtered.length === 0 && (
          <p className="rounded-md border border-dashed border-slate-800 px-3 py-4 text-center text-[11px] text-slate-500">
            {view === "active" ? "No active alerts yet — create one from the chart context menu (right-click → Add price alert) or the + button." : "Nothing has triggered yet."}
          </p>
        )}
        {filtered.map((a) => (
          <div key={a.id} className={cn("rounded-md border px-2 py-1.5", a.paused || a.done ? "border-slate-800 bg-slate-950/40 opacity-70" : "border-slate-700/70 bg-slate-950/60")}>
            <div className="flex items-center gap-2">
              {a.paused || a.done ? <BellOff className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <BellRing className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-200">
                {a.symbol} <span className="font-normal text-slate-400">{describe(a)}</span>
                {a.message ? <span className="italic text-slate-500"> · “{a.message}”</span> : null}
              </span>
              <span className={cn("shrink-0 rounded px-1 text-[9px] font-bold uppercase", KIND_BADGE[a.kind].cls)}>{KIND_BADGE[a.kind].label}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
              <span>last: {fmtWhen(a.lastTriggeredAt)}</span>
              {a.history?.length ? (
                <button className="inline-flex items-center gap-0.5 hover:text-slate-300" onClick={() => setHistoryId(historyId === a.id ? null : a.id)}>
                  <History className="h-3 w-3" /> {a.history.length}
                </button>
              ) : null}
              <span className="ml-auto inline-flex items-center gap-0.5">
                <button title="Edit" onClick={() => { setEditing(a); setDialogOpen(true); }} className="rounded p-1 hover:text-sky-300"><Pencil className="h-3 w-3" /></button>
                <button title={a.paused || a.done ? "Resume" : "Pause"} onClick={() => void togglePause(a)} className="rounded p-1 hover:text-emerald-300">{a.paused || a.done ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}</button>
                <button title="Duplicate" onClick={() => void duplicate(a)} className="rounded p-1 hover:text-slate-300"><Copy className="h-3 w-3" /></button>
                <button title="Delete" onClick={() => void del(a)} className="rounded p-1 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
              </span>
            </div>
            {historyId === a.id && !!a.history?.length && (
              <div className="mt-1 space-y-0.5 rounded border border-slate-800 bg-slate-950 px-2 py-1">
                {[...a.history].reverse().map((h, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>{h.detail ?? ""}</span>
                    <span className="shrink-0 tabular-nums">{fmtWhen(h.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <TradingAlertDialog
        open={dialogOpen}
        symbol={symbol}
        timeframe={timeframe}
        lastPrice={lastPrice}
        drawings={drawings ?? []}
        editing={editing}
        onClose={() => { setDialogOpen(false); setEditing(null); }}
      />
    </div>
  );
}
