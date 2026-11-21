/**
 * PHASE 30b — hist day-shard row round-trip.
 * writeShards serializes rows with JSON.stringify([t,o,h,l,c,v]) — the
 * readers MUST parse that back (plus legacy CSV rows), or the chart deep
 * layers read as NaN/empty (the live "chart starts Oct 22" wall).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShardRow } from "../shared/feed-validation.ts";

const BAR = [1795267200, 2671.4, 2680.2, 2668.9, 2675.5, 12.34];

test("shard row: JSON-array format (what writeShards writes) parses back", () => {
  const a = parseShardRow(JSON.stringify(BAR));
  assert.ok(a, "JSON-array row must parse");
  assert.deepEqual(a, BAR);
});

test("shard row: legacy CSV format still parses (back-compat)", () => {
  const a = parseShardRow(BAR.join(","));
  assert.ok(a, "CSV row must parse");
  assert.deepEqual(a, BAR);
});

test("shard row: full writeShards blob round-trip (| joined rows)", () => {
  const rows = [BAR, [1795267260, 2675.5, 2676.1, 2674.2, 2674.8, 3.2]];
  const blob = rows.map((r) => JSON.stringify(r)).join("|");
  const back = blob.split("|").map(parseShardRow).filter(Boolean);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], BAR);
  assert.equal(back[1]![0], 1795267260);
});

test("shard row: malformed input returns null, never NaN", () => {
  assert.equal(parseShardRow(""), null);
  assert.equal(parseShardRow("garbage"), null);
  assert.equal(parseShardRow("[1,2,3"), null); // broken JSON
  assert.equal(parseShardRow('[1795267200,"NaN",1,1,1,0]'), null); // non-numeric ohlc
  assert.equal(parseShardRow("[0,2671,2680,2668,2675,0]"), null); // t <= 0
});

test("shard row: inverted OHLC rejected", () => {
  assert.equal(parseShardRow("[1795267200,2690,2680,2668,2675.5,0]"), null); // h < max(o,c)
  assert.equal(parseShardRow("[1795267200,2671,2680,2690,2675.5,0]"), null); // l > min(o,c)
  assert.equal(parseShardRow("[1795267200,2671,2680,2650,2675.5,0]"), null); // h < l
});
