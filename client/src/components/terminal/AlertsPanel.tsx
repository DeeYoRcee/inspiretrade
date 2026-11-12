/**
 * AlertsPanel — advanced alert builder + manager (v2).
 *
 * Alerts persist in RTDB `terminalAlerts/{uid}`. Kinds: price above/below,
 * RSI cross, MACD cross, EMA cross, Bollinger breakout, trendline breakout
 * (user drawing), S/R line crossing (user drawing) and previous-day high/low
 * breakout. Client evaluates all kinds on a 30s loop (alert-engine.ts); the
 * server cron (/api/alerts-cron) additionally evaluates price & dailyHL
 * hourly so alerts fire even with the terminal closed. Per-alert cooldown
 * prevents duplicate notifications on both sides.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ref, get, set, remove, update } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/lib/language-context";
import { INSTRUMENTS, TIMEFRAMES, type Timeframe } from "@shared/terminal";
import type { TerminalAlertV2, AlertKind } from "@/lib/terminal/alert-engine";
import { cn } from "@/lib/utils";

export type { TerminalAlertV2 };

const KIND_LABELS: Record<AlertKind, string> = {
  price: "Price above/below",
  rsi: "RSI crosses level",
  macd: "MACD × signal",
  emaCross: "EMA fast × slow",
  bbBreakout: "Bollinger breakout",
  trendline: "Trendline breakout",
  sr: "S/R line crossing",
  dailyHL: "Prev day H/L break",
};

export function useTerminalAlerts() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: alerts = [] } = useQuery({
    queryKey: ["terminalAlerts", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<TerminalAlertV2[]> => {
      const snap = await get(ref(db, `terminalAlerts/${user!.uid}`));
      return snap.exists() ? Object.values<TerminalAlertV2>(snap.val()) : [];
    },
  });

  const add = async (a: Omit<TerminalAlertV2, "id" | "createdAt">) => {
    if (!user) return;
    const id = Math.random().toString(36).slice(2, 10);
    await set(ref(db, `terminalAlerts/${user.uid}/${id}`), { ...a, id, createdAt: Date.now() });
    qc.invalidateQueries({ queryKey: ["terminalAlerts", user.uid] });
  };
  const removeAlert = async (id: string) => {
    if (!user) return;
    await remove(ref(db, `terminalAlerts/${user.uid}/${id}`));
    qc.invalidateQueries({ queryKey: ["terminalAlerts", user.uid] });
  };
  const patchAlert = async (id: string, patch: Partial<TerminalAlertV2>) => {
    if (!user) return;
    await update(ref(db, `terminalAlerts/${user.uid}/${id}`), patch);
    qc.invalidateQueries({ queryKey: ["terminalAlerts", user.uid] });
  };
  return { alerts, add, removeAlert, patchAlert };
}

function describe(a: TerminalAlertV2): string {
  const kind: AlertKind = a.kind ?? "price";
  switch (kind) {
    case "price": return `${a.symbol} ${a.direction === "above" ? "≥" : "≤"} ${a.price}`;
    case "dailyHL": return `${a.symbol} breaks prev day ${a.direction === "above" ? "high" : "low"}`;
    case "rsi": return `${a.symbol} ${a.timeframe ?? "1h"} RSI${a.p1 ?? 14} ${a.direction === "crossUp" ? "↑" : "↓"} ${a.p2 ?? 30}`;
    case "macd": return `${a.symbol} ${a.timeframe ?? "1h"} MACD ${a.direction === "crossUp" ? "↑" : "↓"} signal`;
    case "emaCross": return `${a.symbol} ${a.timeframe ?? "1h"} EMA${a.p1 ?? 9} ${a.direction === "crossUp" ? "↑" : "↓"} EMA${a.p2 ?? 21}`;
    case "bbBreakout": return `${a.symbol} ${a.timeframe ?? "1h"} closes ${a.direction === "above" ? "above upper" : "below lower"} BB`;
    case "trendline": return `${a.symbol} price ${a.direction === "above" ? ">" : "<"} trendline`;
    case "sr": return `${a.symbol} ${a.direction === "above" ? ">" : "<"} S/R ${a.price ?? ""}`;
  }
}

export function AlertsPanel({ prices, drawings, className }: {
  prices: Record<string, number>;
  drawings: { id: string; tool: string }[];
  className?: string;
}) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { alerts, add, removeAlert, patchAlert } = useTerminalAlerts();

  const [kind, setKind] = useState<AlertKind>("price");
  const [symbol, setSymbol] = useState("XAUUSD");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [direction, setDirection] = useState<TerminalAlertV2["direction"]>("above");
  const [price, setPrice] = useState("");
  const [p1, setP1] = useState(14);
  const [p2, setP2] = useState(30);
  const [drawingId, setDrawingId] = useState("");
  const [cooldown, setCooldown] = useState(60);
  const [expanded, setExpanded] = useState<string | null>(null);

  const needsTf = ["rsi", "macd", "emaCross", "bbBreakout"].includes(kind);
  const needsDrawing = ["trendline", "sr"].includes(kind);
  const usableDrawings = drawings.filter((d) => kind === "sr" ? d.tool === "hline" : ["trendline", "ray", "extline"].includes(d.tool));

  const submit = async () => {
    const base: Omit<TerminalAlertV2, "id" | "createdAt"> = {
      kind, symbol, direction, cooldownMin: cooldown,
    };
    if (kind === "price" || kind === "sr") { if (!price) return; base.price = Number(price); }
    if (needsTf) base.timeframe = timeframe;
    if (kind === "rsi") { base.p1 = p1; base.p2 = p2; }
    if (kind === "emaCross") { base.p1 = 9; base.p2 = 21; }
    if (kind === "bbBreakout") base.p1 = 20;
    if (needsDrawing) { if (!drawingId) return; base.drawingId = drawingId; base.timeframe = timeframe; }
    await add(base);
    setPrice("");
  };

  const lineDrawings = alerts.map((a) => {
    const k: AlertKind = a.kind ?? "price";
    return { a, k };
  });

  return (
    <div className={cn("flex h-full min-h-0 flex-col space-y-2 p-2.5 text-xs", className)}>
      {/* builder */}
      <select value={kind} onChange={(e) => setKind(e.target.value as AlertKind)} className="num-input">
        {(Object.keys(KIND_LABELS) as AlertKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
      </select>
      <div className="grid grid-cols-3 gap-1.5">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="num-input" aria-label="Alert instrument">
          {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
        </select>
        {needsTf ? (
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} className="num-input">
            {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        ) : (
          <select value={direction} onChange={(e) => setDirection(e.target.value as TerminalAlertV2["direction"])} className="num-input">
            <option value="above">{kind === "price" ? "≥ above" : "break up"}</option>
            <option value="below">{kind === "price" ? "≤ below" : "break down"}</option>
            {["rsi", "macd", "emaCross"].includes(kind) && <option value="crossUp">cross ↑</option>}
          </select>
        )}
        {needsDrawing ? (
          <select value={drawingId} onChange={(e) => setDrawingId(e.target.value)} className="num-input">
            <option value="">{usableDrawings.length ? "Pick drawing…" : "No drawings yet"}</option>
            {usableDrawings.map((d) => <option key={d.id} value={d.id}>{d.tool} {d.id.slice(0, 5)}</option>)}
          </select>
        ) : (
          <input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={kind === "price" ? String(prices[symbol]?.toFixed(4) ?? "level") : kind === "rsi" ? "level (30/70)" : "—"} className="num-input" />
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {kind === "rsi" && (
          <>
            <label className="text-[10px] text-muted-foreground">period</label>
            <input type="number" value={p1} onChange={(e) => setP1(Number(e.target.value))} className="num-input h-6 w-12" />
            <label className="text-[10px] text-muted-foreground">level</label>
            <input type="number" value={p2} onChange={(e) => setP2(Number(e.target.value))} className="num-input h-6 w-12" />
          </>
        )}
        <label className="ml-auto text-[10px] text-muted-foreground">cooldown</label>
        <input type="number" min="5" value={cooldown} onChange={(e) => setCooldown(Math.max(5, Number(e.target.value)))} title="minutes between repeat notifications" className="num-input h-6 w-14" />
        <span className="text-[10px] text-muted-foreground">min</span>
      </div>
      <button onClick={submit} className="rounded-lg bg-emerald-500/15 py-1.5 text-[11px] font-bold text-emerald-400 hover:bg-emerald-500/25">
        + {t("alAdd")}
      </button>

      {/* list */}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {!alerts.length && <div className="py-6 text-center text-muted-foreground">{t("noAlerts")}</div>}
        {lineDrawings.map(({ a, k }) => (
          <div key={a.id} className={cn("rounded-lg border px-2 py-1.5", a.paused ? "border-border/30 bg-card/20 opacity-55" : "border-border/50 bg-card/50")}>
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">{k}</span>
              <span className="min-w-0 flex-1 truncate">{describe(a)}</span>
              {(a.lastTriggeredAt || a.triggeredAt) && <span className="text-[9px] text-emerald-400" title={new Date(a.lastTriggeredAt ?? a.triggeredAt!).toLocaleString()}>✓</span>}
              <button onClick={() => patchAlert(a.id, { paused: !a.paused })} className="text-muted-foreground hover:text-foreground" title={a.paused ? "Resume" : "Pause"}>{a.paused ? "▶" : "⏸"}</button>
              <button onClick={() => removeAlert(a.id)} className="text-muted-foreground hover:text-red-400">✕</button>
            </div>
            {(a.history?.length ?? 0) > 0 && (
              <button onClick={() => setExpanded(expanded === a.id ? null : a.id)} className="mt-0.5 text-[9px] text-muted-foreground hover:text-foreground">
                {a.history!.length} trigger{a.history!.length > 1 ? "s" : ""} — {expanded === a.id ? "hide" : "view"}
              </button>
            )}
            {expanded === a.id && (
              <div className="mt-1 space-y-0.5 border-t border-border/30 pt-1">
                {(a.history ?? []).slice().reverse().map((h, i) => (
                  <div key={i} className="flex justify-between text-[9px] text-muted-foreground">
                    <span>{new Date(h.at).toLocaleString()}</span>
                    <span className="font-number">{h.price ?? h.value ?? ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {!user && <p className="text-[9px] text-amber-400">Sign in to persist alerts.</p>}
      <p className="text-[9px] leading-relaxed text-muted-foreground">
        Evaluated in-app every 30s; price &amp; prev-day levels are additionally evaluated server-side on a scheduled cron (external schedulers can call /api/alerts-cron more often). Repeat notifications respect the cooldown. Signals are informational — not trading advice.
      </p>
    </div>
  );
}
