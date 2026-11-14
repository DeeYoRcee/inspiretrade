/**
 * GET /api/news[?lang=ru|uz|ar]
 *
 * Aggregated market news (RSS) for the instruments the journal supports:
 * XAUUSD (gold), EURUSD, GBPUSD, NASDAQ (indices/stocks), USD (macro) and
 * BTC (crypto). Public read-only endpoint — no auth, no DB access.
 *
 * - Direct feeds (Investing.com, ForexLive, Cointelegraph, CNBC) + one
 *   Google-News search feed per symbol (`when:7d`) for 7-day coverage.
 * - Stories older than 7 days are dropped; result is capped at 250 items.
 * - `?lang=` translates titles/summaries server-side via the public
 *   translate endpoint (batched, in-memory cache, English fallback).
 * - `calendar` = this week's HIGH-impact economic events (ForexFactory
 *   weekly JSON, 30-min cache). On failure the field is empty and
 *   `calendarOk:false` — the UI keeps working, alerts just stay quiet.
 *
 * Function budget: 10/12 (health, rewards/claim, cases/open, market,
 * fragments/combine, admin, wallet, whop, referral, news).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GOOGLE_NEWS = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=en-US&gl=US&ceid=US:en`;

const FEEDS: { url: string; source: string; google: boolean }[] = [
  { url: "https://www.investing.com/rss/news_1.rss", source: "Investing", google: false }, // forex
  { url: "https://www.investing.com/rss/news_11.rss", source: "Investing", google: false }, // commodities / gold
  { url: "https://www.investing.com/rss/news_14.rss", source: "Investing", google: false }, // economy
  { url: "https://www.investing.com/rss/news_25.rss", source: "Investing", google: false }, // stocks / indices
  { url: "https://www.investing.com/rss/news_285.rss", source: "Investing", google: false }, // most popular
  { url: "https://www.forexlive.com/feed/news", source: "ForexLive", google: false },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph", google: false },
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC", google: false }, // economy
  // Per-symbol Google News searches — give the 7-day history the direct
  // feeds can't. Source is taken from the <source> tag inside each item.
  { url: GOOGLE_NEWS("gold price OR XAUUSD"), source: "Google News", google: true },
  { url: GOOGLE_NEWS("EURUSD OR \"euro dollar\""), source: "Google News", google: true },
  { url: GOOGLE_NEWS("GBPUSD OR \"pound sterling dollar\""), source: "Google News", google: true },
  { url: GOOGLE_NEWS("NASDAQ stocks"), source: "Google News", google: true },
  { url: GOOGLE_NEWS("\"federal reserve\" OR \"us dollar\" rates"), source: "Google News", google: true },
  { url: GOOGLE_NEWS("bitcoin OR crypto market"), source: "Google News", google: true },
];

/** Keyword → symbol tagging. A story can carry several symbols. */
const TAG_RULES: { symbol: string; keywords: RegExp }[] = [
  { symbol: "XAUUSD", keywords: /\b(gold|xau|bullion|silver|xag)\b/i },
  { symbol: "EURUSD", keywords: /\b(eurusd|eur\/usd|euro|ecb|european central bank)\b/i },
  { symbol: "GBPUSD", keywords: /\b(gbpusd|gbp\/usd|pound|sterling|boe|bank of england)\b/i },
  { symbol: "NASDAQ", keywords: /\b(nasdaq|nas100|us100|tech stocks|big tech|magnificent seven)\b/i },
  { symbol: "USD", keywords: /\b(usd|dollar|greenback|fed|fomc|powell|federal reserve|treasury yields?|us indices)\b/i },
  { symbol: "BTC", keywords: /\b(btc|bitcoin|crypto|ethereum|stablecoin|altcoin|blockchain)\b/i },
];

interface NewsItem {
  title: string;
  titleEn?: string; // original English title when lang != en
  link: string;
  source: string;
  publishedAt: number;
  summary: string;
  symbols: string[];
}

