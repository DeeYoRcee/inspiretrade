/**
 * Trading API client — typed access to the server-authoritative trading
 * engine (/api/trading). Every call carries the caller's Firebase ID token
 * (via authedFetch); the server verifies it and enforces account ownership.
 * Clients have NO direct Firestore access to the trading domain.
 */
import { authedFetch } from "@/lib/api";
export const tradingApi = {
    getAccounts: () => authedFetch("/api/trading?action=accounts").then((r) => r.accounts),
    createAccount: (label, startingBalance) => authedFetch("/api/trading?action=create", { label, startingBalance }).then((r) => r.account),
    placeOrder: (args) => authedFetch("/api/trading?action=order", args),
    closePosition: (accountId, positionId, lots) => authedFetch("/api/trading?action=close", { accountId, positionId, lots: lots ?? null }),
    modifyPosition: (accountId, positionId, patch) => authedFetch("/api/trading?action=modify", { accountId, positionId, ...patch }),
    cancelOrder: (accountId, orderId) => authedFetch("/api/trading?action=cancel", { accountId, orderId }),
    evaluate: (accountId) => authedFetch("/api/trading?action=evaluate", { accountId }),
    resetAccount: (accountId) => authedFetch("/api/trading?action=reset", { accountId }),
    getHistory: (accountId, limit = 100) => authedFetch(`/api/trading?action=history&accountId=${encodeURIComponent(accountId)}&limit=${limit}`)
        .then((r) => r.trades),
};
