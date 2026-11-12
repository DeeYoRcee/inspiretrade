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
import {
  EMPTY_STATE, DEFAULT_ACCOUNT, openMarket, placePending, cancelPending, modifyPosition,
  closePosition, stepBar, lotsForRisk, equityOf, type ReplayState, type ReplayAccountConfig,
} from "@/lib/terminal/replay-engine";
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

console.log("— replay engine —");
{
  const cfg: ReplayAccountConfig = { ...DEFAULT_ACCOUNT, startingBalance: 10000, leverage: 100, spreadPips: 2, commissionPct: 0, slippagePips: 0 };
  const bar = (o: number, h: number, l: number, c: number, t = 1000): Bar & { symbol?: string } => ({ time: t, open: o, high: h, low: l, close: c, symbol: "EURUSD" });
  // EURUSD: pip 0.0001, contract 100000, $10/pip/lot

  // market buy at close 1.1000 → entry = ask = 1.1002
  let st = EMPTY_STATE(10000);
  let r = openMarket(st, cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1 });
  check("market buy fills at ask", !r.error && r.state.positions[0].entry === 1.1002, String(r.error));
  st = r.state;
  // close at close 1.1020: +18 pips × $1/pip (0.1 lot) = $18
  r = closePosition(st, cfg, bar(1.1015, 1.1025, 1.1010, 1.1020, 1001), st.positions[0].id);
  check("long P/L exact: +$18 (0.1 lot)", !r.error && r.state.balance === 10018, `bal=${r.state.balance}`);
  check("closed trade reason manual", r.state.closed[0]?.reason === "manual");
  check("pips recorded 18", r.state.closed[0]?.pips === 18);

  // sell at close 1.1000 → entry = bid = 1.1000; close at 1.0950 → exit at ask 1.0952: +48 pips
  st = EMPTY_STATE(10000);
  r = openMarket(st, cfg, bar(1.1005, 1.1010, 1.0995, 1.1000), { symbol: "EURUSD", side: "sell", lots: 0.1 });
  st = r.state;
  r = closePosition(st, cfg, bar(1.0955, 1.0960, 1.0940, 1.0950, 1002), st.positions[0].id);
  check("sell P/L exact: +$48 (spread on exit)", !r.error && r.state.balance === 10048, `bal=${r.state.balance}`);

  // SL execution (buy): entry 1.1002, sl 1.0952, bar low 1.0950 → exit 1.0952 → −$500
  st = EMPTY_STATE(10000);
  r = openMarket(st, cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1, sl: 1.0952 });
  st = r.state;
  const step = stepBar(st, cfg, bar(1.1000, 1.1005, 1.0950, 1.0960, 1003));
  check("SL fills at exact level", step.state.closed[0]?.exit === 1.0952 && step.state.closed[0]?.reason === "sl");
  check("SL P/L −$50 (0.1 lot)", step.state.balance === 9950, String(step.state.balance));

  // conservative: SL and TP both touched in one candle → SL first + flag
  st = EMPTY_STATE(10000);
  r = openMarket(st, cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1, sl: 1.0952, tp: 1.1100 });
  const cons = stepBar(r.state, cfg, bar(1.1000, 1.1105, 1.0950, 1.1050, 1004));
  check("both touched → conservative SL fill", cons.state.closed[0]?.reason === "sl" && cons.state.closed[0]?.slConservative === true, JSON.stringify(cons.state.closed[0]));

  // TP only → exact TP fill
  st = EMPTY_STATE(10000);
  r = openMarket(st, cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1, tp: 1.1100 });
  const tpStep = stepBar(r.state, cfg, bar(1.1010, 1.1102, 1.1005, 1.1090, 1005));
  check("TP fills at exact level (+$98)", tpStep.state.balance === 10098, String(tpStep.state.balance));
  check("TP reason", tpStep.state.closed[0]?.reason === "tp");

  // buy limit: limit 1.0950 below market; bar open 1.0990 low 1.0940 → fill 1.0950 → entry 1.0952
  st = EMPTY_STATE(10000);
  r = placePending(st, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", type: "limit", lots: 0.1, price: 1.0950, sl: null, tp: null });
  check("pending placed", !r.error && r.state.orders.length === 1, String(r.error));
  const limFill = stepBar(r.state, cfg, bar(1.0990, 1.0995, 1.0940, 1.0980, 1006));
  check("buy limit fills at limit+spread", limFill.state.positions[0]?.entry === 1.0952 && limFill.state.orders.length === 0, String(limFill.state.positions[0]?.entry));

  // buy limit gapped through: open 1.0900 → fill at open (better)
  r = placePending(EMPTY_STATE(10000), bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", type: "limit", lots: 0.1, price: 1.0950, sl: null, tp: null });
  const gapFill = stepBar(r.state, cfg, bar(1.0900, 1.0910, 1.0890, 1.0905, 1007));
  check("limit gap → better open fill", gapFill.state.positions[0]?.entry === 1.0902, String(gapFill.state.positions[0]?.entry));

  // buy stop: 1.1050 above market; bar high 1.1060 → fill max(1.1050, open) + slip
  r = placePending(EMPTY_STATE(10000), bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", type: "stop", lots: 0.1, price: 1.1050, sl: null, tp: null });
  const stopFill = stepBar(r.state, cfg, bar(1.1005, 1.1060, 1.1000, 1.1055, 1008));
  check("buy stop fills at stop+spread", stopFill.state.positions[0]?.entry === 1.1052, String(stopFill.state.positions[0]?.entry));
  // stop gapped: open 1.1070 → fill at open (worse)
  r = placePending(EMPTY_STATE(10000), bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", type: "stop", lots: 0.1, price: 1.1050, sl: null, tp: null });
  const stopGap = stepBar(r.state, cfg, bar(1.1070, 1.1080, 1.1060, 1.1075, 1009));
  check("stop gap → worse open fill", stopGap.state.positions[0]?.entry === 1.1072, String(stopGap.state.positions[0]?.entry));

  // slippage on market orders
  const slipCfg = { ...cfg, slippagePips: 1 };
  r = openMarket(EMPTY_STATE(10000), slipCfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1 });
  check("market buy + 1 pip slippage", r.state.positions[0]?.entry === 1.1003, String(r.state.positions[0]?.entry));

  // commission per side
  const comCfg = { ...cfg, commissionPct: 0.02 };
  r = openMarket(EMPTY_STATE(10000), comCfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 1 });
  check("entry commission charged ($22.00)", r.state.balance === 9978.0, String(r.state.balance));

  // margin rejection: leverage 10 → need ~$110k > free
  const levCfg = { ...cfg, leverage: 10 };
  r = openMarket(EMPTY_STATE(10000), levCfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 10 });
  check("insufficient margin rejected", !!r.error && r.error.startsWith("Insufficient margin"), String(r.error));

  // partial close: 1.0 lots, close 0.4 → 0.6 remains, pnl proportional
  st = EMPTY_STATE(10000);
  r = openMarket(st, cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 1.0 });
  st = r.state;
  r = closePosition(st, cfg, bar(1.1015, 1.1025, 1.1010, 1.1020, 1010), st.positions[0].id, 0.4);
  check("partial close 0.4 → +$72 realized (0.6 left)", !r.error && r.state.balance === 10072 && r.state.positions[0].lots === 0.6, JSON.stringify({ bal: r.state.balance, lots: r.state.positions[0]?.lots }));

  // modify SL/TP + cancel pending
  r = openMarket(EMPTY_STATE(10000), cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1 });
  st = modifyPosition(r.state, r.state.positions[0].id, { sl: 1.0900, tp: 1.1200 });
  check("modify SL/TP persists", st.positions[0].sl === 1.0900 && st.positions[0].tp === 1.1200);
  r = placePending(EMPTY_STATE(10000), bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", type: "limit", lots: 0.1, price: 1.0950, sl: null, tp: null });
  st = cancelPending(r.state, r.state.orders[0].id);
  check("cancel pending", st.orders.length === 0);

  // lotsForRisk: $100 risk / 50 pips on EURUSD = 0.2 lots
  check("lotsForRisk 0.2", lotsForRisk("EURUSD", 100, 0.0050) === 0.2);

  // equity includes floating
  r = openMarket(EMPTY_STATE(10000), cfg, bar(1.0995, 1.1005, 1.0990, 1.1000), { symbol: "EURUSD", side: "buy", lots: 0.1 });
  const eq = equityOf(r.state, () => 1.1020, cfg);
  check("equity = balance + floating (+$18)", Math.abs(eq - 10018) < 0.01, String(eq));

  // DETERMINISM: identical scripted runs → identical JSON
  const script = (s: ReplayState) => {
    let out = openMarket(s, cfg, bar(1.0995, 1.1005, 1.0990, 1.1000, 1100), { symbol: "EURUSD", side: "buy", lots: 0.2, sl: 1.0952, tp: 1.1100 });
    out = stepBar(out.state, cfg, bar(1.1000, 1.1040, 1.0995, 1.1030, 1101));
    out = closePosition(out.state, cfg, bar(1.1050, 1.1060, 1.1045, 1.1055, 1102), out.state.positions[0].id, 0.1);
    out = stepBar(out.state, cfg, bar(1.1030, 1.1105, 1.1010, 1.1090, 1103));
    return out.state;
  };
  const a = script(EMPTY_STATE(10000)), b = script(EMPTY_STATE(10000));
  check("determinism: identical runs → identical state", JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
