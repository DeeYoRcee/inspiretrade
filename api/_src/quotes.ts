/**
 * GET /api/quotes?symbol=EURUSD=X&range=5d&interval=1m
 *
 * Server-side proxy for the public Yahoo Finance chart API. Why a proxy:
 * Yahoo blocks browser CORS, so the client cannot call it directly, and
 * provider credentials (TwelveData / AlphaVantage) are not configured in this
 * deployment. Yahoo returns real (sometimes delayed) OHLCV data — the client
 * labels it as "delayed/real" accordingly and falls back to labeled DEMO data
 * when this endpoint fails.
 *
 * Responses are cached at the edge (s-maxage) to keep Yahoo request volume low
 * and stay inside Vercel Hobby function limits.
 */
import { handle, requireUser } from "./lib/firebase";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default handle(async (req, res) => {
  await requireUser(req);

  const url = new URL(req.url || "/", "http://localhost");
  const batch = (url.searchParams.get("symbols") || "").trim();
  const symbols = (url.searchParams.get("symbol") || "").trim();
  const range = (url.searchParams.get("range") || "5d").trim();
  const interval = (url.searchParams.get("interval") || "1m").trim();

  // ---- Batch quote mode: GET /api/quotes?symbols=EURUSD=X,GC=F ----------
  // Light last-price snapshot for the Market Watch panel.
  if (batch) {
    const list = batch.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9^.=\-]{1,20}$/i.test(s)).slice(0, 20);
    const quotes = await Promise.all(
      list.map(async (sym) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const yres = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
            { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal },
          );
          clearTimeout(timer);
          if (!yres.ok) throw new Error(String(yres.status));
          const data: any = await yres.json();
          const meta = data?.chart?.result?.[0]?.meta || {};
          return { symbol: meta.symbol || sym, price: meta.regularMarketPrice ?? null, previousClose: meta.chartPreviousClose ?? null };
        } catch {
          return { symbol: sym, price: null, previousClose: null };
        }
      }),
    );
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ ok: true, quotes });
  }

  if (!/^[A-Z0-9^.=\-]{1,20}$/i.test(symbols)) {
    return res.status(400).json({ ok: false, error: "BAD_SYMBOL" });
  }

  const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const yres = await fetch(yurl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!yres.ok) throw new Error(`yahoo ${yres.status}`);
    const data: any = await yres.json();

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("EMPTY_RESULT");
    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue;
      bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: v ?? 0 });
    }
    const meta = result.meta || {};

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({
      ok: true,
      source: "yahoo",
      delayed: true,
      symbol: meta.symbol || symbols,
      currency: meta.currency || null,
      regularMarketPrice: meta.regularMarketPrice ?? null,
      previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      bars,
    });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: "FEED_UNAVAILABLE", detail: String(e?.message || e) });
  }
});
