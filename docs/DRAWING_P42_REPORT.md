# PHASE 42 — Drawing Object Manager & Layer Management — Completion Report

**Date:** 2026-11-22 · Commit: see git log (pushed to `origin/main`).

## Existing architecture inspected (and reused)

- **Drawing engine** `client/src/lib/drawings.ts` — `Drawing` model already carried `name`, `hidden`, `locked`, `tfs`, `updatedAt`; sanitizer `__sanitizeDrawingList` keeps them; `effectiveName()` = user rename over tool type; `reorderDrawing()` = z-order (render order = array order).
- **Selection system** `PriceChart.tsx` — dual state `selectedDrawingId` (primary) + `selectedIds` (Ctrl/Shift multi) with the invariant "multi-select sets the last id as primary; single click clears multi" implemented in `DrawingCanvas` (Ctrl/Shift-click toggles, plain click selects, multi-selected group moves together). The tree plugs into exactly this invariant.
- **Persistence** `chart-persistence.ts` — per-symbol nodes `chart/{uid}/drawings/{symbol}` with LS mirror, 400 ms debounced RTDB writes, per-child diffed `update()`, deletion tombstones, LWW merge. The old "object tree" was an inline popover in `PriceChart.tsx` (rows + eye/lock/delete + window.prompt rename + jump-to-position scroll).

## What was built

### 1. Object Tree panel (`client/src/components/terminal/chart/ObjectTree.tsx`, new)
Full manager replacing the inline popover, hosted at `right-10 top-8` inside the chart area (`data-chart-ui`, does not block chart input; z-30, above chips, below the z-50 context menus). **Drag-resizable width** (240–460 px, persisted `it_tree_width`), header with object count, **Hide all / Show all / New group / Close**. Every row: real **tool icon** (`ToolIcon`), name, **TF badges**, visibility toggle, lock toggle (amber when locked). The templates & indicators sections (previously in the popover) render inside the same panel via `children` — zero feature loss.

### 2. Two-way selection sync
Click a row → selects on chart **and scrolls the time scale to the object's first anchor** (`locateDrawing`, extracted from the old row handler). Ctrl/Cmd/Shift-click → toggles in multi-selection (same invariant as the canvas). Chart selection → row highlights (`bg-sky-500/20`); **multi-selection highlights every selected row** (the old popover highlighted only the primary). Selection clears on instrument switch (existing behavior).

### 3. Visibility & locking
Per-object eye/lock (persisted on the drawing → survives refresh; locked objects stay visible and are excluded from hit-testing by the existing engine). Header **Hide all/Show all** writes `hidden` on every drawing (persisted per object — the LeftRail's separate global `hiddenAll` toggle is untouched). **Bulk delete never deletes locked objects.**

### 4. Groups & folders (`client/src/lib/drawing-tree.ts`, new — pure, unit-tested)
- `DrawingGroup { id, name, collapsed?, createdAt? }`; a drawing carries `group?: string` (undefined = Ungrouped root). **No virtual inheritance**: group hide/lock are bulk operations on members, so every state lives on the object, survives refresh and stays debuggable — deliberately avoiding the instability risk of nested groups (spec allowed this simplification; groups are one level, drawings inside).
- Create (header button / context-menu "＋ New group…"), **double-click rename (inline)**, expand/collapse (persisted on the group record), group eye/lock toggles with `groupFlag` "all-members" semantics, **Delete group with confirmation — members move back to Ungrouped, nothing is silently deleted**.

### 5. Multi-selection & bulk actions
Bulk bar: **Select all (filtered list), Duplicate (primary), Hide selected, Lock selected, Move to group (picker), Delete selected, selection counter with clear**. All bulk operations run through `bulkPatch`-style commits → history (undo) and persistence behave exactly like single edits.

### 6. Context menu (row + group)
Row: Rename · Edit properties (opens the DrawingPropsDialog) · Duplicate · Lock/Unlock · Hide/Show · **Move to group** (submenu: No group / each group / ＋ New group…) · Bring to front · Send to back · Delete. Group menu: Rename group · Hide/Show all members · Lock/Unlock all members · Delete group (confirm). Same non-capture outside-pointerdown/wheel/Escape closing pattern as `ChartContextMenu` (avoiding the capture-phase bug it fixed).

### 7. Search & filtering
Live name search + **category filter** (derived from the real palette via new `toolGroupTitle()` — Trend Lines, Fibonacci, Channels…; consistent with the left rail). Group sections hide when neither the group name nor any member matches.

### 8. Persistence & synchronization
- Drawings: names/visibility/lock/`group` persist in the existing per-symbol drawing nodes (sanitizer now keeps `group`, clamped 40 chars).
- Groups: **new RTDB node `chart/{uid}/groups/{symbol}`** + LS mirror `it_chart_groups_{uid}_{symbol}`, LS-first paint, 400 ms debounced RTDB writes, corrupted payloads sanitized (`sanitizeGroups` — key = id, name required, collapsed/createdAt validated). Isolation: per user + per instrument (path), timeframes remain per-drawing (`tfs` badges shown). No extra reads on the chart hot path (one `onValue` per symbol switch).

## Testing

- `npx tsc --noEmit` — clean.
- `npm test` — **372/372 pass** incl. **9 new**: group sanitization (corruption, clamps, key-based ids), move/dissolve/bulk-patch purity, member ids, group-flag semantics (empty group never "all hidden"), drawing-sanitizer round-trip of `group`, and a full create→move→hide→dissolve lifecycle.
- `npm run build` (vite) ✓ · `npm run build:api` ✓.
- Browser smoke: production build via `vite preview`, headless Chromium 1440×900 — app boots, **zero console/page errors**. The terminal is Firebase-auth gated in the sandbox (no credentials), so the 12 interactive scenarios were verified at the level available: tool logic unit-tested (pure helpers), UI wiring type-checked and mounted in the real panel; interactive drag/click verification needs a logged-in session — same honest limitation as P40/P41.

## Files changed / added

**New:** `client/src/lib/drawing-tree.ts`, `client/src/components/terminal/chart/ObjectTree.tsx`, `tests/p42-object-tree.test.ts`.
**Modified:** `client/src/lib/drawings.ts` (`group` field + sanitizer) · `client/src/lib/chart-persistence.ts` (groups subscribe/save) · `client/src/components/terminal/PriceChart.tsx` (ObjectTree panel, groups state, patch/locate/duplicate callbacks, context menu reuse) · `client/src/components/terminal/chart/LeftRail.tsx` (`toolGroupTitle`) · `tests/p42-object-tree.test.ts`.

## Protection checklist
Existing drawing tools, Long/Short Position (P41), Favorites toolbar (P41), Fibonacci tools, chart rendering/historical data, indicators/watchlists, auth/Firebase, trading features, robots.txt/sitemap/canonical URLs — untouched; templates & indicators preserved inside the new panel.

## Remaining limitations (honest)
1. Groups are single-level (spec allowed avoiding nested-group instability).
2. Interactive in-browser clicking of the tree requires a Firebase session (sandbox has none) — helpers are unit-tested; UI is type-checked and smoke-booted.
3. Panel width persists per browser (not per user in RTDB) — deliberate, it's device UI state.
4. Row click always jumps to the object; a "jump only when off-screen" refinement is future work.
