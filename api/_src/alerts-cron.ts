/**
 * GET /api/alerts-cron — system cron endpoint (Vercel Cron).
 *
 * Server-side alert evaluation for kinds that need only prices and daily
 * bars: "price" (above/below) and "dailyHL" (previous-day high/low breakout).
 * Indicator alerts (RSI/MACD/EMA/BB) and drawing-based alerts are evaluated
 * client-side on the 30s loop — they need full OHLC history / user drawings.
 *
 * Reliability: runs with NO user session; every active alert of every user is
 * checked on each invocation with a per-alert cooldown (default 60 min) so a
 * single event never notifies twice. Trigger state (lastTriggeredAt + history
 * ring, max 20) is written back to the same RTDB node the client reads, so
 * client and server evaluations de-duplicate against each other.
 *
 * Protection: when CRON_SECRET is set, requests must carry
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron does this natively).
 */
import { rtdb, handle } from "./lib/firebase";
import { INSTRUMENTS, getInstrument } from "../../shared/terminal";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

interface Job { uid: string; id: string; a: any }

export default handle(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== secret) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  const snap = await rtdb().ref("terminalAlerts").once("value");
  const all = snap.val() || {}; // { uid: { alertId: alert } }

  const jobs: Job[] = [];
  const cryptoNeeded = new Set<string>();
  const yahooNeeded = new Set<string>();
  const yahooDailyNeeded = new Set<string>();

  for (const [uid, alerts] of Object.entries<any>(all)) {
    for (const [id, a] of Object.entries<any>(alerts || {})) {
      if (!a || a.paused) continue;
      const kind = a.kind ?? "price";
      if (kind !== "price" && kind !== "dailyHL") continue;
      if (kind === "price" && a.price == null) continue;
      const last = a.lastTriggeredAt || a.triggeredAt || 0;
      if (Date.now() - last < (a.cooldownMin ?? 60) * 60000) continue;
      jobs.push({ uid, id, a });
      const inst = getInstrument(a.symbol);
      if (!inst) continue;
      if (inst.feed === "binance" && inst.binance) {
        cryptoNeeded.add(inst.binance);
        if (kind === "dailyHL") cryptoNeeded.add(inst.binance); // 1d kline below
      } else if (inst.yahoo) {
        yahooNeeded.add(inst.yahoo);
        if (kind === "dailyHL") yahooDailyNeeded.add(inst.yahoo);
      }
    }
  }

  if (!jobs.length) return res.status(200).json({ ok: true, evaluated: 0, fired: 0 });

  const prices = new Map<string, number>();       // by instrument symbol
  const prevDay = new Map<string, { high: number; low: number }>();

  // crypto spot prices + previous day H/L (1d klines, real data)
  if (cryptoNeeded.size) {
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify([...cryptoNeeded]))}`;
      const arr: any[] = await (await fetch(url)).json();
      for (const row of arr) {
        const inst = INSTRUMENTS.find((i) => i.binance === row.symbol);
        if (inst) prices.set(inst.symbol, +row.price);
      }
    } catch { /* crypto prices unavailable this run */ }
  }
  for (const bin of new Set([...cryptoNeeded])) {
    try {
      const inst = INSTRUMENTS.find((i) => i.binance === bin);
      if (!inst || ![...jobs].some((j) => j.a.symbol === inst.symbol && (j.a.kind ?? "price") === "dailyHL")) continue;
      const kl: any[] = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${bin}&interval=1d&limit=3`)).json();
      const prev = kl.length >= 2 ? kl[kl.length - 2] : null;
      if (prev) prevDay.set(inst.symbol, { high: +prev[2], low: +prev[3] });
    } catch { /* daily bars unavailable */ }
  }

  // yahoo quotes (batch, same pattern as the /api/quotes proxy) + daily H/L
  if (yahooNeeded.size) {
    await Promise.allSettled([...yahooNeeded].map(async (sym) => {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) return;
      const data: any = await r.json();
      const result = data?.chart?.result?.[0];
      const meta = result?.meta || {};
      const inst = INSTRUMENTS.find((i) => i.yahoo === sym);
      if (inst && meta.regularMarketPrice != null) prices.set(inst.symbol, meta.regularMarketPrice);
      const ts: number[] = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0] || {};
      if (inst && ts.length >= 2) {
        // second-to-last COMPLETED daily bar = previous day
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
    const kind: string = job.a.kind ?? "price";
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
    const history = [...(Array.isArray(job.a.history) ? job.a.history : []), { at: now, price }].slice(-20);
    await rtdb().ref(`terminalAlerts/${job.uid}/${job.id}`).update({ lastTriggeredAt: now, history });
  }

  return res.status(200).json({ ok: true, evaluated: jobs.length, fired });
});
