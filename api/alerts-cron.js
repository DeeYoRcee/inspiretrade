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

// api/_src/alerts-cron.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
var alerts_cron_default = handle(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== secret) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
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
  if (!jobs.length) return res.status(200).json({ ok: true, evaluated: 0, fired: 0 });
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
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { "User-Agent": UA, Accept: "application/json" } });
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
  }
  return res.status(200).json({ ok: true, evaluated: jobs.length, fired });
});
export {
  alerts_cron_default as default
};
