/**
 * AlertsPanel — terminal price alerts stored in RTDB (`terminalAlerts/{uid}`),
 * evaluated on every price tick by `checkAlerts` (called from TerminalPage).
 * In-app toasts now; email / browser-push hooks are left as future adapters.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ref, get, set, remove } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/lib/language-context";
import { INSTRUMENTS } from "@shared/terminal";
import { cn } from "@/lib/utils";

export interface TerminalAlert {
  id: string;
  symbol: string;
  direction: "above" | "below";
  price: number;
  createdAt: number;
  triggeredAt?: number;
  note?: string;
}

export function useTerminalAlerts() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: alerts = [] } = useQuery({
    queryKey: ["terminalAlerts", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<TerminalAlert[]> => {
      const snap = await get(ref(db, `terminalAlerts/${user!.uid}`));
      return snap.exists() ? Object.values<TerminalAlert>(snap.val()) : [];
    },
  });

  const add = async (a: Omit<TerminalAlert, "id" | "createdAt">) => {
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
  return { alerts, add, removeAlert };
}

/** Evaluate alerts against the latest prices; toast + mark triggered. */
export async function checkAlerts(
  alerts: TerminalAlert[],
  prices: Record<string, number>,
  fire: (title: string, description?: string) => void,
  soundOn: boolean,
) {
  const { auth } = await import("@/lib/firebase");
  const uid = auth.currentUser?.uid;
  for (const a of alerts) {
    if (a.triggeredAt) continue;
    const p = prices[a.symbol];
    if (p == null) continue;
    const hit = a.direction === "above" ? p >= a.price : p <= a.price;
    if (hit) {
      fire(`🔔 ${a.symbol} ${a.direction === "above" ? "≥" : "≤"} ${a.price}`, `Price: ${p}`);
      if (soundOn) playBeep();
      if (uid) await set(ref(db, `terminalAlerts/${uid}/${a.id}`), { ...a, triggeredAt: Date.now() });
    }
  }
}

function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; gain.gain.value = 0.05;
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch { /* autoplay blocked */ }
}

export function AlertsPanel({ prices, className }: { prices: Record<string, number>; className?: string }) {
  const { t } = useLanguage();
  const { alerts, add, removeAlert } = useTerminalAlerts();
  const [symbol, setSymbol] = useState("XAUUSD");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [price, setPrice] = useState("");

  const current = prices[symbol];

  return (
    <div className={cn("flex h-full min-h-0 flex-col space-y-2 p-2.5 text-xs", className)}>
      <div className="grid grid-cols-3 gap-1.5">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="num-input">
          {INSTRUMENTS.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value as "above" | "below")} className="num-input">
          <option value="above">{t("alAbove")}</option>
          <option value="below">{t("alBelow")}</option>
        </select>
        <input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={current?.toFixed(2)} className="num-input" />
      </div>
      <button
        onClick={() => { if (price) { add({ symbol, direction, price: Number(price) }); setPrice(""); } }}
        className="rounded-lg bg-emerald-500/15 py-1.5 text-[11px] font-bold text-emerald-400 hover:bg-emerald-500/25"
      >
        + {t("alAdd")}
      </button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {!alerts.length && <div className="py-6 text-center text-muted-foreground">{t("noAlerts")}</div>}
        {alerts.map((a) => (
          <div key={a.id} className={cn("flex items-center gap-2 rounded-lg border px-2 py-1.5", a.triggeredAt ? "border-border/40 bg-card/30 opacity-60" : "border-border/50 bg-card/50")}>
            <span className="font-semibold">{a.symbol}</span>
            <span className="text-muted-foreground">{a.direction === "above" ? "≥" : "≤"} <b className="font-number text-foreground">{a.price}</b></span>
            {a.triggeredAt ? <span className="ml-auto text-[10px] text-emerald-400">✓</span> : <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
            <button onClick={() => removeAlert(a.id)} className="text-muted-foreground hover:text-red-400">✕</button>
          </div>
        ))}
      </div>
      <p className="text-[9px] text-muted-foreground">{t("alNote")}</p>
    </div>
  );
}
