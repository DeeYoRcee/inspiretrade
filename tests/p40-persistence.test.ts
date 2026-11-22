/**
 * Phase 40 — drawing persistence merge/tombstone/stamp helpers.
 * Run: node --test tests/p40-persistence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __sanitizeDrawingList, filterTombstonedDrawings, mergeDrawingLists,
  newDrawingId, stampChangedDrawings, type Drawing,
} from "../client/src/lib/drawings.ts";

const mk = (id: string, over: Partial<Drawing> = {}): Drawing => ({
  id,
  type: "trend",
  points: [{ time: 1700000000, price: 100 }, { time: 1700003600, price: 110 }],
  style: { color: "#38bdf8", width: 2, dash: "solid", fontSize: 12 },
  ...over,
});

test("newDrawingId — 2000 ids are unique", () => {
  const ids = new Set(Array.from({ length: 2000 }, () => newDrawingId()));
  assert.equal(ids.size, 2000);
});

test("stampChangedDrawings — new and edited drawings get a timestamp, untouched keep identity", () => {
  const a = mk("a");
  const b = mk("b");
  const edited = { ...mk("a"), points: [{ time: 1, price: 2 }, { time: 3, price: 4 }] };
  const out = stampChangedDrawings([a, b], [edited, b, mk("c")], 12345);
  assert.equal(out[0].updatedAt, 12345); // edited → stamped
  assert.equal(out[1], b);               // unchanged → identity preserved
  assert.equal(out[2].updatedAt, 12345); // new → stamped
});

test("mergeDrawingLists — identical lists return the LOCAL reference (self-echo)", () => {
  const local = [mk("a", { updatedAt: 10 }), mk("b", { updatedAt: 10 })];
  const remote = [{ ...local[0] }, { ...local[1] }];
  assert.equal(mergeDrawingLists(local, remote), local);
});

test("mergeDrawingLists — remote newer edit wins, local newer edit wins", () => {
  const local = [mk("a", { updatedAt: 10 }), mk("b", { updatedAt: 30 })];
  const remote = [{ ...mk("a"), updatedAt: 20 }, { ...mk("b"), updatedAt: 15 }];
  const merged = mergeDrawingLists(local, remote);
  assert.equal(merged[0].updatedAt, 20);  // remote edited later
  assert.notEqual(merged[0], local[0]);   // replaced with the remote copy
  assert.equal(merged[1], local[1]);      // local is newer → identity kept
});

test("mergeDrawingLists — local-only kept only while in flight, remote-only added, remote deletion propagates", () => {
  const local = [mk("a", { updatedAt: 10 }), mk("pending", { updatedAt: Date.now() })];
  const remote = [mk("a", { updatedAt: 10 })]; // "pending" not yet on RTDB
  const merged = mergeDrawingLists(local, remote, new Set(["pending"]));
  assert.deepEqual(merged.map((d) => d.id), ["a", "pending"]);
  // the same snapshot with NO pending marker = deleted remotely
  const stale = [mk("pending", { updatedAt: 10 })];
  assert.deepEqual(mergeDrawingLists(stale, []).map((d) => d.id), []);

  const local2 = [mk("a", { updatedAt: 10 }), mk("b", { updatedAt: 10 })];
  const remote2 = [mk("a", { updatedAt: 10 })]; // b deleted on another device
  assert.deepEqual(mergeDrawingLists(local2, remote2).map((d) => d.id), ["a"]);
});

test("filterTombstonedDrawings — stale echo of a deleted drawing is dropped, newer edit survives", () => {
  const staleEcho = mk("x", { updatedAt: 100 });
  const editedAfter = mk("x", { updatedAt: 500 });
  const tombs = { x: 300 };
  assert.deepEqual(filterTombstonedDrawings([staleEcho], tombs), []);
  assert.equal(filterTombstonedDrawings([editedAfter], tombs).length, 1);
  assert.equal(filterTombstonedDrawings([mk("y")], tombs).length, 1);
});

test("sanitize round-trip keeps updatedAt (LWW survives reload)", () => {
  const list = [{ ...mk("a"), updatedAt: 999 }];
  const out = __sanitizeDrawingList(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].updatedAt, 999);
  assert.equal(__sanitizeDrawingList([mk("b")])[0].updatedAt, undefined);
});

test("full lifecycle — create → echo → edit elsewhere → delete → stale echo", () => {
  // 1) created locally, stamped, echoed back identically
  const created = stampChangedDrawings([], [mk("d1")], 100);
  assert.equal(mergeDrawingLists(created, created.map((d) => ({ ...d }))), created);
  // 2) another device edits it later — remote wins on merge
  const remoteEdit = [{ ...mk("d1"), updatedAt: 200 }];
  const merged = mergeDrawingLists(created, remoteEdit);
  assert.equal(merged[0].updatedAt, 200);
  // 3) user deletes it here → tombstone at 300 → stale remote echo (200) dropped
  const tombs = { d1: 300 };
  assert.deepEqual(filterTombstonedDrawings(merged, tombs), []);
  // 4) but a NEWER remote edit (400) is not hidden by the tombstone
  const newer = [{ ...mk("d1"), updatedAt: 400 }];
  assert.equal(filterTombstonedDrawings(newer, tombs).length, 1);
});
