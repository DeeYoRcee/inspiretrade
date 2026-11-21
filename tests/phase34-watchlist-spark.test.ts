/**
 * Phase 35 — watchlist sparkline helpers.
 *
 * The watchlist rows show a mini daily-close line built ONLY from real
 * provider data: the shared quotes snapshot already fetches daily bars for
 * its day-change math, and extractSpark turns those same bars into a bounded
 * series at zero extra request cost. These tests pin the extraction rules:
 *  · fewer than 2 valid closes → undefined (no fake line, row shows the
 *    loading placeholder instead)
 *  · non-finite / non-positive closes are dropped
 *  · long series are downsampled to ≤ cap points, always keeping the last
 *    close (the most recent price must survive downsampling)
 * Run: node --test tests/  (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSpark } from "../client/src/lib/sparkline.ts";

test("extractSpark: fewer than 2 valid closes → undefined (no fake data)", () => {
  assert.equal(extractSpark([]), undefined);
  assert.equal(extractSpark([{ close: 100 }]), undefined);
  assert.equal(extractSpark(null), undefined);
  assert.equal(extractSpark([{ close: Number.NaN }, { close: 0 }]), undefined);
});

test("extractSpark: keeps real closes, drops invalid ones", () => {
  const bars = [{ close: 10 }, { close: Number.NaN }, { close: -3 }, { close: 11 }, { close: 12 }];
  assert.deepEqual(extractSpark(bars), [10, 11, 12]);
});

test("extractSpark: short series passes through unchanged", () => {
  const bars = Array.from({ length: 5 }, (_, i) => ({ close: 100 + i * 2 }));
  assert.deepEqual(extractSpark(bars), [100, 102, 104, 106, 108]);
});

test("extractSpark: long series is downsampled to ≤ cap and keeps the LAST close", () => {
  const N = 90;
  const bars = Array.from({ length: N }, (_, i) => ({ close: 1000 + i }));
  const pts = extractSpark(bars, 30)!;
  assert.ok(pts.length <= 30, `cap respected (${pts.length})`);
  assert.ok(pts.length >= 2);
  assert.equal(pts[pts.length - 1], 1000 + N - 1, "most recent close survives");
  assert.equal(pts[0], 1000, "first close survives");
  // strictly increasing sample indices → points are in chronological order
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i] > pts[i - 1]);
});
