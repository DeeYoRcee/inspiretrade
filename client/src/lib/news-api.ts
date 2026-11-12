/**
 * Shared news API client — used by both the NewsPage feed and the
 * AlertsEngine so they hit the same react-query cache.
 */

export const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "NASDAQ", "USD", "BTC"] as const;
export type NewsSymbol = (typeof SYMBOLS)[number];

/** Brand accent per symbol — works on every theme (text/border/background). */
export const SYMBOL_COLOR: Record<string, string> = {
  XAUUSD: "#f59e0b",
  EURUSD: "#60a5fa",
  GBPUSD: "#c084fc",
  NASDAQ: "#34d399",
  USD: "#2dd4bf",
  BTC: "#f7931a",
};

/** Currencies the calendar alert picker offers (matches the journal's pairs). */
export const CALENDAR_CURRENCIES = ["USD", "EUR", "GBP", "CNY", "JPY"] as const;

export interface NewsItem {
  title: string;
  titleEn?: string;
  link: string;
  source: string;
  publishedAt: number;
  summary: string;
  symbols: string[];
}

export interface CalEvent {
  id: string;
  title: string;
  titleEn?: string;
  currency: string;
  date: number;
  impact: string;
  forecast: string;
  previous: string;
}

export interface NewsResponse {
  ok: boolean;
  updatedAt: number;
  lang: string;
  count: number;
  items: NewsItem[];
  calendar?: CalEvent[];
  calendarOk?: boolean;
}

export function fetchNews(language: string): Promise<NewsResponse> {
  const qs = language && language !== "en" ? `?lang=${encodeURIComponent(language)}` : "";
  return fetch(`/api/news${qs}`).then(async (res) => {
    if (!res.ok) throw new Error(`news fetch failed: ${res.status}`);
    return res.json();
  });
}
