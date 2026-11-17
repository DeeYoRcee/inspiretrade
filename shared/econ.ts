/**
 * Economic calendar data model + normalization (Phase 5 fundamental suite).
 *
 * The upstream is the public ForexFactory weekly/monthly JSON mirror
 * (nfs.faireconomy.media) fetched SERVER-SIDE by the /api/news dispatcher
 * (?econ=calendar&range=…). Both the serverless function and the client
 * import this module, so tests can pin the normalization without network.
 *
 * No synthetic events: anything the mirror doesn't ship simply stays empty.
 */

export type Impact = "High" | "Medium" | "Low" | "Holiday";

export interface CalEventFull {
  id: string;
  title: string;
  currency: string;
  country: string;
  flag: string;
  /** epoch ms of the release moment (already absolute — upstream ships TZ offsets) */
  date: number;
  impact: Impact;
  forecast: string;
  previous: string;
  actual: string;
}

export interface CountryMeta {
  currency: string;
  name: string;
  flag: string;
}

/** Country code → currency / display name / flag (upstream ships 2-letter codes). */
export const COUNTRY_META: Record<string, CountryMeta> = {
  US: { currency: "USD", name: "United States", flag: "🇺🇸" },
  EU: { currency: "EUR", name: "Euro Area", flag: "🇪🇺" },
  GB: { currency: "GBP", name: "United Kingdom", flag: "🇬🇧" },
  UK: { currency: "GBP", name: "United Kingdom", flag: "🇬🇧" },
  JP: { currency: "JPY", name: "Japan", flag: "🇯🇵" },
  AU: { currency: "AUD", name: "Australia", flag: "🇦🇺" },
  NZ: { currency: "NZD", name: "New Zealand", flag: "🇳🇿" },
  CA: { currency: "CAD", name: "Canada", flag: "🇨🇦" },
  CH: { currency: "CHF", name: "Switzerland", flag: "🇨🇭" },
  CN: { currency: "CNY", name: "China", flag: "🇨🇳" },
  DE: { currency: "EUR", name: "Germany", flag: "🇩🇪" },
  FR: { currency: "EUR", name: "France", flag: "🇫🇷" },
  IT: { currency: "EUR", name: "Italy", flag: "🇮🇹" },
  ES: { currency: "EUR", name: "Spain", flag: "🇪🇸" },
  ALL: { currency: "ALL", name: "Global", flag: "🌍" },
};

export function countryMeta(code: string): CountryMeta {
  const key = String(code || "").toUpperCase().slice(0, 3);
  return COUNTRY_META[key] ?? { currency: key || "—", name: key, flag: "🏳️" };
}

function normImpact(raw: string): Impact {
  const s = String(raw || "").toLowerCase();
  if (s.startsWith("high")) return "High";
  if (s.startsWith("medium") || s.startsWith("moderate")) return "Medium";
  if (s.startsWith("non-economic") || s.startsWith("holiday")) return "Holiday";
  return "Low";
}

/** One upstream row → CalEventFull (or null when unusable). */
export function normalizeFfEvent(e: any): CalEventFull | null {
  const title = String(e?.title ?? e?.Title ?? "").replace(/\s+/g, " ").trim();
  const date = new Date(e?.date ?? "").getTime() || 0;
  const currencyRaw = String(e?.country ?? e?.currency ?? "").toUpperCase().slice(0, 3);
  if (!title || !date || !currencyRaw) return null;
  const meta = countryMeta(currencyRaw);
  const impact = normImpact(String(e?.impact ?? e?.Importance ?? ""));
  return {
    id: `${meta.currency}-${date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30)}`,
    title,
    currency: meta.currency,
    country: meta.name,
    flag: meta.flag,
    date,
    impact,
    forecast: String(e?.forecast ?? "").slice(0, 24),
    previous: String(e?.previous ?? "").slice(0, 24),
    actual: String(e?.actual ?? "").slice(0, 24),
  };
}

/** Normalize + drop unusable rows + dedupe (id) + sort by time. */
export function normalizeFfCalendar(raw: any[]): { events: CalEventFull[]; ok: boolean } {
  if (!Array.isArray(raw)) return { events: [], ok: false };
  const seen = new Set<string>();
  const events: CalEventFull[] = [];
  for (const row of raw) {
    const ev = normalizeFfEvent(row);
    if (!ev || seen.has(ev.id)) continue;
    seen.add(ev.id);
    events.push(ev);
  }
  events.sort((a, b) => a.date - b.date);
  return { events, ok: events.length > 0 || Array.isArray(raw) };
}

