/**
 * P42 — Object Tree pure helpers + group persistence sanitization.
 * Run: node --test tests/p42-object-tree.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bulkPatch, dissolveGroup, groupFlag, groupMemberIds, moveToGroup,
  newGroupId, sanitizeGroups,
} from "../client/src/lib/drawing-tree.ts";
import { __sanitizeDrawingList } from "../client/src/lib/drawings.ts";

const mk = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, group: undefined, ...over });

test("newGroupId — unique across a burst", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newGroupId()));
  assert.equal(ids.size, 500);
});

test("sanitizeGroups — drops corrupted entries, clamps names", () => {
  const raw = {
    g1: { id: "g1", name: "  My trend lines  ", createdAt: 123 },
    "bad key!": { name: "invalid key characters" },  // key fails [a-z0-9]
    g2: { id: 42, name: "inner id is ignored — the KEY is the id" },
    g3: {},                                           // no name
    g4: { name: "" },
    g5: "not an object",
  };
  const out = sanitizeGroups(raw);
  assert.deepEqual(Object.keys(out), ["g1", "g2"]);
  assert.equal(out.g1.name, "My trend lines");
  assert.equal(out.g1.createdAt, 123);
  assert.equal(out.g2.id, "g2");
  assert.deepEqual(sanitizeGroups(null), {});
  assert.deepEqual(sanitizeGroups([1, 2]), {});
  assert.deepEqual(sanitizeGroups("x"), {});
});

test("sanitizeGroups — keeps collapsed flag", () => {
  const out = sanitizeGroups({ gxyz: { name: "A", collapsed: true } });
  assert.equal(out.gxyz.collapsed, true);
  const out2 = sanitizeGroups({ gxyz: { name: "A", collapsed: "yes" } });
  assert.equal(out2.gxyz.collapsed, undefined);
});

test("moveToGroup — assigns, clears with null, ignores unknown ids", () => {
  const list = [mk("a"), mk("b"), mk("c")] as Array<{ id: string; group?: string }>;
  const withG = moveToGroup(list, ["a", "c"], "g1");
  assert.deepEqual(withG.map((d) => d.group), ["g1", undefined, "g1"]);
  assert.equal(list[0].group, undefined); // pure — original untouched
  const cleared = moveToGroup(withG, ["a"], null);
  assert.equal(cleared[0].group, undefined);
  assert.equal(moveToGroup(list, [], "g1"), list);
});

test("groupMemberIds + groupFlag — empty group is never 'all hidden'", () => {
  const list = [
    mk("a", { group: "g1", hidden: true }),
    mk("b", { group: "g1", hidden: true }),
    mk("c", { group: "g2", hidden: false }),
    mk("d", { group: "g2", hidden: true }),
  ] as Array<{ id: string; group?: string; hidden?: boolean; locked?: boolean }>;
  assert.deepEqual(groupMemberIds(list, "g1"), ["a", "b"]);
  assert.deepEqual(groupMemberIds(list, "missing"), []);
  assert.equal(groupFlag(list, "g1", "hidden"), true);
  assert.equal(groupFlag(list, "g2", "hidden"), false);
  assert.equal(groupFlag(list, "missing", "hidden"), false); // empty → false
});

test("dissolveGroup — members return to Ungrouped, group deleted separately", () => {
  const list = [mk("a", { group: "g1" }), mk("b", { group: "g1" }), mk("c")] as Array<{ id: string; group?: string }>;
  const out = dissolveGroup(list, "g1");
  assert.deepEqual(out.map((d) => d.group), [undefined, undefined, undefined]);
  assert.deepEqual(list.map((d) => d.group), ["g1", "g1", undefined]); // pure
});

test("bulkPatch — patches exactly the given ids", () => {
  const list = [mk("a"), mk("b")] as Array<{ id: string; hidden?: boolean }>;
  const out = bulkPatch(list, ["a"], { hidden: true });
  assert.equal(out[0].hidden, true);
  assert.equal(out[1].hidden, undefined);
  assert.equal(bulkPatch(list, [], { hidden: true }), list);
});

test("drawing sanitizer keeps the group id, clamps it, drops garbage", () => {
  const d = {
    id: "d1", type: "trend",
    points: [{ time: 1, price: 2 }, { time: 3, price: 4 }],
    style: { color: "#38bdf8", width: 2, dash: "solid", fontSize: 12 },
    group: "gAbC123",
  };
  const [out] = __sanitizeDrawingList([d]) as Array<{ group?: string }>;
  assert.equal(out.group, "gAbC123");
  const [out2] = __sanitizeDrawingList([{ ...d, group: 42 }]) as Array<{ group?: string }>;
  assert.equal(out2.group, undefined);
});

test("lifecycle — create group, move members, dissolve, ids never leak", () => {
  let list = [mk("a"), mk("b"), mk("c")] as Array<{ id: string; group?: string; hidden?: boolean }>;
  list = moveToGroup(list, ["a", "b"], "g1");
  assert.deepEqual(groupMemberIds(list, "g1"), ["a", "b"]);
  list = bulkPatch(list, groupMemberIds(list, "g1"), { hidden: true });
  assert.equal(groupFlag(list, "g1", "hidden"), true);
  list = dissolveGroup(list, "g1");
  assert.equal(groupMemberIds(list, "g1").length, 0);
  assert.equal(list.filter((d) => d.hidden).length, 2); // states survived
});