interface CalEvent {
  id: string;
  title: string;
  titleEn?: string;
  currency: string;
  date: number; // epoch ms
  impact: string;
  forecast: string;
  previous: string;
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

function parseFeed(xml: string, feed: { source: string; google: boolean }): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf("</item>");
    const body = end >= 0 ? block.slice(0, end) : block;
    let title = cleanText(pick(body, "title"), 220);
    let source = feed.source;
    if (feed.google) {
      // "Headline - Publisher" → keep headline, use the <source> tag (falls
      // back to the trailing segment) as the publisher name.
      const srcTag = decodeEntities(pick(body, "source").replace(/<[^>]*>/g, "").trim());
      const idx = title.lastIndexOf(" - ");
      if (idx > 0) {
        const tail = title.slice(idx + 3);
        title = title.slice(0, idx);
        if (!srcTag) source = tail;
      }
      if (srcTag) source = srcTag;
    }
    const link = cleanText(pick(body, "link"), 500);
    if (!title || !link) continue;
    const pubRaw = pick(body, "pubDate") || pick(body, "published") || pick(body, "updated");
    const publishedAt = pubRaw ? new Date(pubRaw.trim()).getTime() || Date.now() : Date.now();
    // Google News descriptions are just boilerplate link HTML — skip them.
    const summary = feed.google ? "" : cleanText(pick(body, "description"), 220);
    const haystack = `${title} ${summary}`;
    const symbols = TAG_RULES.filter((rule) => rule.keywords.test(haystack)).map((r) => r.symbol);
    items.push({ title, link, source, publishedAt, summary, symbols });
  }
  return items;
}

// ---- in-memory caches -------------------------------------------------------

const FEED_TTL = 5 * 60 * 1000;
const feedCache = new Map<string, { at: number; items: NewsItem[] }>();

async function fetchFeed(url: string, feed: { source: string; google: boolean }): Promise<NewsItem[]> {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < FEED_TTL) return hit.items;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml, feed);
    feedCache.set(url, { at: Date.now(), items });
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ---- translation (public Google translate endpoint, batched + cached) ------

const TRANSLATE_LANGS = new Set(["ru", "uz", "ar"]);
const TRANS_CACHE_TTL = 6 * 60 * 60 * 1000;
const transCache = new Map<string, { at: number; text: string }>();

