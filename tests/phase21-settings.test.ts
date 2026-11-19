/**
 * Phase 21 — settings architecture tests. Exercises the pure validators and
 * session logic behind the new instrument explorer / watchlists / settings
 * stores:
 *  · market-status: real session windows (crypto 24/7, spot FX/metals
 *    Sun 22:00 → Fri 21:00 UTC, index exchange hours in their own timezone)
 *  · terminal-settings sanitize: corrupt shapes fall back field-by-field,
 *    unknown symbols never become defaults, numbers are clamped
 *  · instrument-settings sanitize: per-symbol override validation — a
 *    corrupt EURUSD blob can never poison XAUUSD (fields are validated
 *    independently and unknown ones dropped)
 *  · watchlists sanitize: unknown symbols filtered out, defaults restored
 *    from corrupt docs, favorites/recents capped
 * Run: node --test tests/  (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketStatus } from "../client/src/lib/market-status.ts";
import { __sanitizeTerminalSettings } from "../client/src/lib/terminal-settings.ts";
import { __sanitizeInstrumentSettings } from "../client/src/lib/instrument-settings.ts";
import { __sanitizeWatchlists } from "../client/src/lib/watchlists.ts";
import { DEFAULT_TERMINAL_SETTINGS } from "../client/src/lib/terminal-settings.ts";

// fixed anchors: 2026-11-19 is a Thursday (market open mid-week)
const THU = Date.UTC(2026, 10, 19, 12, 0, 0); // Thu 12:00 UTC
const SAT = Date.UTC(2026, 10, 21, 12, 0, 0); // Sat 12:00 UTC
const SUN_BEFORE = Date.UTC(2026, 10, 22, 20, 0, 0); // Sun 20:00 UTC (closed)
const SUN_AFTER = Date.UTC(2026, 10, 22, 23, 0, 0); // Sun 23:00 UTC (open)
const FRI_LATE = Date.UTC(2026, 10, 20, 22, 0, 0); // Fri 22:00 UTC (closed)

test("market-status: crypto trades 24/7 even on weekends", () => {
  assert.equal(marketStatus("BTCUSD", SAT), "open");
  assert.equal(marketStatus("ETHUSD", SUN_BEFORE), "open");
});

test("market-status: spot metals and forex close for the weekend", () => {
  assert.equal(marketStatus("XAUUSD", SAT), "closed");
  assert.equal(marketStatus("EURUSD", SUN_BEFORE), "closed");
  assert.equal(marketStatus("XAUUSD", SUN_AFTER), "open");
  assert.equal(marketStatus("EURUSD", FRI_LATE), "closed");
  assert.equal(marketStatus("XAUUSD", THU), "open");
});

test("market-status: indices follow exchange regular hours (DST-safe)", () => {
  // Thu 12:00 UTC = 07:00 New York (EST) → pre-market → closed
  assert.equal(marketStatus("NAS100", THU), "closed");
  // Thu 15:00 UTC = 10:00 New York → regular session → open
  assert.equal(marketStatus("NAS100", Date.UTC(2026, 10, 19, 15, 0, 0)), "open");
  // Saturday always closed for indices
  assert.equal(marketStatus("US30", SAT), "closed");
});

test("market-status: unknown instruments are closed, never 'open'", () => {
  assert.equal(marketStatus("NOPE42", THU), "closed");
});

// ---------------------------------------------------------------------------
// terminal-settings sanitize
// ---------------------------------------------------------------------------

test("terminal-settings: corrupt shape falls back to defaults", () => {
  const s = __sanitizeTerminalSettings(null);
  assert.deepEqual(s, DEFAULT_TERMINAL_SETTINGS);
  const s2 = __sanitizeTerminalSettings({ general: "junk", trading: 42, appearance: [] });
  assert.deepEqual(s2, DEFAULT_TERMINAL_SETTINGS);
});

test("terminal-settings: unknown symbol never becomes the default", () => {
  const s = __sanitizeTerminalSettings({ general: { defaultSymbol: "JUNKCOIN", defaultTf: "7m" } });
  assert.equal(s.general.defaultSymbol, "BTCUSD");
  assert.equal(s.general.defaultTf, "5m");
  const ok = __sanitizeTerminalSettings({ general: { defaultSymbol: "XAUUSD", defaultTf: "15m" } });
  assert.equal(ok.general.defaultSymbol, "XAUUSD");
  assert.equal(ok.general.defaultTf, "15m");
});

test("terminal-settings: numbers clamp, enums validate, unknown fields drop", () => {
  const s = __sanitizeTerminalSettings({
    version: 99,
    evil: { hack: true },
    appearance: { fontSize: 99, density: "ridiculous", themeBackdrop: "yes" },
    trading: { defaultLot: "-5", defaultRisk: 500, confirmOrders: "no", defaultOrderType: "iceberg" },
    general: { timezone: "Asia/Tashkent", numberFormat: "grouped" },
  });
  assert.equal(s.version, 1);
  assert.equal((s as any).evil, undefined);
  assert.equal(s.appearance.fontSize, 16);
  assert.equal(s.appearance.density, "compact");
  assert.equal(s.appearance.themeBackdrop, true); // non-boolean → default
  assert.equal(s.trading.defaultLot, "0.10");
  assert.equal(s.trading.defaultRisk, "1"); // 500% is not a valid risk percent → default
  assert.equal(s.trading.confirmOrders, true);
  assert.equal(s.trading.defaultOrderType, "market");
  assert.equal(s.general.timezone, "Asia/Tashkent");
  assert.equal(s.general.numberFormat, "grouped");
});

// ---------------------------------------------------------------------------
// instrument-settings sanitize (per-symbol isolation)
// ---------------------------------------------------------------------------

test("instrument-settings: every field validates independently", () => {
  const s = __sanitizeInstrumentSettings({
    chartType: "shiny3d", timeframe: "2h", upColor: "not-a-color", downColor: "#ff0000",
    grid: "yes", bidAsk: false, defaultLot: 0, defaultRisk: "2.5", slPips: 99999999, tpPips: "x",
  });
  assert.equal(s.chartType, undefined); // invalid enum dropped
  assert.equal(s.timeframe, "2h");
  assert.equal(s.upColor, undefined); // invalid color dropped
  assert.equal(s.downColor, "#ff0000");
  assert.equal(s.grid, undefined); // non-boolean dropped
  assert.equal(s.bidAsk, false);
  assert.equal(s.defaultLot, undefined); // ≤0 dropped
  assert.equal(s.defaultRisk, "2.5");
  assert.equal(s.slPips, undefined); // >100000 dropped
  assert.equal(s.tpPips, undefined);
});

test("instrument-settings: an empty override set stays empty (inherits globals)", () => {
  assert.deepEqual(__sanitizeInstrumentSettings(undefined), {});
  assert.deepEqual(__sanitizeInstrumentSettings({ junk: 1, moreJunk: null }), {});
});

// ---------------------------------------------------------------------------
// watchlists sanitize
// ---------------------------------------------------------------------------

test("watchlists: unknown symbols are filtered out of lists", () => {
  const s = __sanitizeWatchlists({
    lists: [{ id: "a", name: "A", symbols: ["XAUUSD", "FAKEUSD", "BTCUSD"] }],
    activeId: "a", favorites: ["NOPE"], recents: ["XAUUSD", "GHOST"],
  });
  assert.deepEqual(s.lists[0].symbols, ["XAUUSD", "BTCUSD"]);
  assert.deepEqual(s.favorites, []);
  assert.deepEqual(s.recents, ["XAUUSD"]);
});

test("watchlists: corrupt docs restore the default list", () => {
  const s = __sanitizeWatchlists({ lists: "junk" });
  assert.equal(s.lists.length, 1);
  assert.equal(s.lists[0].id, "main");
  assert.ok(s.lists[0].symbols.includes("XAUUSD"));
});

test("watchlists: activeId falls back to the first list when unknown", () => {
  const s = __sanitizeWatchlists({
    lists: [{ id: "a", name: "A", symbols: [] }, { id: "b", name: "B", symbols: [] }],
    activeId: "gone",
  });
  assert.equal(s.activeId, "a");
});
