/**
 * trading-alerts — PHASE 47: the Trading Alerts RTDB store + re-exports of
 * the pure condition math (lib/alerts-core).
 *
 * Architecture (Part 1 audit → reuse):
 *  · Server cron (api/_src/alerts-cron.ts) already evaluates `terminalAlerts/
 *    {uid}/{alertId}` kinds "price" | "dailyHL" against REAL prices (gold-api
 *    spot / Binance ticker / Yahoo chart) and delivers web push. It keeps its
 *    own field contract: direction, price, cooldownMin, paused,
 *    lastTriggeredAt, history — this module stores alerts in EXACTLY that
 *    shape so server and client evaluate the same records (dual dedup).
 *  · Indicator + drawing alerts need full OHLC / user drawings → evaluated
 *    CLIENT-side by TradingAlertsEngine (Terminal open), using the real
 *    indicator math from lib/indicators (no placeholders).
 *  · Records sync across devices via RTDB (user-scoped rules).
 *
 * Reliability (Part 7): trigger policy (once / once-per-bar / once-per-bar-
 * close / repeat+cooldown), expiration, lastTriggeredAt history ring and the
 * server's own write-back de-duplicate client and server evaluations.
 */
import { ref as dbRef, get, set, update, remove, onValue } from "firebase/database";
import { db, auth } from "@/lib/firebase";

export {
  // types
  type TradingAlertKind, type TriggerFrequency, type PriceDirection,
  type IndicatorCond, type DrawingCond, type TradingAlert,
  type EvalResult, type TriggerGateInput, type TriggerGateResult,
  // pure functions
  evaluatePriceAlert, evaluateIndicatorAlert, drawingLevel, evaluateDrawingAlert,
  triggerGate, alertDrawingMissing, sanitizeAlert, blankAlert,
  MAX_ALERTS_PER_USER,
} from "./alerts-core";

import type { TradingAlert } from "./alerts-core";

// ---- RTDB store (user-scoped rules; server cron reads the same node) ---------

const ALERTS_PATH = (uid: string) => `terminalAlerts/${uid}`;

/** All alerts of the signed-in user — one-shot read. */
export async function fetchAlerts(): Promise<TradingAlert[]> {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const snap = await get(dbRef(db, ALERTS_PATH(uid)));
  const val = snap.val() || {};
  return Object.entries<TradingAlert>(val).map(([, a]) => a).filter(Boolean);
}

/** Live subscription (cross-device sync). Returns an unsubscribe fn. */
export function subscribeAlerts(cb: (alerts: TradingAlert[]) => void): () => void {
  const uid = auth.currentUser?.uid;
  if (!uid) { cb([]); return () => {}; }
  const r = dbRef(db, ALERTS_PATH(uid));
  const off = onValue(r, (snap) => {
    const val = snap.val() || {};
    cb(Object.entries<TradingAlert>(val).map(([, a]) => a).filter(Boolean));
  }, () => cb([]));
  return off;
}

export async function saveAlert(a: TradingAlert): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Sign in to manage alerts");
  const { sanitizeAlert } = await import("./alerts-core");
  const clean = sanitizeAlert(a);
  if (!clean) throw new Error("Invalid alert");
  await set(dbRef(db, `${ALERTS_PATH(uid)}/${clean.id}`), clean);
}

export async function removeAlert(id: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  // deleting an alert must prevent ALL future triggers (Part 10): the record
  // (and its server-side trigger state) disappears entirely
  await remove(dbRef(db, `${ALERTS_PATH(uid)}/${id}`));
}

export async function patchAlert(id: string, patch: Partial<TradingAlert>): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  await update(dbRef(db, `${ALERTS_PATH(uid)}/${id}`), patch);
}

/** A trigger writes state + a capped history ring — same shape the cron writes. */
export async function recordTrigger(id: string, price: number, detail: string, opts: { once?: boolean; barTime?: number; previous?: TradingAlert }): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const prev = opts.previous;
  const now = Date.now();
  const history = [...(prev?.history ?? []), { at: now, price, detail }].slice(-20);
  await update(dbRef(db, `${ALERTS_PATH(uid)}/${id}`), {
    lastTriggeredAt: now,
    lastPrice: price,
    ...(opts.barTime != null ? { lastBarTime: opts.barTime } : {}),
    ...(opts.once ? { paused: true, done: true } : {}),
    history,
  });
}