async function translateBatch(texts: string[], lang: string): Promise<string[]> {
  const url =
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${lang}` +
    texts.map((t) => `&q=${encodeURIComponent(t)}`).join("");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    // dict-chrome-ex answers with one string per q, in order.
    if (Array.isArray(data) && data.length === texts.length && data.every((x) => typeof x === "string")) {
      return data as string[];
    }
    throw new Error("unexpected shape");
  } finally {
    clearTimeout(timer);
  }
}

/** Simple concurrency limiter — keeps us polite to the translate endpoint. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Translate a list of texts; returns originals on any failure. */
async function translateTexts(texts: string[], lang: string): Promise<string[]> {
  if (lang === "en" || !TRANSLATE_LANGS.has(lang) || texts.length === 0) return texts;

  const now = Date.now();
  const results = new Array<string>(texts.length);
  const pending: { idx: number; text: string }[] = [];
  texts.forEach((text, idx) => {
    const hit = transCache.get(`${lang}:${text}`);
    if (hit && now - hit.at < TRANS_CACHE_TTL) results[idx] = hit.text;
    else pending.push({ idx, text });
  });
  if (pending.length === 0) return results;

  // Batch: titles are short (8/batch), summaries longer (4/batch).
  const batchSize = Math.max(...pending.map((p) => p.text.length)) > 140 ? 4 : 8;
  const batches: { idx: number; text: string }[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));

  await mapLimit(batches, 4, async (batch) => {
    try {
      const out = await translateBatch(batch.map((b) => b.text), lang);
      batch.forEach((b, i) => {
        results[b.idx] = out[i];
        if (transCache.size > 5000) transCache.clear();
        transCache.set(`${lang}:${b.text}`, { at: Date.now(), text: out[i] });
      });
    } catch {
      batch.forEach((b) => (results[b.idx] = b.text)); // English fallback
    }
  });
  return results;
}

// ---- economic calendar (ForexFactory weekly JSON, high impact only) --------

const CAL_TTL = 30 * 60 * 1000;
let calCache: { at: number; events: CalEvent[]; ok: boolean } | null = null;

async function fetchCalendar(): Promise<{ events: CalEvent[]; ok: boolean }> {
  if (calCache && Date.now() - calCache.at < CAL_TTL) {
    return { events: calCache.events, ok: calCache.ok };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.forexfactory.com/calendar",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: any[] = await res.json();
    const weekStart = Date.now() - 2 * 24 * 60 * 60 * 1000; // keep a little history
    const events: CalEvent[] = raw
      .map((e) => {
        const impact = String(e.impact ?? e.Importance ?? "").toLowerCase();
        const currency = String(e.country ?? e.currency ?? "").toUpperCase().slice(0, 5);
        const date = new Date(e.date ?? "").getTime() || 0;
        const title = String(e.title ?? e.Title ?? "").trim();
        if (!title || !date || !currency) return null;
        return {
          id: `${currency}-${date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30)}`,
          title,
          currency,
          date,
          impact: impact.charAt(0).toUpperCase() + impact.slice(1),
          forecast: String(e.forecast ?? "").slice(0, 24),
          previous: String(e.previous ?? "").slice(0, 24),
        } as CalEvent;
      })
      .filter((e): e is CalEvent => !!e && e.impact === "High" && e.date >= weekStart)
      .sort((a, b) => a.date - b.date)
      .slice(0, 60);
    calCache = { at: Date.now(), events, ok: true };
    return { events, ok: true };
  } catch {
    // Rate-limited / unreachable — degrade quietly, client keeps working.
    calCache = { at: Date.now(), events: [], ok: false };
    return { events: [], ok: false };
  }
}

// ---- full article reader (?article=<url>) -----------------------------------
// Server-side extraction: no CORS problems, cached 30 min. Used by the
// in-site news reader so users read the WHOLE story without leaving.

const ART_TTL = 30 * 60 * 1000;
const artCache = new Map<string, { at: number; data: ArticleData }>();

interface ArticleData {
  ok: boolean;
  title?: string;
  paragraphs: string[];
  link: string;
  error?: string;
}

/** Google News wraps real publisher URLs — pull the target out of the page. */
function resolveGoogleNews(html: string): string | null {
  const m =
    html.match(/data-n-au="(https?:\/\/[^"]+)"/i) ||
    html.match(/href="(https?:\/\/(?!news\.google|www\.google|accounts|policies|support)[^"]{25,})"/i);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

/** Extract <title> + <p> paragraphs (with a JSON-LD fallback) from HTML. */
function htmlToArticle(raw: string): { title?: string; paragraphs: string[] } | null {
  const tMatch =
    raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i) ||
    raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tMatch ? decodeEntities(tMatch[1]).replace(/\s+/g, " ").trim().slice(0, 220) : undefined;

  let body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header|aside|form|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const out: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) && out.length < 200) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text.length < 60) continue; // skip captions / share prompts
    if (out.length && out[out.length - 1] === text) continue;
    out.push(text);
  }
  // JS-heavy pages: fall back to JSON-LD articleBody
  if (out.length < 3) {
    const ld = raw.match(/"articleBody"\s*:\s*"([\s\S]*?)"\s*[,}]/i);
    if (ld) {
      const text = decodeEntities(
        ld[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      ).replace(/\s+/g, " ").trim();
      if (text.length > 120) out.push(text.slice(0, 20_000));
    }
  }
  return out.length ? { title, paragraphs: out.slice(0, 120) } : null;
}

/**
 * Second chance via the public Jina reader (r.jina.ai) — their infra fetches
 * pages that block datacenter IPs (Cloudflare 403: investing.com etc.).
 * Returns markdown → cleaned paragraphs.
 */
async function fetchViaJina(target: string): Promise<{ title?: string; paragraphs: string[] } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: { "User-Agent": UA, Accept: "text/plain" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const md = (await res.text()).slice(0, 500_000);
    const t = md.match(/^Title:\s*(.+)$/m)?.[1]?.trim().slice(0, 220);
    const body = md.split(/^Markdown Content:\s*$/m)[1] ?? "";
    const paras = body
      .split(/\n\s*\n/)
      .map((chunk) =>
        chunk
          .split("\n")
          .map((l) =>
            l
              .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
              .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
              .replace(/^[#>\-*\s]+/, "")
              .trim()
          )
          .filter(Boolean)
          .join(" ")
      )
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 60);
    if (!paras.length) return null;
    return { title: t, paragraphs: paras.slice(0, 120) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function extractArticle(rawUrl: string): Promise<ArticleData> {
  let target = "";
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    target = u.toString();
  } catch {
    return { ok: false, paragraphs: [], link: rawUrl, error: "BAD_URL" };
  }
  const hit = artCache.get(target);
  if (hit && Date.now() - hit.at < ART_TTL) return hit.data;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let parsed: { title?: string; paragraphs: string[] } | null = null;

    // 1) direct fetch (follows Google News interstitials to the real URL)
    try {
      let res = await fetch(target, {
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en,ru;q=0.9" },
        redirect: "follow",
      });
      if (res.ok) {
        let raw = (await res.text()).slice(0, 700_000);
        // Google News interstitial → find the real publisher URL and refetch it
        if (/news\.google\.com/i.test(new URL(target).hostname)) {
          const real = resolveGoogleNews(raw);
          if (real) {
            const res2 = await fetch(real, {
              signal: controller.signal,
              headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
              redirect: "follow",
            });
            if (res2.ok) {
              raw = (await res2.text()).slice(0, 700_000);
              target = real;
            }
          }
        }
        parsed = htmlToArticle(raw);
      }
    } catch { /* fall through to the reader proxy */ }
    clearTimeout(timer);

    // 2) reader proxy — rescues pages that block datacenter IPs
    if (!parsed) parsed = await fetchViaJina(target);

    if (!parsed) return { ok: false, paragraphs: [], link: target, error: "NO_CONTENT" };

    const data: ArticleData = { ok: true, title: parsed.title, paragraphs: parsed.paragraphs, link: target };
    if (artCache.size > 300) artCache.clear();
    artCache.set(target, { at: Date.now(), data });
    return data;
  } catch (e: any) {
    return { ok: false, paragraphs: [], link: target, error: e?.name === "AbortError" ? "TIMEOUT" : "FETCH_FAILED" };
  }
}

// ---- handler ----------------------------------------------------------------

export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED", message: "GET only" });
  }

  const url = new URL(req.url || "/", "http://localhost");
  const lang = (url.searchParams.get("lang") || "en").toLowerCase();

  // single-article reader mode
  const articleParam = url.searchParams.get("article");
  if (articleParam) {
    res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
    return res.status(200).json(await extractArticle(articleParam));
  }

  const [settled, calendar] = await Promise.all([
    Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url, f))),
    fetchCalendar(),
  ]);

  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      // dedupe by normalized title (same story across feeds)
      const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 90);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const items = merged
    .filter((i) => i.publishedAt >= weekAgo)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 250);

  // Translate titles + summaries in one pass (English fallback per batch).
  let outItems = items;
  if (TRANSLATE_LANGS.has(lang)) {
    const titles = await translateTexts(items.map((i) => i.title), lang);
    const summaries = await translateTexts(items.map((i) => i.summary), lang);
    outItems = items.map((item, i) => ({
      ...item,
      title: titles[i],
      summary: summaries[i],
      titleEn: item.title,
    }));
  }

  // Calendar titles too, so alerts/toasts speak the user's language.
  let outCalendar = calendar.events;
  if (calendar.ok && TRANSLATE_LANGS.has(lang) && outCalendar.length > 0) {
    const calTitles = await translateTexts(outCalendar.map((e) => e.title), lang);
    outCalendar = outCalendar.map((e, i) => ({ ...e, title: calTitles[i], titleEn: e.title }));
  }

  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
  res.status(200).json({
    ok: true,
    updatedAt: Date.now(),
    lang,
    count: outItems.length,
    items: outItems,
    calendar: outCalendar,
    calendarOk: calendar.ok,
  });
}
