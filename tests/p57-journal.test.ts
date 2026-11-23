/**
 * Phase 57 — unified journal: source classification + CSV import.
 * Run: node --test tests/p57-journal.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tradeSource, computeSourceStats, sourceFilterPredicate,
} from "../client/src/lib/trade-source.ts";
import {
  detectDelimiter, splitCsvLine, parseTradesCsv, autoMapColumns,
  parseTimestamp, parseDirection, parseNum, validateCsvRows, toImportableTrades,
} from "../client/src/lib/csv-import.ts";
import type { Trade } from "../client/src/hooks/use-trades.ts";

const mk = (over: Partial<Trade>): Trade => ({
  id: "t", userId: "u", assetName: "XAUUSD", instrumentSymbol: "XAUUSD", instrumentName: "Gold",
  entryPrice: 2000, exitPrice: 2010, lotSize: 0.5, profit: 100, type: "BUY", category: "FOREX",
  timestamp: Date.now(), ...over,
} as Trade);

test("P57: legacy rows without source read as manual", () => {
  assert.equal(tradeSource({} as any), "manual");
  assert.equal(tradeSource({ source: "prop" }), "prop");
  assert.equal(tradeSource({ source: "external" }), "external");
  assert.equal(tradeSource({ source: "junk" as any }), "manual");
});

test("P57: per-source stats stay separated", () => {
  const trades = [
    mk({ profit: 100, source: "prop" }),
    mk({ profit: -50, source: "prop" }),
    mk({ profit: 30, source: "external", brokerName: "IC Markets" }),
    mk({ profit: -20, source: "external", brokerName: "IC Markets" }),
    mk({ profit: 10 }), // legacy manual
  ];
  const st = computeSourceStats(trades);
  assert.equal(st.all.count, 5);
  assert.equal(st.prop.count, 2);
  assert.equal(st.external.count, 2);
  assert.equal(st.manual.count, 1);
  assert.equal(st.prop.netPnl, 50);
  assert.equal(st.external.netPnl, 10);
  assert.deepEqual(st.brokers, ["IC Markets"]);
  assert.equal(st.prop.winRate, 50);
});

test("P57: source filter predicate (incl. broker-specific)", () => {
  const trades = [
    mk({ source: "prop" }), mk({ source: "external", brokerName: "A" }), mk({ brokerName: "B", source: "external" }), mk({}),
  ];
  assert.equal(trades.filter(sourceFilterPredicate("all")).length, 4);
  assert.equal(trades.filter(sourceFilterPredicate("prop")).length, 1);
  assert.equal(trades.filter(sourceFilterPredicate("external")).length, 2);
  assert.equal(trades.filter(sourceFilterPredicate("manual")).length, 1);
  assert.equal(trades.filter(sourceFilterPredicate("broker:A")).length, 1);
  assert.equal(trades.filter(sourceFilterPredicate("broker:B")).length, 1);
});

test("P57: csv parsing — delimiter detection + quoted fields", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  const cells = splitCsvLine('"GAZP,MR"', ",");
  assert.deepEqual(cells, ["GAZP,MR"]);
  const parsed = parseTradesCsv("Symbol,Type,Volume,Open Price,Close Price,Time,Profit\nEURUSD,buy,0.1,1.1,1.2,2024.01.15 10:30,50");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].cells[0], "EURUSD");
});

test("P57: auto column mapping covers MT5-style headers", () => {
  const m = autoMapColumns(["Ticket", "Symbol", "Type", "Volume", "Open Price", "Close Price", "Open Time", "Close Time", "Profit", "S/L", "T/P"]);
  assert.equal(m.symbol, "Symbol");
  assert.equal(m.type, "Type");
  assert.equal(m.volume, "Volume");
  assert.equal(m.entry, "Open Price");
  assert.equal(m.exit, "Close Price");
  assert.equal(m.openTime, "Open Time");
  assert.equal(m.closeTime, "Close Time");
  assert.equal(m.profit, "Profit");
  assert.equal(m.sl, "S/L");
  assert.equal(m.tp, "T/P");
});

test("P57: value parsers — timestamps, directions, numbers", () => {
  assert.equal(parseTimestamp("2024.01.15 10:30") !== null, true);
  assert.equal(parseTimestamp("2024-01-15 10:30:00") !== null, true);
  assert.equal(parseTimestamp("01/15/2024") !== null, true);
  assert.equal(parseTimestamp("15/01/2024") !== null, true);
  assert.equal(parseTimestamp("1705307400"), 1705307400000);
  assert.equal(parseTimestamp("garbage"), null);
  assert.equal(parseDirection("buy"), "BUY");
  assert.equal(parseDirection("Long"), "BUY");
  assert.equal(parseDirection("sell"), "SELL");
  assert.equal(parseDirection("short"), "SELL");
  assert.equal(parseDirection("0"), "BUY");
  assert.equal(parseDirection("banana"), null);
  assert.equal(parseNum("1,234.56"), 1234.56);
  assert.equal(parseNum("-12.5"), -12.5);
});

test("P57: csv validation — valid, invalid and duplicates (file + journal)", () => {
  const csv = [
    "Symbol,Type,Volume,Open Price,Close Price,Time,Profit",
    "EURUSD,buy,0.1,1.1000,1.2000,2024.01.15 10:30,50",
    "EURUSD,buy,0.1,1.1000,1.2000,2024.01.15 10:31,50",       // file-internal duplicate
    "XAUUSD,sell,0.5,2000,1990,2024.01.15 11:00,-30",          // duplicate of existing journal
    "BADROW,buy,abc,1,2,2024.01.15 12:00,5",                   // invalid volume
    "BTCUSD,buy,0.2,40000,41000,not-a-date,100",               // invalid date
  ].join("\n");
  const parsed = parseTradesCsv(csv);
  const mapping = autoMapColumns(parsed.headers);
  const res = validateCsvRows(parsed, mapping, {
    existingTrades: [{ assetName: "XAUUSD", type: "SELL", entryPrice: 2000, exitPrice: 1990, timestamp: new Date("2024-01-15T11:00:00").getTime() }],
  });
  assert.equal(res.valid.length, 1);
  assert.equal(res.valid[0].instrumentSymbol, "EURUSD");
  assert.equal(res.duplicates.length, 2);
  assert.equal(res.invalid.length, 2);
  const importable = toImportableTrades(res.valid, "My Broker");
  assert.equal(importable[0].source, "external");
  assert.equal(importable[0].brokerName, "My Broker");
  assert.equal(importable[0].assetName, "EURUSD");
});
