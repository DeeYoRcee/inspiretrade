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
import { tradingApi } from "@/lib/trading-api";
import { useAuth } from "./use-auth";
let state = { accounts: [], activeId: null, loading: true, busy: false, error: null, lastSync: 0 };
let snapshot = state;
const listeners = new Set();
function emit() {
    snapshot = { ...state };
    listeners.forEach((l) => l());
}
function patch(p) {
    state = { ...state, ...p };
    emit();
}
let heartbeat = null;
let inFlight = false;
let currentUid = null;
function activeAccount() {
    return state.accounts.find((a) => a.id === state.activeId) ?? state.accounts[0] ?? null;
}
function storageKey(uid) {
    return `it_terminal_account_${uid}`;
}
async function refresh(silent = true) {
    if (inFlight)
        return;
    inFlight = true;
    try {
        let accounts = await tradingApi.getAccounts();
        if (!accounts.length) {
            // first visit — provision the default $100,000 virtual account
            const acc = await tradingApi.createAccount("DEMO", 100000);
            accounts = [acc];
        }
        const stored = currentUid ? localStorage.getItem(storageKey(currentUid)) : null;
        const activeId = accounts.some((a) => a.id === state.activeId)
            ? state.activeId
            : accounts.some((a) => a.id === stored) ? stored
                : accounts[0]?.id ?? null;
        patch({ accounts, activeId, loading: false, error: null, lastSync: Date.now() });
    }
    catch (e) {
        if (!silent)
            patch({ error: String(e?.message || e), loading: false });
        else if (!state.accounts.length)
            patch({ error: String(e?.message || e), loading: false });
    }
    finally {
        inFlight = false;
    }
}
function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(async () => {
        const acc = activeAccount();
        if (!acc || document.hidden)
            return;
        try {
            await tradingApi.evaluate(acc.id); // SL/TP / pending / stop-out run server-side
            await refresh();
        }
        catch { /* transient — next tick retries */ }
    }, 10000);
}
function stopHeartbeat() {
    if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
}
/** Sign-in / sign-out entry point — called by the hook's effect. */
function setUser(uid) {
    if (uid === currentUid)
        return;
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
async function run(fn) {
    patch({ busy: true, error: null });
    try {
        const out = await fn();
        await refresh();
        return out;
    }
    catch (e) {
        patch({ error: String(e?.message || e) });
        return null;
    }
    finally {
        patch({ busy: false });
    }
}
export const tradingActions = {
    setActiveId(id) {
        patch({ activeId: id });
        if (currentUid)
            localStorage.setItem(storageKey(currentUid), id);
    },
    placeOrder(args) {
        const acc = activeAccount();
        if (!acc)
            return Promise.resolve(null);
        return run(() => tradingApi.placeOrder({ accountId: acc.id, ...args }));
    },
    closePosition(positionId, lots) {
        const acc = activeAccount();
        if (!acc)
            return Promise.resolve(null);
        return run(() => tradingApi.closePosition(acc.id, positionId, lots));
    },
    modifyPosition(positionId, patchValues) {
        const acc = activeAccount();
        if (!acc)
            return Promise.resolve(null);
        return run(() => tradingApi.modifyPosition(acc.id, positionId, patchValues));
    },
    cancelOrder(orderId) {
        const acc = activeAccount();
        if (!acc)
            return Promise.resolve(null);
        return run(() => tradingApi.cancelOrder(acc.id, orderId));
    },
    createAccount(label, startingBalance) {
        return run(async () => {
            const acc = await tradingApi.createAccount(label, startingBalance);
            patch({ activeId: acc.id });
            if (currentUid)
                localStorage.setItem(storageKey(currentUid), acc.id);
            return acc;
        });
    },
    resetAccount() {
        const acc = activeAccount();
        if (!acc)
            return Promise.resolve(null);
        return run(() => tradingApi.resetAccount(acc.id));
    },
    refreshNow() {
        const acc = activeAccount();
        return run(async () => {
            if (acc)
                await tradingApi.evaluate(acc.id).catch(() => null);
            await refresh();
        });
    },
    clearError() {
        patch({ error: null });
    },
};
function subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}
export function useTrading() {
    const { user } = useAuth();
    useEffect(() => {
        setUser(user?.uid ?? null);
        const onVisible = () => { if (!document.hidden && currentUid)
            void refresh(); };
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
        modifyPosition: tradingActions.modifyPosition,
        cancelOrder: tradingActions.cancelOrder,
        createAccount: tradingActions.createAccount,
        resetAccount: tradingActions.resetAccount,
        refreshNow: tradingActions.refreshNow,
        clearError: tradingActions.clearError,
    };
}
/** Map the server fills ledger into the legacy DemoPosition shape used by
 *  prop-analytics (equity curves, drawdown, per-day stats). */
export function tradesToHistory(trades) {
    return trades.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        lots: t.lots,
        entry: t.entry,
        sl: null,
        tp: null,
        openedAt: t.openedAt,
        status: "closed",
        exit: t.exit,
        profit: t.pnl,
        closedAt: t.closedAt,
        comment: t.reason,
    }));
}
