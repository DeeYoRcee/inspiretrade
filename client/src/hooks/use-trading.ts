/**
 * use-trading — client store for the server-authoritative trading account.
 *
 * Replaces the old use-terminal-trading demo adapter (client-side execution
 * against a writable RTDB node). All mutations now go through /api/trading;
 * this hook mirrors the server state, runs an evaluate+refresh heartbeat so
 * SL/TP/pending orders trigger while the terminal is open, and exposes the
 * same actions the trading panel needs. One singleton instance serves every
 * consumer (TerminalPage, TradingPanel, dashboards) — a single poller.
 */
import { useEffect, useSyncExternalStore } from "react";
import { tradingApi, type ServerAccount, type ServerTrade, type TradingMetrics, type CreateAccountArgs } from "@/lib/trading-api";
import type { Side, OrderKind } from "@shared/trading-engine";
import { useAuth } from "./use-auth";

export interface TradingState {
  accounts: ServerAccount[];
  activeId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  lastSync: number;
}

let state: TradingState = { accounts: [], activeId: null, loading: true, busy: false, error: null, lastSync: 0 };
let snapshot = state;
const listeners = new Set<() => void>();

function emit() {
  snapshot = { ...state };
  listeners.forEach((l) => l());
}

function patch(p: Partial<TradingState>) {
  state = { ...state, ...p };
  emit();
}

let heartbeat: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let currentUid: string | null = null;

function activeAccount(): ServerAccount | null {
  return state.accounts.find((a) => a.id === state.activeId) ?? state.accounts[0] ?? null;
}

function storageKey(uid: string) {
  return `it_terminal_account_${uid}`;
}

async function refresh(silent = true) {
  if (inFlight) return;
  inFlight = true;
  try {
    let accounts = await tradingApi.getAccounts();
    if (!accounts.length) {
      // first visit — provision the default $100,000 virtual account
      const acc = await tradingApi.createAccount({ label: "DEMO", startingBalance: 100000 });
      accounts = [acc];
    }
    const stored = currentUid ? localStorage.getItem(storageKey(currentUid)) : null;
    const activeId = accounts.some((a) => a.id === state.activeId)
      ? state.activeId
      : accounts.some((a) => a.id === stored) ? stored
      : accounts[0]?.id ?? null;
    patch({ accounts, activeId, loading: false, error: null, lastSync: Date.now() });
  } catch (e: any) {
    if (!silent) patch({ error: String(e?.message || e), loading: false });
    else if (!state.accounts.length) patch({ error: String(e?.message || e), loading: false });
  } finally {
    inFlight = false;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(async () => {
    const acc = activeAccount();
    if (!acc || document.hidden) return;
    try {
      await tradingApi.evaluate(acc.id); // SL/TP / pending / stop-out run server-side
      await refresh();
    } catch { /* transient — next tick retries */ }
  }, 10_000);
}

function stopHeartbeat() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

/** Sign-in / sign-out entry point — called by the hook's effect. */
function setUser(uid: string | null) {
  if (uid === currentUid) return;
  currentUid = uid;
  stopHeartbeat();
  if (!uid) {
    state = { accounts: [], activeId: null, loading: false, busy: false, error: null, lastSync: 0 };
    emit();
    return;
  }
  patch({ loading: true });
  void refresh(false);
  startHeartbeat();
}

async function run<T>(fn: () => Promise<T>): Promise<T | null> {
  patch({ busy: true, error: null });
  try {
    const out = await fn();
    await refresh();
    return out;
  } catch (e: any) {
    patch({ error: String(e?.message || e) });
    return null;
  } finally {
    patch({ busy: false });
  }
}

export const tradingActions = {
  setActiveId(id: string) {
    patch({ activeId: id });
    if (currentUid) localStorage.setItem(storageKey(currentUid), id);
  },
  placeOrder(args: { symbol: string; side: Side; lots: number; kind: OrderKind; price?: number | null; sl?: number | null; tp?: number | null }) {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.placeOrder({ accountId: acc.id, ...args }));
  },
  closePosition(positionId: string, lots?: number) {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.closePosition(acc.id, positionId, lots));
  },
  closeAll() {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.closeAll(acc.id));
  },
  modifyPosition(positionId: string, patchValues: { sl?: number | null; tp?: number | null }) {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.modifyPosition(acc.id, positionId, patchValues));
  },
  modifyOrder(orderId: string, patchValues: { price?: number; lots?: number; sl?: number | null; tp?: number | null }) {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.modifyOrder(acc.id, orderId, patchValues));
  },
  cancelOrder(orderId: string) {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.cancelOrder(acc.id, orderId));
  },
  createAccount(args: CreateAccountArgs = {}) {
    return run(async () => {
      const acc = await tradingApi.createAccount(args);
      patch({ activeId: acc.id });
      if (currentUid) localStorage.setItem(storageKey(currentUid), acc.id);
      return acc;
    });
  },
  resetAccount() {
    const acc = activeAccount();
    if (!acc) return Promise.resolve(null);
    return run(() => tradingApi.resetAccount(acc.id));
  },
  refreshNow() {
    const acc = activeAccount();
    return run(async () => {
      if (acc) await tradingApi.evaluate(acc.id).catch(() => null);
      await refresh();
    });
  },
  clearError() {
    patch({ error: null });
  },
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface UseTrading extends TradingState {
  account: ServerAccount | null;
  metrics: TradingMetrics | null;
  positions: ServerAccount["positions"];
  orders: ServerAccount["orders"];
  quotes: ServerAccount["quotes"];
  setActiveId: (id: string) => void;
  placeOrder: typeof tradingActions.placeOrder;
  closePosition: typeof tradingActions.closePosition;
  closeAll: typeof tradingActions.closeAll;
  modifyPosition: typeof tradingActions.modifyPosition;
  modifyOrder: typeof tradingActions.modifyOrder;
  cancelOrder: typeof tradingActions.cancelOrder;
  createAccount: typeof tradingActions.createAccount;
  resetAccount: typeof tradingActions.resetAccount;
  refreshNow: typeof tradingActions.refreshNow;
  clearError: () => void;
}

export function useTrading(): UseTrading {
  const { user } = useAuth();
  useEffect(() => {
    setUser(user?.uid ?? null);
    const onVisible = () => { if (!document.hidden && currentUid) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [user?.uid]);

  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const account = snap.accounts.find((a) => a.id === snap.activeId) ?? snap.accounts[0] ?? null;

  return {
    ...snap,
    account,
    metrics: account?.metrics ?? null,
    positions: account?.positions ?? [],
    orders: account?.orders ?? [],
    quotes: account?.quotes ?? {},
    setActiveId: tradingActions.setActiveId,
    placeOrder: tradingActions.placeOrder,
    closePosition: tradingActions.closePosition,
    closeAll: tradingActions.closeAll,
    modifyPosition: tradingActions.modifyPosition,
    modifyOrder: tradingActions.modifyOrder,
    cancelOrder: tradingActions.cancelOrder,
    createAccount: tradingActions.createAccount,
    resetAccount: tradingActions.resetAccount,
    refreshNow: tradingActions.refreshNow,
    clearError: tradingActions.clearError,
  };
}

/** Map the server fills ledger into the legacy DemoPosition shape used by
 *  prop-analytics (equity curves, drawdown, per-day stats). */
export function tradesToHistory(trades: ServerTrade[]) {
  return trades.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    lots: t.lots,
    entry: t.entry,
    sl: null,
    tp: null,
    openedAt: t.openedAt,
    status: "closed" as const,
    exit: t.exit,
    profit: t.pnl,
    closedAt: t.closedAt,
    comment: t.reason,
  }));
}
