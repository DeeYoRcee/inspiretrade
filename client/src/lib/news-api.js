/**
 * Shared news API client — used by both the NewsPage feed and the
 * AlertsEngine so they hit the same react-query cache.
 */
export const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "NASDAQ", "USD", "BTC"];
/** Brand accent per symbol — works on every theme (text/border/background). */
export const SYMBOL_COLOR = {
    XAUUSD: "#f59e0b",
    EURUSD: "#60a5fa",
    GBPUSD: "#c084fc",
    NASDAQ: "#34d399",
    USD: "#2dd4bf",
    BTC: "#f7931a",
};
/** Currencies the calendar alert picker offers — gold (XAU) included, the
 *  metals row the journal trades. */
export const CALENDAR_CURRENCIES = ["USD", "EUR", "GBP", "XAU", "JPY", "CNY"];
export function fetchNews(language) {
    const qs = language && language !== "en" ? `?lang=${encodeURIComponent(language)}` : "";
    return fetch(`/api/news${qs}`).then(async (res) => {
        if (!res.ok)
            throw new Error(`news fetch failed: ${res.status}`);
        return res.json();
    });
}
