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
async function requireUser(req) {
  const header = req.headers?.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) throw new HttpError(401, "MISSING_TOKEN", "Missing Authorization bearer token");
  ensureApp();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired token");
  }
  if (!decoded?.uid) throw new HttpError(401, "INVALID_TOKEN", "Invalid token payload");
  return { uid: decoded.uid, email: decoded.email, name: decoded.name };
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

// api/_src/quotes.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var STOOQ_MAP = {
  "GC=F": "xauusd",
  "SI=F": "xagusd",
  "EURUSD=X": "eurusd",
  "GBPUSD=X": "gbpusd",
  "USDJPY=X": "usdjpy",
  "AUDUSD=X": "audusd",
  "NZDUSD=X": "nzdusd",
  "USDCAD=X": "usdcad",
  "USDCHF=X": "usdchf",
  "^NDX": "^ndq",
  "^DJI": "^dji",
  "^GSPC": "^spx",
  "^GDAXI": "^dax",
  "^FTSE": "^ukx"
};
var stooqOf = (sym) => STOOQ_MAP[sym] ?? (sym.endsWith("=X") ? sym.slice(0, -2).toLowerCase() : null);
function csvToQuotes(csv) {
  const out = {};
  const lines = csv.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 7) continue;
    const close = Number(cols[6]);
    const open = Number(cols[3]);
    out[cols[0].toLowerCase()] = {
      price: Number.isFinite(close) && close > 0 ? close : null,
      previousClose: Number.isFinite(open) && open > 0 ? open : null
    };
  }
  return out;
}
function stooqCsvToBars(csv) {
  const bars = [];
  const lines = csv.trim().split(/\r?\n/);
  const CET = 60 * 60 * 1e3;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const [d, t, o, h, l, c, v] = cols;
    const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
    if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0)) continue;
    let time;
    if (t && /^\d{2}:\d{2}$/.test(t)) {
      time = Math.floor((Date.parse(`${d}T${t}:00Z`) - CET) / 1e3);
    } else {
      time = Math.floor(Date.parse(`${d}T00:00:00Z`) / 1e3);
    }
    bars.push({ time, open, high, low, close, volume: Number(v) || 0 });
  }
  return bars;
}
var STOOQ_INTERVAL = { "1m": "5", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "d" };
var quotes_default = handle(async (req, res) => {
  await requireUser(req);
  const url = new URL(req.url || "/", "http://localhost");
  const batch = (url.searchParams.get("symbols") || "").trim();
  const symbols = (url.searchParams.get("symbol") || "").trim();
  const range = (url.searchParams.get("range") || "5d").trim();
  const interval = (url.searchParams.get("interval") || "1m").trim();
  if (batch) {
    const list = batch.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9^.=\-]{1,20}$/i.test(s)).slice(0, 20);
    const quotes = await Promise.all(
      list.map(async (sym) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6e3);
          const yres = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
            { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal }
          );
          clearTimeout(timer);
          if (!yres.ok) throw new Error(String(yres.status));
          const data = await yres.json();
          const meta = data?.chart?.result?.[0]?.meta || {};
          return { symbol: meta.symbol || sym, price: meta.regularMarketPrice ?? null, previousClose: meta.chartPreviousClose ?? null };
        } catch {
          return { symbol: sym, price: null, previousClose: null };
        }
      })
    );
    const failed = quotes.filter((q) => q.price == null);
    if (failed.length > 0) {
      const stooqSyms = failed.map((q) => stooqOf(q.symbol)).filter(Boolean);
      if (stooqSyms.length > 0) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6e3);
          const sres = await fetch(`https://stooq.com/q/l/?s=${stooqSyms.join("+")}&f=sd2t2ohlcv&h&e=csv`, {
            headers: { "User-Agent": UA },
            signal: controller.signal
          });
          clearTimeout(timer);
          if (sres.ok) {
            const bySym = csvToQuotes(await sres.text());
            for (const q of failed) {
              const sq = bySym[stooqOf(q.symbol)?.toLowerCase() || ""];
              if (sq?.price != null) {
                q.price = sq.price;
                q.previousClose = sq.previousClose;
              }
            }
          }
        } catch {
        }
      }
    }
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ ok: true, quotes });
  }
  if (!/^[A-Z0-9^.=\-]{1,20}$/i.test(symbols)) {
    return res.status(400).json({ ok: false, error: "BAD_SYMBOL" });
  }
  const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
  const fromYahoo = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    const yres = await fetch(yurl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!yres.ok) throw new Error(`yahoo ${yres.status}`);
    const data = await yres.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("EMPTY_RESULT");
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue;
      bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    const meta = result.meta || {};
    return {
      source: "yahoo",
      delayed: true,
      symbol: meta.symbol || symbols,
      currency: meta.currency || null,
      regularMarketPrice: meta.regularMarketPrice ?? null,
      previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      bars
    };
  };
  const fromStooq = async () => {
    const sq = stooqOf(symbols);
    if (!sq) throw new Error("NO_STOOQ_MAP");
    const si = STOOQ_INTERVAL[interval];
    if (!si) throw new Error("NO_STOOQ_INTERVAL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8e3);
    const sres = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sq)}&i=${si}`, {
      headers: { "User-Agent": UA },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!sres.ok) throw new Error(`stooq ${sres.status}`);
    const bars = stooqCsvToBars(await sres.text());
    if (bars.length === 0) throw new Error("STOOQ_EMPTY");
    const perDay = si === "d" ? 1 : Math.round(1440 / Number(si));
    const days = range.endsWith("d") ? Number(range.slice(0, -1)) || 5 : range.endsWith("mo") ? Number(range.slice(0, -2)) * 30 || 150 : 5;
    const capped = bars.slice(Math.max(0, bars.length - days * perDay));
    const last = capped[capped.length - 1];
    return {
      source: "stooq",
      delayed: true,
      symbol: symbols,
      currency: null,
      regularMarketPrice: last?.close ?? null,
      previousClose: capped.length > 1 ? capped[capped.length - 2].close : null,
      bars: capped
    };
  };
  try {
    const payload = await fromYahoo();
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ ok: true, ...payload });
  } catch (e) {
    try {
      const payload = await fromStooq();
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
      return res.status(200).json({ ok: true, ...payload });
    } catch (e2) {
      return res.status(200).json({ ok: false, error: "FEED_UNAVAILABLE", detail: `yahoo: ${String(e?.message || e)}; stooq: ${String(e2?.message || e2)}` });
    }
  }
});
export {
  quotes_default as default
};