// ---------------------------------------------------------------------------
// Instrument → currencies / news tags (used by the terminal event strip and
// the "relevant news" filter). Quote currency included — a US release moves
// BTCUSD and EURUSD alike.
// ---------------------------------------------------------------------------

export function symbolCurrencies(symbol: string): string[] {
  const s = String(symbol || "").toUpperCase();
  // metals & crypto quote USD
  if (s === "XAUUSD" || s === "XAGUSD") return ["USD"];
  if (s === "BTCUSD" || s === "ETHUSD" || s === "SOLUSD" || s === "XRPUSD") return ["USD"];
  const fx = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"] as const;
  if ((fx as readonly string[]).includes(s)) return [s.slice(0, 3), "USD"];
  if (s === "USDJPY" || s === "USDCAD" || s === "USDCHF") return ["USD", s.slice(3)];
  const idx: Record<string, string[]> = {
    NAS100: ["USD"], US30: ["USD"], SPX500: ["USD"], GER40: ["EUR"], UK100: ["GBP"],
  };
  return idx[s] ?? ["USD"];
}

/** News symbol tags (client /api/news tagging scheme) relevant to a terminal symbol. */
export function symbolNewsTags(symbol: string): string[] {
  const s = String(symbol || "").toUpperCase();
  if (s === "XAUUSD" || s === "XAGUSD") return ["XAUUSD", "USD"];
  if (s === "BTCUSD" || s === "ETHUSD" || s === "SOLUSD" || s === "XRPUSD") return ["BTC", "USD"];
  if (s === "EURUSD") return ["EURUSD", "USD"];
  if (s === "GBPUSD") return ["GBPUSD", "USD"];
  if (s === "NAS100" || s === "US30" || s === "SPX500") return ["NASDAQ", "USD"];
  if (s === "GER40") return ["EURUSD"];
  if (s === "UK100") return ["GBPUSD"];
  return ["USD"]; // USDJPY / USDCAD / USDCHF and unknown symbols: the USD macro feed
}

