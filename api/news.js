// api/_src/news/index.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var GOOGLE_NEWS = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=en-US&gl=US&ceid=US:en`;
var FEEDS = [
  { url: "https://www.investing.com/rss/news_1.rss", source: "Investing", google: false },
  // forex
  { url: "https://www.investing.com/rss/news_11.rss", source: "Investing", google: false },
  // commodities / gold
  { url: "https://www.investing.com/rss/news_14.rss", source: "Investing", google: false },
  // economy
  { url: "https://www.investing.com/rss/news_25.rss", source: "Investing", google: false },
  // stocks / indices
  { url: "https://www.investing.com/rss/news_285.rss", source: "Investing", google: false },
  // most popular
  { url: "https://www.forexlive.com/feed/news", source: "ForexLive", google: false },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph", google: false },
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC", google: false },
  // economy
  // Per-symbol Google News searches — give the 7-day history the direct
  // feeds can't. Source is taken from the <source> tag inside each item.
  { url: GOOGLE_NEWS("gold price OR XAUUSD"), source: "Google News", google: true },
  { url: GOOGLE_NEWS('EURUSD OR "euro dollar"'), source: "Google News", google: true },
  { url: GOOGLE_NEWS('GBPUSD OR "pound sterling dollar"'), source: "Google News", google: true },
  { url: GOOGLE_NEWS("NASDAQ stocks"), source: "Google News", google: true },
  { url: GOOGLE_NEWS('"federal reserve" OR "us dollar" rates'), source: "Google News", google: true },
  { url: GOOGLE_NEWS("bitcoin OR crypto market"), source: "Google News", google: true }
];
var TAG_RULES = [
  { symbol: "XAUUSD", keywords: /\b(gold|xau|bullion|silver|xag)\b/i },
  { symbol: "EURUSD", keywords: /\b(eurusd|eur\/usd|euro|ecb|european central bank)\b/i },
  { symbol: "GBPUSD", keywords: /\b(gbpusd|gbp\/usd|pound|sterling|boe|bank of england)\b/i },
  { symbol: "NASDAQ", keywords: /\b(nasdaq|nas100|us100|tech stocks|big tech|magnificent seven)\b/i },
  { symbol: "USD", keywords: /\b(usd|dollar|greenback|fed|fomc|powell|federal reserve|treasury yields?|us indices)\b/i },
  { symbol: "BTC", keywords: /\b(btc|bitcoin|crypto|ethereum|stablecoin|altcoin|blockchain)\b/i }
];
function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, d) => {
    try {
      return String.fromCodePoint(Number(d));
    } catch {
      return " ";
    }
  }).replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return " ";
    }
  }).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function cleanText(raw, maxLen) {
  const text = decodeEntities(
    String(raw || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, " ")
  ).replace(/\s+/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}\u2026` : text;
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : "";
}
function parseFeed(xml, feed) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf("</item>");
    const body = end >= 0 ? block.slice(0, end) : block;
    let title = cleanText(pick(body, "title"), 220);
    let source = feed.source;
    if (feed.google) {
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
    const summary = feed.google ? "" : cleanText(pick(body, "description"), 220);
    const haystack = `${title} ${summary}`;
    const symbols = TAG_RULES.filter((rule) => rule.keywords.test(haystack)).map((r) => r.symbol);
    items.push({ title, link, source, publishedAt, summary, symbols });
  }
  return items;
}
var FEED_TTL = 5 * 60 * 1e3;
var feedCache = /* @__PURE__ */ new Map();
async function fetchFeed(url, feed) {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < FEED_TTL) return hit.items;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: controller.signal
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
var TRANSLATE_LANGS = /* @__PURE__ */ new Set(["ru", "uz", "ar"]);
var TRANS_CACHE_TTL = 6 * 60 * 60 * 1e3;
var transCache = /* @__PURE__ */ new Map();
async function translateBatch(texts, lang) {
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${lang}` + texts.map((t) => `&q=${encodeURIComponent(t)}`).join("");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length === texts.length && data.every((x) => typeof x === "string")) {
      return data;
    }
    throw new Error("unexpected shape");
  } finally {
    clearTimeout(timer);
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
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
async function translateTexts(texts, lang) {
  if (lang === "en" || !TRANSLATE_LANGS.has(lang) || texts.length === 0) return texts;
  const now = Date.now();
  const results = new Array(texts.length);
  const pending = [];
  texts.forEach((text, idx) => {
    const hit = transCache.get(`${lang}:${text}`);
    if (hit && now - hit.at < TRANS_CACHE_TTL) results[idx] = hit.text;
    else pending.push({ idx, text });
  });
  if (pending.length === 0) return results;
  const batchSize = Math.max(...pending.map((p) => p.text.length)) > 140 ? 4 : 8;
  const batches = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
  await mapLimit(batches, 4, async (batch) => {
    try {
      const out = await translateBatch(batch.map((b) => b.text), lang);
      batch.forEach((b, i) => {
        results[b.idx] = out[i];
        if (transCache.size > 5e3) transCache.clear();
        transCache.set(`${lang}:${b.text}`, { at: Date.now(), text: out[i] });
      });
    } catch {
      batch.forEach((b) => results[b.idx] = b.text);
    }
  });
  return results;
}
var CAL_TTL = 30 * 60 * 1e3;
var calCache = null;
async function fetchCalendar() {
  if (calCache && Date.now() - calCache.at < CAL_TTL) {
    return { events: calCache.events, ok: calCache.ok };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.forexfactory.com/calendar"
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const weekStart = Date.now() - 2 * 24 * 60 * 60 * 1e3;
    const events = raw.map((e) => {
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
        previous: String(e.previous ?? "").slice(0, 24)
      };
    }).filter((e) => !!e && e.impact === "High" && e.date >= weekStart).sort((a, b) => a.date - b.date).slice(0, 60);
    calCache = { at: Date.now(), events, ok: true };
    return { events, ok: true };
  } catch {
    calCache = { at: Date.now(), events: [], ok: false };
    return { events: [], ok: false };
  }
}
async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED", message: "GET only" });
  }
  const url = new URL(req.url || "/", "http://localhost");
  const lang = (url.searchParams.get("lang") || "en").toLowerCase();
  const [settled, calendar] = await Promise.all([
    Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url, f))),
    fetchCalendar()
  ]);
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 90);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
  const items = merged.filter((i) => i.publishedAt >= weekAgo).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 250);
  let outItems = items;
  if (TRANSLATE_LANGS.has(lang)) {
    const titles = await translateTexts(items.map((i) => i.title), lang);
    const summaries = await translateTexts(items.map((i) => i.summary), lang);
    outItems = items.map((item, i) => ({
      ...item,
      title: titles[i],
      summary: summaries[i],
      titleEn: item.title
    }));
  }
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
    calendarOk: calendar.ok
  });
}
export {
  handler as default
};
