/**
 * Node tests for the advanced terminal libraries (pure math only — firebase
 * imports are type-only and erased). Synthetic bars here are TEST FIXTURES
 * used solely to verify the engines; the application itself never generates
 * market data.
 */
import { SESSIONS, isInSession, sessionBoundsUTC, sessionStats, prevDayHighLow, nextSessionChange, wallTime } from "@/lib/terminal/sessions";
import { buildVolumeProfile, anchoredVwap, volumeDelta } from "@/lib/terminal/volume-analysis";
import { runBacktest, DEFAULT_BACKTEST, type BacktestConfig } from "@/lib/terminal/backtest";
import { runScreener, newFilter } from "@/lib/terminal/screener";
import { analyzeTimeframe, mtfTable, MTF_TFS } from "@/lib/terminal/mtf";
import { pipValue, positionSize, margin, profitLoss, fibonacci, drawdown, compounding, riskReward } from "@/lib/terminal/calculators";
import type { Bar } from "@shared/terminal";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ FAIL ${name} ${detail}`); }
}

// ---- deterministic synthetic bars (TEST FIXTURE) ---------------------------
function makeBars(n = 800, base = 100): Bar[] {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const bars: Bar[] = [];
  const t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - n * 3600;
  let price = base;
  for (let i = 0; i < n; i++) {
    const cycle = Math.sin(i / 40) * base * 0.02;
    const drift = i > n * 0.5 ? 0.02 * base : 0; // second half trends up
    const open = price;
    const close = base + cycle + drift + (rand() - 0.5) * base * 0.01;
    const high = Math.max(open, close) + rand() * base * 0.005;
    const low = Math.min(open, close) - rand() * base * 0.005;
    bars.push({ time: t0 + i * 3600, open, high, low, close, volume: 1000 + Math.floor(rand() * 500), takerBuy: 500 + Math.floor(rand() * 250) });
    price = close;
  }
  return bars;
}

console.log("— sessions —");
{
  // London 08:00 local: BST (summer) → 07:00 UTC; GMT (winter) → 08:00 UTC
  const lon = SESSIONS.find((s) => s.id === "london")!;
  const summer = Math.floor(Date.UTC(2024, 6, 15, 7, 0) / 1000); // 15 Jul 2024 07:00 UTC
  const winter = Math.floor(Date.UTC(2024, 0, 15, 8, 0) / 1000); // 15 Jan 2024 08:00 UTC
  check("London open at BST summer = 07:00 UTC", sessionBoundsUTC(lon, summer)?.openUTC === summer, String(sessionBoundsUTC(lon, summer)?.openUTC));
  check("London open at GMT winter = 08:00 UTC", sessionBoundsUTC(lon, winter)?.openUTC === winter, String(sessionBoundsUTC(lon, winter)?.openUTC));
  check("isInSession London summer 09:00 UTC true", isInSession(lon, summer + 2 * 3600));
  check("isInSession London summer 23:00 UTC false", !isInSession(lon, summer + 16 * 3600));
  const ny = SESSIONS.find((s) => s.id === "newyork")!;
  // NY 08:00 local: EDT = 12:00 UTC; EST = 13:00 UTC
  check("NY open EDT = 12:00 UTC", sessionBoundsUTC(ny, Math.floor(Date.UTC(2024, 6, 15, 12, 0) / 1000))?.openUTC === Math.floor(Date.UTC(2024, 6, 15, 12, 0) / 1000));
  const bars = makeBars(400);
  const st = sessionStats(bars, lon, bars[300].time); // anchored inside the fixture span
  check("sessionStats returns range ≥ 0", st ? st.range >= 0 : false);
  check("prevDayHighLow works", prevDayHighLow(bars) !== null);
  const ns = nextSessionChange();
  check("nextSessionChange yields a session + future time", !!ns.next && ns.nextChangeUTC > Date.now() / 1000 - 60);
  check("wallTime NY uses Intl DST", wallTime(summer, "America/New_York") === "03:00", wallTime(summer, "America/New_York"));
}

console.log("— volume analysis —");
{
  const bars = makeBars(300, 100);
  const prof = buildVolumeProfile(bars, 24)!;
  check("profile built", !!prof);
  check("VAL ≤ POC ≤ VAH", prof.val <= prof.poc && prof.poc <= prof.vah, `${prof.val}/${prof.poc}/${prof.vah}`);
  check("value area ≈ 70% (≥60%, ≤85%)", (() => {
    const step = (prof.hi - prof.lo) / 24;
    const va = prof.rows.filter((r) => r.price >= prof.val - step && r.price <= prof.vah + step).reduce((s, r) => s + r.volume, 0);
    const share = va / prof.total;
    return share > 0.6 && share < 0.85;
  })());
  check("buy+sell = total when takerBuy present", Math.abs(prof.rows.reduce((s, r) => s + r.buy + r.sell, 0) - prof.total) < prof.total * 0.02);
  const av = anchoredVwap(bars, bars[100].time);
  check("anchored VWAP starts at anchor", av.length === bars.length - 100 && av[0].time === bars[100].time);
  const delta = volumeDelta(bars);
  check("delta real (takerBuy): first = 2*tb − vol", !!delta && Math.abs(delta[0].delta - (2 * bars[0].takerBuy! - bars[0].volume!)) < 0.01);
  const noTb = bars.map((b) => ({ ...b, takerBuy: undefined }));
  check("delta null without taker data (no fabrication)", volumeDelta(noTb) === null);
}

console.log("— backtest —");
{
  const bars = makeBars(800, 100);
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST, symbol: "BTCUSD", timeframe: "1h", slType: "pct", slValue: 1, tpType: "rr", tpValue: 1.5, riskPct: 1, startingBalance: 10000, commissionPct: 0.02, spreadPips: 2, entryLong: [{ kind: "emaCrossUp", p1: 9, p2: 21 }], entryShort: [{ kind: "emaCrossDown", p1: 9, p2: 21 }] };
  const res = runBacktest(bars, cfg);
  if ("error" in res) { check("backtest ran", false, res.error); }
  else {
    check("backtest produced trades", res.stats.total > 0, `total=${res.stats.total}`);
    check("netProfit == Σpnl", Math.abs(res.stats.netProfit - res.trades.reduce((s, t) => s + t.pnl, 0)) < 0.01);
    check("equity ends at start + net", Math.abs(res.equity[res.equity.length - 1].value - (cfg.startingBalance + res.stats.netProfit)) < 0.011,
      `eq=${res.equity[res.equity.length - 1].value} start+net=${cfg.startingBalance + res.stats.netProfit} diff=${res.equity[res.equity.length - 1].value - (cfg.startingBalance + res.stats.netProfit)}`);
    check("wins + losses = total", res.stats.wins + res.stats.losses === res.stats.total);
    check("winRate consistent", Math.abs(res.stats.winRate - (res.stats.wins / res.stats.total) * 100) < 0.2);
    check("monthly Σ = netProfit", Math.abs(res.monthly.reduce((s, m) => s + m.pnl, 0) - res.stats.netProfit) < 0.01);
    check("maxDD ≥ 0", res.stats.maxDrawdown >= 0);
    check("no look-ahead: entry after signal bar", res.trades.every((t) => {
      const idx = bars.findIndex((b) => b.time === t.entryTime);
      return idx > 0;
    }));
    check("all exits after entries", res.trades.every((t) => t.exitTime >= t.entryTime));
    check("longs+shorts=total", res.stats.longs + res.stats.shorts === res.stats.total);
    // too-short data → honest error
    const short = runBacktest(bars.slice(0, 50), cfg);
    check("insufficient data → explicit error", "error" in short);
  }
}

console.log("— screener —");
{
  const barsUp = makeBars(300, 100).map((b, i, arr) => ({ ...b, close: b.close * (1 + i * 0.0005), time: b.time })); // force uptrend
  const barsDown = makeBars(300, 100).map((b, i) => ({ ...b, close: b.close * (1 - i * 0.0005), time: b.time }));
  const rows = runScreener({ BTCUSD: barsUp as Bar[], ETHUSD: barsDown as Bar[] }, [
    { ...newFilter(), kind: "priceMovePct", op: "above", value: 1, p1: 100, p2: 0 },
  ]);
  check("screener returns 2 rows", rows.length === 2);
  check("uptrend passes move filter", rows.find((r) => r.symbol === "BTCUSD")?.passed === true);
  check("downtrend fails move filter", rows.find((r) => r.symbol === "ETHUSD")?.passed === false);
}

console.log("— mtf —");
{
  const bars = makeBars(600, 100);
  const row = analyzeTimeframe(bars, "1h");
  check("mtf row has valid trend", ["BULLISH", "BEARISH", "NEUTRAL"].includes(row.trend));
  check("mtf score in [-100,100]", row.score >= -100 && row.score <= 100);
  check("insufficient bars → NEUTRAL", analyzeTimeframe(bars.slice(0, 20), "1d").trend === "NEUTRAL");
  const table = mtfTable({ "1h": bars });
  check("mtf table covers 6 tfs", table.length === MTF_TFS.length);
}

console.log("— calculators —");
{
  check("EURUSD pip value = $10/lot", Math.abs(pipValue("EURUSD", 1).valuePerLot - 10) < 1e-9);
  check("XAUUSD tick value = $10/lot", Math.abs(pipValue("XAUUSD", 1).valuePerLot - 10) < 1e-9);
  const jpy = pipValue("USDJPY", 1, 150); // 0.01*100000=1000 JPY /150 = $6.67
  check("USDJPY pip value converts to USD", Math.abs(jpy.valuePerLot - 6.6667) < 0.01, String(jpy.valuePerLot));
  const ps = positionSize("EURUSD", 10000, 1, 20);
  check("position size: $100 risk / (20×$10) = 0.5 lots", Math.abs(ps.lots - 0.5) < 1e-9, String(ps.lots));
  const mg = margin("EURUSD", 1, 1.1, 100);
  check("margin = notional/leverage = $1100", Math.abs(mg.margin - 1100) < 0.01, String(mg.margin));
  const pl = profitLoss("EURUSD", "buy", 1.1, 1.105, 1);
  check("P/L = 50 pips × $10 = $500", Math.abs(pl.pnl - 500) < 1e-9 && Math.abs(pl.pips - 50) < 1e-9);
  const fib = fibonacci(100, 200);
  check("fib 0.618 retracement = 138.2", Math.abs(fib.find((f) => f.level === 0.618)!.price - 138.2) < 1e-9);
  check("fib 1.618 extension = 261.8", Math.abs(fib.find((f) => f.level === 1.618)!.price - 261.8) < 1e-9);
  const dd = drawdown([100, 120, 90, 110, 80]);
  check("maxDD 120→80 = 40 (33.33%)", Math.abs(dd.maxDD - 40) < 1e-9 && Math.abs(dd.maxDDPct - 33.33) < 0.01);
  const comp = compounding(1000, 10, 2);
  check("compounding 1000@10%×2 = 1210", Math.abs(comp[2] - 1210) < 1e-9);
  const rr = riskReward(100, 95, 115);
  check("R:R (100/95/115) = 3.0", rr.rr === 3);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