/** News category buckets (Phase 5 news workspace filter chips). */
export const NEWS_CATEGORIES = ["All", "Forex", "Gold", "USD & Fed", "EUR & ECB", "Indices", "Crypto"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

const CAT_RULES: { cat: Exclude<NewsCategory, "All">; test: RegExp }[] = [
  { cat: "Gold", test: /\b(gold|xau|bullion|silver|xag|precious metals?)\b/i },
  { cat: "Crypto", test: /\b(btc|bitcoin|crypto|ethereum|stablecoin|altcoin|blockchain)\b/i },
  { cat: "EUR & ECB", test: /\b(ecb|european central bank|lagarde|eurozone|eur\/usd|eurusd|euro)\b/i },
  { cat: "USD & Fed", test: /\b(fed|fomc|powell|federal reserve|usd|dollar|greenback|dxy|dollar index|treasury|nonfarm|payrolls|cpi)\b/i },
  { cat: "Forex", test: /\b(forex|fx market|eur|gbp|sterling|pound|jpy|yen|aud|nzd|cad|chf|franc|currency|pip|bank of england|boj|boe|rba|boc|snb|rbnz)\b/i },
  { cat: "Indices", test: /\b(nasdaq|s&p|dow|index futures|wall street|stocks?|equities)\b/i },
];

/** Assign every matching category (a story can live in several buckets). */
export function newsCategories(item: { title: string; summary?: string; symbols?: string[] }): NewsCategory[] {
  const hay = `${item.title} ${item.summary ?? ""}`;
  const out = CAT_RULES.filter((r) => r.test.test(hay)).map((r) => r.cat);
  if (out.length === 0) {
    // fall back to the server-side instrument tags so nothing becomes invisible
    const syms = item.symbols ?? [];
    if (syms.includes("XAUUSD")) return ["Gold"];
    if (syms.includes("BTC")) return ["Crypto"];
    if (syms.includes("NASDAQ")) return ["Indices"];
    if (syms.includes("EURUSD")) return ["EUR & ECB", "Forex"];
    if (syms.includes("GBPUSD")) return ["Forex"];
    if (syms.includes("USD")) return ["USD & Fed"];
  }
  return out.length ? out : ["Forex"];
}

// ---------------------------------------------------------------------------
// Event knowledge base — AI-generated explanatory analysis for common event
// types. CLEARLY LABELED as analysis in the UI; never presented as fact about
// any specific unreleased release, and never as a guaranteed outcome.
// ---------------------------------------------------------------------------

export interface EventKnowledge {
  key: string;
  what: string;
  affects: string[];
  why: string;
  historical: string;
}

export const EVENT_KNOWLEDGE: EventKnowledge[] = [
  {
    key: "nfp",
    what: "Non-Farm Payrolls count the net new jobs (ex-farming) added by the US economy in the prior month, released with the unemployment rate and average hourly earnings.",
    affects: ["USD", "DXY", "XAUUSD", "EURUSD", "USDJPY", "US indices", "BTC (risk sentiment)"],
    why: "It is the single most-watched US data point: job growth drives Fed rate expectations. A big beat typically lifts USD and yields while pressuring gold; a big miss does the opposite. Wage growth matters for the inflation outlook.",
    historical: "Historically the release produces sharp USD spikes within seconds; gold often whipsaws $10-30 on the initial print before following the rates narrative. Direction depends on the surprise vs forecast, not the absolute number.",
  },
  {
    key: "cpi",
    what: "Consumer Price Index tracks the change in prices paid by consumers — the headline inflation gauge, released m/m and y/y with a core (ex-food/energy) variant.",
    affects: ["USD", "DXY", "XAUUSD", "EURUSD", "US yields", "US indices"],
    why: "Inflation is the core input for central-bank policy. Hotter CPI pushes rate-hike expectations up (USD up, gold down, stocks pressured); cooler CPI supports rate-cut bets and risk assets.",
    historical: "CPI days routinely move the dollar index ~0.5-1% and gold $15-40. Markets react to the core figure more than the headline.",
  },
  {
    key: "rate-decision",
    what: "A central bank interest-rate decision sets the policy rate, published with a statement; many meetings add updated economic projections and a press conference.",
    affects: ["The issuer's currency", "Rate-sensitive pairs", "Local indices", "Gold (for the Fed)"],
    why: "The rate path is the anchor of every currency valuation. The statement wording (hawkish/dovish) and the press conference Q&A often move markets more than the decision itself.",
    historical: "Unchanged-rate meetings with unexpected wording shifts have produced some of the largest FX moves on record; watch the press-conference window, volatility clusters there.",
  },
  {
    key: "gdp",
    what: "Gross Domestic Product measures the total value of goods and services produced — the broadest gauge of economic growth, released quarterly (with revisions).",
    affects: ["Local currency", "Local indices", "Related FX pairs"],
    why: "Growth data shifts both policy expectations and risk sentiment. Strong GDP supports the currency via rate expectations; weak GDP can trigger stimulus bets.",
    historical: "Revisions matter: markets react to the surprise and to the revision pattern of prior quarters.",
  },
  {
    key: "pmi",
    what: "Purchasing Managers' Index surveys factory (manufacturing) or services firms about activity, orders, employment and prices — a leading indicator of the business cycle.",
    affects: ["Local currency", "Local indices", "Commodity currencies (AUD, CAD)"],
    why: "PMIs come out before GDP and quickly reframe the growth outlook. The 50 level divides expansion from contraction; markets watch the flash (preliminary) prints.",
    historical: "Sustained PMI slides below 50 have historically preceded policy pivots — the currency often weakens in anticipation.",
  },
  {
    key: "unemployment",
    what: "The unemployment rate and claims series (initial jobless claims weekly) measure labour-market slack.",
    affects: ["USD (claims, US rate)", "Local currency per release"],
    why: "Labour slack feeds wage pressure and policy decisions. Weekly claims are the fastest US labour signal between NFP prints.",
    historical: "Claims breakouts (sustained jumps) have historically flagged recessions before GDP confirms them.",
  },
  {
    key: "retail-sales",
    what: "Retail sales measure consumer spending at stores and online — the bulk of household demand, released monthly.",
    affects: ["Local currency", "Consumer indices"],
    why: "Consumption drives growth; the print directly shifts the policy outlook. Ex-auto/core variants remove volatile components.",
    historical: "US retail sales surprises tend to align USD moves with the rates narrative on the day.",
  },
  {
    key: "ppi",
    what: "Producer Price Index tracks prices received by domestic producers — an upstream inflation signal that often leads CPI.",
    affects: ["USD", "EUR", "Local currency", "Rate expectations"],
    why: "Rising producer prices feed into consumer inflation with a lag, so the market treats PPI as an early CPI warning.",
    historical: "PPI surprises usually reinforce the CPI narrative formed the same month.",
  },
  {
    key: "trade-balance",
    what: "Trade balance measures exports minus imports; a surplus means more currency demand from abroad.",
    affects: ["Local currency", "Commodity currencies"],
    why: "Persistent surpluses/deficits shape long-run currency demand; monthly swings matter less than the trend.",
    historical: "Moves are usually moderate unless the print flips the market's trend view.",
  },
  {
    key: "consumer-confidence",
    what: "Consumer confidence surveys (Michigan, Conference Board, GfK) gauge household sentiment about jobs and finances.",
    affects: ["Local currency", "Consumer stocks"],
    why: "Confidence leads spending: falling sentiment precedes weaker retail data and supports stimulus expectations.",
    historical: "Sharp drops have historically preceded recessions by several months.",
  },
  {
    key: "housing",
    what: "Housing starts / building permits / existing home sales measure construction and property-market activity — highly rate-sensitive sectors.",
    affects: ["USD", "AUD", "CAD", "Rate expectations"],
    why: "Housing is the first sector hit by rate hikes, so it is a real-time check on the policy transmission the market is pricing.",
    historical: "Permits lead starts; the pair is watched for the turn in the rate cycle.",
  },
  {
    key: "ism",
    what: "The ISM Manufacturing/Services indices are the US PMI equivalents, with prices-paid and employment sub-indices.",
    affects: ["USD", "US indices", "XAUUSD"],
    why: "The services print dominates a services-led economy; the prices-paid component feeds the inflation narrative.",
    historical: "ISM below 50 streaks have historically preceded Fed easing cycles.",
  },
  {
    key: "central-bank-speech",
    what: "Scheduled appearances by central-bank governors or board members; markets parse them for hints about the next policy move.",
    affects: ["Issuer currency", "Related pairs", "Gold (Fed speakers)"],
    why: "Speeches reprice expectations without new data. Tone shifts (hawkish↔dovish) are the trigger, especially in quiet weeks.",
    historical: "Powell/Lagarde testimony windows show elevated volatility; questions are more market-moving than prepared remarks.",
  },
  {
    key: "bond-auction",
    what: "Government debt auctions (10y, 30y etc.) show sovereign borrowing demand; the bid-to-cover ratio is the demand gauge.",
    affects: ["Yields", "USD", "JPY", "Rate-sensitive assets"],
    why: "Weak auctions lift yields and pressure risk assets; strong demand does the reverse.",
    historical: "Series of soft auctions in 2023 pushed US yields to cycle highs — a textbook demand-signal case.",
  },
];

const KNOWLEDGE_RULES: { key: string; test: RegExp }[] = [
  { key: "nfp", test: /non-?farm|payroll|employment change.*us|jobless.*month/i },
  { key: "cpi", test: /\bc\.?p\.?i\.?\b|consumer price/i },
  { key: "rate-decision", test: /interest rate decision|rate decision|fomc|monetary policy statement|policy rate|cash rate|bank rate|repo rate/i },
  { key: "gdp", test: /\bg\.?d\.?p\.?\b|gross domestic/i },
  { key: "pmi", test: /\bpmi\b|purchasing managers/i },
  { key: "unemployment", test: /unemployment|jobless claims|initial claims/i },
  { key: "retail-sales", test: /retail sales/i },
  { key: "ppi", test: /\bp\.?p\.?i\.?\b|producer price/i },
  { key: "trade-balance", test: /trade balance|merchandise trade|current account/i },
  { key: "consumer-confidence", test: /consumer (confidence|sentiment)|michigan sentiment/i },
  { key: "housing", test: /housing starts|building permits|existing home|new home sales|home price/i },
  { key: "ism", test: /\bism\b/i },
  { key: "central-bank-speech", test: /speech|testimony|press conference/i },
  { key: "bond-auction", test: /auction|bond sale/i },
];

/** Knowledge entry for an event title (null when the title is too specific). */
export function eventKnowledge(title: string): EventKnowledge | null {
  for (const rule of KNOWLEDGE_RULES) {
    if (rule.test.test(title)) {
      const entry = EVENT_KNOWLEDGE.find((k) => k.key === rule.key);
      if (entry) return entry;
    }
  }
  return null;
}
