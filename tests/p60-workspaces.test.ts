/**
 * PHASE 60 — workspace schema/persistence regression tests (pure modules).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePreset, exportWorkspaceFile, importWorkspaceFile } from "../client/src/lib/workspace-schema.ts";

const base = {
  id: "ws-abc", name: "Gold Analysis", layout: "4",
  panels: [
    { symbol: "XAUUSD", timeframe: "1h", chartType: "candles" },
    { symbol: "XAUUSD", timeframe: "15m" },
    { symbol: "EURUSD", timeframe: "1d" },
    { symbol: "BTCUSD", timeframe: "4h" },
  ],
  updatedAt: 1700000000000,
};

test("P60: sanitizePreset v2 keeps default + sync flags", () => {
  const w = sanitizePreset({ ...base, default: true, sync: { crosshair: true, time: true, symbol: false, interval: "x" } })!;
  assert.equal(w.default, true);
  assert.deepEqual(w.sync, { crosshair: true, time: true, symbol: false, interval: false });
  const w2 = sanitizePreset(base)!;
  assert.equal(w2.default, false); // absent → false
  assert.equal(w2.sync, undefined);
});

test("P60: sanitize clamps unknown layouts/timeframes/types", () => {
  const w = sanitizePreset({ ...base, layout: "999", panels: [{ symbol: "XAUUSD", timeframe: "7m", chartType: "madeup" }] } as any)!;
  assert.equal(w.layout, "1");
  assert.equal(w.panels[0].timeframe, "1h");
  assert.ok(!w.panels[0].chartType); // unknown type dropped
  assert.equal(sanitizePreset({ ...base, panels: [] } as any), null); // no panels → rejected
});

test("P60: export → import round-trip preserves the grid", () => {
  const w = sanitizePreset({ ...base, sync: { crosshair: true, time: false, symbol: true, interval: false } })!;
  const json = JSON.stringify(exportWorkspaceFile(w), null, 2);
  const back = importWorkspaceFile(json);
  assert.equal(back.layout, "4");
  assert.equal(back.panels.length, 4);
  assert.deepEqual(back.panels.map((p) => p.symbol), ["XAUUSD", "XAUUSD", "EURUSD", "BTCUSD"]);
  assert.deepEqual(back.sync, w.sync);
  assert.notEqual(back.id, w.id); // fresh id — never trust imported ids
  // no credentials in the export
  assert.ok(!json.includes("token") && !json.includes("password") && !json.includes("apiKey"));
});

test("P60: invalid imports are rejected safely", () => {
  assert.throws(() => importWorkspaceFile("not json"), /JSON/);
  assert.throws(() => importWorkspaceFile(JSON.stringify({ hello: 1 })), /not an InspireTrade/);
  assert.throws(() => importWorkspaceFile(JSON.stringify({ inspiretrade: 1, kind: "workspace", name: "x", layout: "1", panels: [] })), /valid panels/);
  // an export file with hostile field shapes must not throw unsafely — it clamps
  const hostile = JSON.stringify({ inspiretrade: 1, kind: "workspace", name: 42, layout: "2h", panels: [{ symbol: { a: 1 } }, null, { symbol: "XAUUSD", timeframe: "1h" }] });
  const w = importWorkspaceFile(hostile);
  assert.equal(w.panels.length, 1); // only the valid panel survives
  assert.equal(w.panels[0].symbol, "XAUUSD");
});
