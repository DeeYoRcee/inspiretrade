/**
 * P75 — chart warm-up: close the "first-ever visit" gap the P74 snapshot
 * cannot cover (a brand-new browser session has no persisted tail).
 *
 * While the user is still on the dashboard, silently loadFeed the LAST used
 * symbol/timeframe a couple of seconds after mount. That fills the provider
 * cache AND writes the persisted tail snapshot, so entering the terminal
 * paints instantly — same session or after a restart. Once per 5 minutes,
 * best-effort, never blocking, never fabricating candles (it is the same
 * real loadFeed path the chart itself uses).
 */
import { loadFeed } from "@/lib/market-data";
import type { Timeframe } from "@shared/terminal";

const WARM_KEY = "it_chart_warmup_at";
const WARM_INTERVAL_MS = 5 * 60_000;
const WARM_DELAY_MS = 2_500;
const TF_WHITELIST: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];

export function scheduleChartWarmup(): void {
  try {
    const last = Number(localStorage.getItem(WARM_KEY) || 0);
    if (Date.now() - last < WARM_INTERVAL_MS) return;
    localStorage.setItem(WARM_KEY, String(Date.now()));

    const symbol = localStorage.getItem("it_terminal_symbol") || "EURUSD";
    const tfRaw = localStorage.getItem("it_terminal_tf") || "1m";
    const tf = (TF_WHITELIST as string[]).includes(tfRaw) ? (tfRaw as Timeframe) : null;
    if (!tf) return;

    setTimeout(() => {
      void loadFeed(symbol, tf).catch(() => { /* best-effort warm-up */ });
    }, WARM_DELAY_MS);
  } catch { /* private mode — skip */ }
}
