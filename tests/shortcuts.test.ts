import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBinding, formatBinding, matchesShortcut, findConflicts,
  SHORTCUT_DEFS, DEFAULT_SHORTCUTS,
} from "../client/src/lib/shortcuts.ts";

test("P55: normalizeBinding canonicalizes modifier order and case", () => {
  assert.equal(normalizeBinding("K+CTRL"), "ctrl+k");
  assert.equal(normalizeBinding("Shift+Alt+B"), "alt+shift+b");
  assert.equal(normalizeBinding("CTRL+z"), "ctrl+z");
  assert.equal(normalizeBinding("D"), "d");
  assert.equal(normalizeBinding(""), ""); // empty = unset
  assert.equal(normalizeBinding("ctrl"), ""); // modifier alone is not a binding
  assert.equal(normalizeBinding("ctrl+k+alt"), "alt+ctrl+k"); // extra modifier is folded in
});

test("P55: formatBinding renders human-readable labels", () => {
  assert.equal(formatBinding("shift+b"), "Shift+B");
  assert.equal(formatBinding("ctrl+z"), "Ctrl+Z");
});

test("P55: matchesShortcut compares modifiers and key exactly", () => {
  // node has no DOM KeyboardEvent — a plain object duck-typed to the event is enough
  const ev = (init: Record<string, unknown>) => ({ key: init.key, ctrlKey: !!init.ctrlKey, altKey: !!init.altKey, shiftKey: !!init.shiftKey, metaKey: !!init.metaKey } as unknown as KeyboardEvent);
  assert.equal(matchesShortcut(ev({ key: "b", shiftKey: true }), "shift+b"), true);
  assert.equal(matchesShortcut(ev({ key: "B", shiftKey: true }), "shift+b"), true); // case-insensitive key
  assert.equal(matchesShortcut(ev({ key: "b" }), "shift+b"), false); // missing shift
  assert.equal(matchesShortcut(ev({ key: "z", ctrlKey: true }), "ctrl+z"), true);
  assert.equal(matchesShortcut(ev({ key: "z", ctrlKey: true, metaKey: true }), "ctrl+z"), false); // extra meta
  assert.equal(matchesShortcut(ev({ key: "t" }), ""), false); // unset binding never fires
});

test("P55: findConflicts detects duplicates", () => {
  const conflicts = findConflicts({ a: "shift+b", b: "SHIFT+B", c: "ctrl+z", d: "" });
  assert.deepEqual(conflicts, [["a", "b"]]);
});

test("P55: defaults are valid bindings and unique", () => {
  const seen = new Set<string>();
  for (const d of SHORTCUT_DEFS) {
    if (!d.def) continue; // "" = no default (must be customized)
    const n = normalizeBinding(d.def);
    assert.ok(n, `default for ${d.action} must normalize (${d.def})`);
    assert.ok(!seen.has(n), `duplicate default binding: ${n}`);
    seen.add(n);
  }
  assert.equal(SHORTCUT_DEFS.length, Object.keys(DEFAULT_SHORTCUTS).length);
});
