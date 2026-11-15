// api/_src/alerts-cron.ts
import { createRequire } from "module";

// api/_src/lib/firebase.ts
import * as adminNamespace from "firebase-admin";
var admin = adminNamespace.default ?? adminNamespace;
var HttpError = class extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
};
var app = null;
function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: String(parsed.private_key).replace(/\\n/g, "\n")
        };
      }
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON");
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    };
  }
  return null;
}
function ensureApp() {
  if (app) return app;
  const account = getServiceAccount();
  if (!account) {
    throw new HttpError(
      500,
      "SERVER_NOT_CONFIGURED",
      "Missing FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) environment variables on the server."
    );
  }
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKey: account.privateKey
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${account.projectId}-default-rtdb.firebaseio.com`
  });
  return app;
}
function rtdb() {
  ensureApp();
  return admin.database();
}
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        console.error("[api] unexpected error:", err);
        res.status(500).json({ error: "INTERNAL", message: "Unexpected server error" });
      }
    }
  };
}

// shared/terminal.ts
var INSTRUMENTS = [
  // ---- Metals -------------------------------------------------------------
  { symbol: "XAUUSD", name: "Gold / USD", assetClass: "metal", digits: 2, pipSize: 0.1, contractSize: 100, quote: "USD", feed: "quotes", yahoo: "GC=F" },
  { symbol: "XAGUSD", name: "Silver / USD", assetClass: "metal", digits: 3, pipSize: 0.01, contractSize: 5e3, quote: "USD", feed: "quotes", yahoo: "SI=F" },
  // ---- Forex majors -------------------------------------------------------
  { symbol: "EURUSD", name: "Euro / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "EURUSD=X" },
  { symbol: "GBPUSD", name: "British Pound / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "GBPUSD=X" },
  { symbol: "USDJPY", name: "US Dollar / Japanese Yen", assetClass: "forex", digits: 3, pipSize: 0.01, contractSize: 1e5, quote: "JPY", feed: "quotes", yahoo: "USDJPY=X" },
  { symbol: "AUDUSD", name: "Australian Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "AUDUSD=X" },
  { symbol: "NZDUSD", name: "New Zealand Dollar / USD", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "USD", feed: "quotes", yahoo: "NZDUSD=X" },
  { symbol: "USDCAD", name: "US Dollar / Canadian Dollar", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CAD", feed: "quotes", yahoo: "USDCAD=X" },
  { symbol: "USDCHF", name: "US Dollar / Swiss Franc", assetClass: "forex", digits: 5, pipSize: 1e-4, contractSize: 1e5, quote: "CHF", feed: "quotes", yahoo: "USDCHF=X" },
  // ---- Crypto (live via Binance public API, no key) -----------------------
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "BTCUSDT" },
  { symbol: "ETHUSD", name: "Ethereum / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "ETHUSDT" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", digits: 2, pipSize: 0.01, contractSize: 1, quote: "USD", feed: "binance", binance: "SOLUSDT" },
  { symbol: "XRPUSD", name: "XRP / USD", assetClass: "crypto", digits: 4, pipSize: 1e-4, contractSize: 1, quote: "USD", feed: "binance", binance: "XRPUSDT" },
  // ---- Indices (CFD reference levels, quotes proxy) -----------------------
  { symbol: "NAS100", name: "US Tech 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^NDX" },
  { symbol: "US30", name: "Wall Street 30", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^DJI" },
  { symbol: "SPX500", name: "US 500", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "USD", feed: "quotes", yahoo: "^GSPC" },
  { symbol: "GER40", name: "Germany 40", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "EUR", feed: "quotes", yahoo: "^GDAXI" },
  { symbol: "UK100", name: "UK 100", assetClass: "index", digits: 1, pipSize: 1, contractSize: 1, quote: "GBP", feed: "quotes", yahoo: "^FTSE" }
];
function getInstrument(symbol) {
  return INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}

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
  // Yahoo Finance ticker feeds — longer summaries + server-fetchable links
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC%3DF&region=US&lang=en-US", source: "Yahoo Finance", google: false },
  // gold
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=SI%3DF&region=US&lang=en-US", source: "Yahoo Finance", google: false },
  // silver / gold complex
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=EURUSD%3DX&region=US&lang=en-US", source: "Yahoo Finance", google: false },
  // euro/dollar
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=GBPUSD%3DX&region=US&lang=en-US", source: "Yahoo Finance", google: false },
  // pound/dollar
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US", source: "Yahoo Finance", google: false },
  // bitcoin
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENDX&region=US&lang=en-US", source: "Yahoo Finance", google: false },
  // Nasdaq 100
  // Per-symbol Google News searches — give the 7-day history the direct
  // feeds can't. Source is taken from the <source> tag inside each item.
  { url: GOOGLE_NEWS("gold price OR XAUUSD"), source: "Google News", google: true },
  { url: GOOGLE_NEWS("gold bullion market"), source: "Google News", google: true },
  { url: GOOGLE_NEWS('EURUSD OR "euro dollar"'), source: "Google News", google: true },
  { url: GOOGLE_NEWS("ECB interest rate eurozone"), source: "Google News", google: true },
  { url: GOOGLE_NEWS('GBPUSD OR "pound sterling dollar"'), source: "Google News", google: true },
  { url: GOOGLE_NEWS("Bank of England rate pound sterling"), source: "Google News", google: true },
  { url: GOOGLE_NEWS("NASDAQ stocks"), source: "Google News", google: true },
  { url: GOOGLE_NEWS('"nasdaq 100" OR "wall street" tech stocks'), source: "Google News", google: true },
  { url: GOOGLE_NEWS('"federal reserve" OR "us dollar" rates'), source: "Google News", google: true },
  { url: GOOGLE_NEWS("dollar index OR nonfarm payrolls OR cpi inflation"), source: "Google News", google: true },
  { url: GOOGLE_NEWS("bitcoin OR crypto market"), source: "Google News", google: true }
];
var TAG_RULES = [
  { symbol: "XAUUSD", keywords: /\b(gold|xau|bullion|silver|xag|precious metals?|platinum|palladium)\b/i },
  { symbol: "EURUSD", keywords: /\b(eurusd|eur\/usd|euro|ecb|european central bank|eurozone|eur)\b/i },
  { symbol: "GBPUSD", keywords: /\b(gbpusd|gbp\/usd|pound|sterling|boe|bank of england|gbp)\b/i },
  { symbol: "NASDAQ", keywords: /\b(nasdaq|nas100|us100|ndx|qqq|tech stocks|big tech|magnificent seven|wall street|stock market)\b/i },
  {
    symbol: "USD",
    keywords: /\b(usd|dollar|greenback|fed|fomc|powell|federal reserve|treasury yields?|us indices|dxy|dollar index|nonfarm|payrolls|cpi|inflation|interest rates?)\b/i
  },
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
    const contentRaw = pick(body, "content:encoded") || pick(body, "content");
    let fullText;
    if (contentRaw) {
      const paras = contentRaw.split(/<\/(p|h2|h3|li)>/i).filter((_, i) => i % 2 === 0).map((chunk) => decodeEntities(chunk.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter((t) => t.length > 40);
      const joined = paras.join("\n\n");
      if (joined.length > 300) fullText = joined.slice(0, 12e3);
    }
    if (!fullText && !feed.google) {
      const dText = decodeEntities(pick(body, "description").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (dText.length > 300) fullText = dText.slice(0, 12e3);
    }
    const haystack = `${title} ${summary}`;
    const symbols = TAG_RULES.filter((rule) => rule.keywords.test(haystack)).map((r) => r.symbol);
    items.push({ title, link, source, publishedAt, summary, symbols, fullText });
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
var TRANS_CACHE_TTL = 6 * 60 * 60 * 1e3;
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
var ART_TTL = 30 * 60 * 1e3;
async function collectNewsCron() {
  const [settled, calendar] = await Promise.all([
    Promise.allSettled(FEEDS.map((f) => fetchFeed(f.url, f))),
    fetchCalendar().catch(() => ({ events: [], ok: false }))
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
  const items = merged.filter((i) => i.publishedAt >= weekAgo && i.symbols.length > 0).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 300);
  return { items, calendar: calendar.events || [], ok: !!calendar.ok };
}

// api/_src/alerts-cron.ts
var require_ = createRequire(import.meta.url);
var webpush = require_("web-push");
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
var VAPID_SUBJECT = "mailto:support@inspiretrade.app";
function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
async function sendPush(uid, payload) {
  if (!pushConfigured()) return 0;
  const snap = await rtdb().ref(`pushSubs/${uid}`).once("value");
  const subs = snap.val() || {};
  let sent = 0;
  await Promise.allSettled(Object.entries(subs).map(async ([key, row]) => {
    if (!row?.sub?.endpoint) return;
    try {
      await webpush.sendNotification(row.sub, JSON.stringify(payload), { vapidDetails: { subject: VAPID_SUBJECT, publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } });
      sent++;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await rtdb().ref(`pushSubs/${uid}/${key}`).remove().catch(() => {
        });
      }
    }
  }));
  return sent;
}
function asSet(arr) {
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}
var alerts_cron_default = handle(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== secret) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  const pushOn = pushConfigured();
  if (pushOn) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    } catch {
    }
  }
  const snap = await rtdb().ref("terminalAlerts").once("value");
  const all = snap.val() || {};
  const jobs = [];
  const cryptoNeeded = /* @__PURE__ */ new Set();
  const yahooNeeded = /* @__PURE__ */ new Set();
  const yahooDailyNeeded = /* @__PURE__ */ new Set();
  for (const [uid, alerts] of Object.entries(all)) {
    for (const [id, a] of Object.entries(alerts || {})) {
      if (!a || a.paused) continue;
      const kind = a.kind ?? "price";
      if (kind !== "price" && kind !== "dailyHL") continue;
      if (kind === "price" && a.price == null) continue;
      const last = a.lastTriggeredAt || a.triggeredAt || 0;
      if (Date.now() - last < (a.cooldownMin ?? 60) * 6e4) continue;
      jobs.push({ uid, id, a });
      const inst = getInstrument(a.symbol);
      if (!inst) continue;
      if (inst.feed === "binance" && inst.binance) {
        cryptoNeeded.add(inst.binance);
        if (kind === "dailyHL") cryptoNeeded.add(inst.binance);
      } else if (inst.yahoo) {
        yahooNeeded.add(inst.yahoo);
        if (kind === "dailyHL") yahooDailyNeeded.add(inst.yahoo);
      }
    }
  }
  const prices = /* @__PURE__ */ new Map();
  const prevDay = /* @__PURE__ */ new Map();
  if (cryptoNeeded.size) {
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify([...cryptoNeeded]))}`;
      const arr = await (await fetch(url)).json();
      for (const row of arr) {
        const inst = INSTRUMENTS.find((i) => i.binance === row.symbol);
        if (inst) prices.set(inst.symbol, +row.price);
      }
    } catch {
    }
  }
  for (const bin of /* @__PURE__ */ new Set([...cryptoNeeded])) {
    try {
      const inst = INSTRUMENTS.find((i) => i.binance === bin);
      if (!inst || ![...jobs].some((j) => j.a.symbol === inst.symbol && (j.a.kind ?? "price") === "dailyHL")) continue;
      const kl = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${bin}&interval=1d&limit=3`)).json();
      const prev = kl.length >= 2 ? kl[kl.length - 2] : null;
      if (prev) prevDay.set(inst.symbol, { high: +prev[2], low: +prev[3] });
    } catch {
    }
  }
  if (yahooNeeded.size) {
    await Promise.allSettled([...yahooNeeded].map(async (sym) => {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { "User-Agent": UA2, Accept: "application/json" } });
      if (!r.ok) return;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      const meta = result?.meta || {};
      const inst = INSTRUMENTS.find((i) => i.yahoo === sym);
      if (inst && meta.regularMarketPrice != null) prices.set(inst.symbol, meta.regularMarketPrice);
      const ts = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0] || {};
      if (inst && ts.length >= 2) {
        for (let i = ts.length - 2; i >= 0; i--) {
          const h = q.high?.[i], l = q.low?.[i];
          if (h != null && l != null && Number.isFinite(h) && Number.isFinite(l)) {
            prevDay.set(inst.symbol, { high: h, low: l });
            break;
          }
        }
      }
    }));
  }
  let fired = 0;
  let pushed = 0;
  const now = Date.now();
  for (const job of jobs) {
    const kind = job.a.kind ?? "price";
    const price = prices.get(job.a.symbol);
    if (price == null) continue;
    let hit = false;
    if (kind === "price") {
      hit = job.a.direction === "above" ? price >= job.a.price : price <= job.a.price;
    } else if (kind === "dailyHL") {
      const hl = prevDay.get(job.a.symbol);
      if (hl) hit = job.a.direction === "above" ? price >= hl.high : price <= hl.low;
    }
    if (!hit) continue;
    fired++;
    const history = [...Array.isArray(job.a.history) ? job.a.history : [], { at: now, price }].slice(-20);
    await rtdb().ref(`terminalAlerts/${job.uid}/${job.id}`).update({ lastTriggeredAt: now, history });
    if (pushOn) {
      const dir = job.a.direction === "above" ? "crossed above" : "dropped to";
      pushed += await sendPush(job.uid, {
        title: `${job.a.symbol} ${kind === "dailyHL" ? "daily level" : "alert"}`,
        body: `${job.a.symbol} ${dir} ${job.a.price} \u2014 now ${price}`,
        url: "/terminal",
        tag: `alert-${job.uid}-${job.id}`
      });
    }
  }
  let newsPushed = 0;
  let calPushed = 0;
  if (pushOn) {
    try {
      const [{ items, calendar, ok }, subsSnap, settingsSnap, seenSnap] = await Promise.all([
        collectNewsCron(),
        rtdb().ref("pushSubs").once("value"),
        rtdb().ref("pushSettings").once("value"),
        rtdb().ref("pushSeen").once("value")
      ]);
      const subsByUid = subsSnap.val() || {};
      const settingsByUid = settingsSnap.val() || {};
      const seenByUid = seenSnap.val() || {};
      const seenUpdates = {};
      for (const uid of Object.keys(subsByUid)) {
        const s = settingsByUid[uid] || {};
        if (!s.enabled || !Array.isArray(s.symbols) || !s.symbols.length) continue;
        const seen = seenByUid[uid] || {};
        const newsSeen = asSet(seen.news);
        const calSeen = asSet(seen.cal);
        const updates = {};
        const fresh = items.filter(
          (i) => !newsSeen.has(i.link) && now - i.publishedAt < 45 * 60 * 1e3 && i.symbols.some((sym) => s.symbols.includes(sym))
        ).slice(0, 3);
        for (const item of fresh) {
          const syms = item.symbols.filter((sym) => s.symbols.includes(sym)).join(" \xB7 ");
          newsPushed += await sendPush(uid, { title: syms || "News", body: String(item.title || "").slice(0, 180), url: "/news", tag: item.link });
          updates[item.link] = now;
        }
        if (ok && s.calEnabled && Array.isArray(s.calCurrencies) && s.calCurrencies.length) {
          const soon = calendar.filter(
            (e) => e.impact === "High" && s.calCurrencies.includes(e.currency) && !calSeen.has(e.id) && e.date > now && e.date - now <= 30 * 60 * 1e3
          ).slice(0, 2);
          for (const ev of soon) {
            const mins = Math.max(1, Math.round((ev.date - now) / 6e4));
            calPushed += await sendPush(uid, { title: `${ev.currency} \u2014 ${mins} min`, body: String(ev.title || "").slice(0, 180), url: "/news", tag: ev.id });
            updates[ev.id] = now;
          }
        }
        if (Object.keys(updates).length) {
          const mergedNews = [...Object.entries(seen.news || {}).map(([k, v]) => [k, v]), ...Object.entries(updates)].slice(-400);
          const mergedCal = [...Object.entries(seen.cal || {}).map(([k, v]) => [k, v]), ...Object.entries(updates)].slice(-200);
          seenUpdates[`pushSeen/${uid}/news`] = Object.fromEntries(mergedNews);
          seenUpdates[`pushSeen/${uid}/cal`] = Object.fromEntries(mergedCal);
        }
      }
      if (Object.keys(seenUpdates).length) await rtdb().ref().update(seenUpdates);
    } catch {
    }
  }
  return res.status(200).json({ ok: true, evaluated: jobs.length, fired, pushed, newsPushed, calPushed, pushConfigured: pushOn });
});
export {
  alerts_cron_default as default
};
