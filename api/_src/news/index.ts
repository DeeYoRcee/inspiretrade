/**
 * GET /api/news
 *
 * Aggregated market news (RSS) for the instruments the journal supports:
 * XAUUSD (gold), EURUSD, GBPUSD, NASDAQ (indices/stocks), USD (macro) and
 * BTC (crypto). Public read-only endpoint — no auth, no DB access.
 *
 * Server-side fetch avoids CORS; an in-memory cache (5 min per feed) keeps
 * us far below any rate limit on Vercel Hobby. Failed feeds are skipped so
 * one blocked source never breaks the endpoint.
 *
 * Function budget: 10/12 (health, rewards/claim, cases/open, market,
 * fragments/combine, admin, wallet, whop, referral, news).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const FEEDS: { url: string; source: string }[] = [
  { url: "https://www.investing.com/rss/news_1.rss", source: "Investing" }, // forex
  { url: "https://www.investing.com/rss/news_25.rss", source: "Investing" }, // stocks / indices
  { url: "https://www.investing.com/rss/news_285.rss", source: "Investing" }, // most popular
  { url: "https://www.forexlive.com/feed/news", source: "ForexLive" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
];

/** Keyword → symbol tagging. A story can carry several symbols. */
const TAG_RULES: { symbol: string; keywords: RegExp }[] = [
  { symbol: "XAUUSD", keywords: /\b(gold|xau|bullion|silver|xag)\b/i },
  { symbol: "EURUSD", keywords: /\b(eurusd|eur\/usd|euro|ecb|european central bank)\b/i },
  { symbol: "GBPUSD", keywords: /\b(gbpusd|gbp\/usd|pound|sterling|boe|bank of england)\b/i },
  { symbol: "NASDAQ", keywords: /\b(nasdaq|nas100|us100|nasdaq 100|tech stocks|big tech|magnificent seven)\b/i },
  { symbol: "USD", keywords: /\b(usd|dollar|greenback|fed|fomc|powell|federal reserve|treasury yields?|us indices)\b/i },
  { symbol: "BTC", keywords: /\b(btc|bitcoin|crypto|ethereum|stablecoin|altcoin|blockchain)\b/i },
];

interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
  summary: string;
  symbols: string[];
}

// ---- tiny RSS parsing (no dependencies) ------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return " ";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return " ";
      }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function cleanText(raw: string, maxLen: number): string {
  const text = decodeEntities(
    String(raw || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : "";
}

function parseFeed(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf("</item>");
    const body = end >= 0 ? block.slice(0, end) : block;
    const title = cleanText(pick(body, "title"), 220);
    const link = cleanText(pick(body, "link"), 500);
    if (!title || !link) continue;
    const pubRaw = pick(body, "pubDate") || pick(body, "published") || pick(body, "updated");
    const publishedAt = pubRaw ? new Date(pubRaw.trim()).getTime() || Date.now() : Date.now();
    const haystack = `${title} ${cleanText(pick(body, "description"), 600)}`;
    const symbols = TAG_RULES.filter((rule) => rule.keywords.test(haystack)).map((r) => r.symbol);
    items.push({
      title,
      link,
      source,
      publishedAt,
      summary: cleanText(pick(body, "description"), 220),
      symbols,
    });
  }
  return items;
}

// ---- in-memory cache (5 minutes per feed) ----------------------------------

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { at: number; items: NewsItem[] }>();

async function fetchFeed(url: string, source: string): Promise<NewsItem[]> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.items;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml, source);
    cache.set(url, { at: Date.now(), items });
    return items;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED", message: "GET only" });
  }

  const settled = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url, f.source)));
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      // dedupe by normalized title (same story across feeds)
      const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 90);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt);

  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
  res.status(200).json({
    ok: true,
    updatedAt: Date.now(),
    count: items.length,
    items: items.slice(0, 60),
  });
}
