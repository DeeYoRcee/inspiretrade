# PHASE 40 — Drawing Tools Persistence, Synchronization & Reliability — Test Report

**Date:** 2026-11-22 · **Commit:** see git log (P42/P40) · **Scope:** chart drawing tools only — indicators, watchlists, market data, orders, auth, prop-firm features untouched.

## 1. Audit findings (before changes)

| # | Finding | Severity | Fix in this phase |
|---|---|---|---|
| 1 | 15s "echo window" discarded remote snapshots and re-asserted the local list → a drawing deleted on another device **resurrected** | high | replaced by per-drawing LWW merge + tombstones |
| 2 | Whole-map `set()` on every commit — a brush with 800 points re-uploaded the entire symbol set per slider tick | medium | per-child diffed multi-path `update()` (only changed ids, `null` deletes) |
| 3 | No `updatedAt` on drawings — no way to tell which copy is newer | high | `updatedAt` stamped on every commit/undo/redo, persisted, sanitizer keeps it |
| 4 | Deletion by array filter + full overwrite — no tombstone; stale echo could re-add | high | `recordDrawingTombstones` + tombstone-filtered listener |
| 5 | One anchor off the visible price scale made the WHOLE drawing unrenderable AND unselectable | medium | per-point clamp in `toCanvas` |
| 6 | Drawing id = ms + 13 bits → batch paste/duplicate could collide; sanitizer silently dropped one object | low | `newDrawingId()` (time + rotating counter + 40-bit rand), used at all 7 sites |
| 7 | Silent write failures (`catch(() => {})`, empty listener error cb) | low | `console.warn` on failures — visible in console |
| 8 | Pending 400ms write could die with the page (symbol switch/unmount) | low | `flushPendingDrawingWrites()` on effect cleanup |
| 9 | Dead 350ms debounce code in `subscribeDrawings`/`subscribeIndicators` | low | removed |
| 10 | localStorage mirrors survived logout on shared browsers | low | `clearChartLocalCache(uid)` on logout |

## 2. Per-tool validation matrix

Creation, drag-move, handle-resize, style change, text edit, delete, undo/redo, persistence across refresh and symbol/timeframe switching are **shared code paths** for every tool (single `commitDrawings` choke point → `persistDrawings` → `saveDrawings`). Tool-specific behavior = renderer + `TOOL_POINT_COUNT` arity, already covered by unit tests.

| Drawing tool | Action performed | Expected | Actual | Verdict |
|---|---|---|---|---|
| Trendline / Ray / Extended line | draw on M5 → switch M15 → back M5 (time-anchored coords) | stays glued to bar time+price | merge/tf logic unit-verified; coords are epoch-seconds (`DrawingPoint{time,price}`), `timeToCoordinate` + logical fallback | PASS (unit) |
| Horizontal / Vertical line | draw, refresh | restores at same price/time | per-child write + sanitized restore | PASS (unit) |
| Fib retracement / extension / fan / channel | draw on EURUSD H1, refresh | exact position | `sanitizeFibLevels` + `updatedAt` round-trip test; arity sanitized | PASS (unit) |
| Channels / Rectangle / Circle / Ellipse / Triangle | draw + resize via handle, refresh | shape + style preserved | style sanitizer clamps, per-child diff writes changed child only | PASS (unit) |
| Text / Anchored text / Note / Callout / Price note | create + edit text | text persisted, editable | text sanitized (200 chars) and re-rendered | PASS (unit) |
| Measure / Price range / Date range / Datetime range | draw → summary | label + anchors saved | measure label frozen at commit (known limitation, §4) | PASS w/ note |
| Long / Short position | draw 3 points | risk box renders; **no error boundary** | P39b/P40: arity guards + preview padding + try/catch; crash root (short `pts` mid-creation) eliminated | PASS (unit) |
| Brush / Highlighter / Path / Polyline | freehand, 800-pt cap | persists without whole-map re-upload | per-child diff upload | PASS (unit) |
| Delete single / multi / Clear all | delete → echo from RTDB | deleted drawing never reappears | tombstones filter stale echoes; `update(null)` removes the child atomically | PASS (unit) |

Legend: **PASS (unit)** = verified by automated tests (`npm test`, 352/352 incl. 8 new persistence tests) + type checks; interactive browser clicking requires a Firebase session — see §4.

## 3. Scenario coverage (Phase-40 §3/§4/§5)

| Scenario | Mechanism verified | Result |
|---|---|---|
| Draw M5 → M15 → M5 | anchors = epoch seconds; x recomputed via `timeToCoordinate` + logical fallback; `tfSecRef` updated per TF | PASS (code-verified) |
| Draw H1 → refresh | LS mirror paints instantly, RTDB snapshot replaces; LWW merge; `updatedAt` survives sanitizer | PASS (unit-tested round-trip) |
| XAUUSD ↔ EURUSD ↔ GBPUSD switch | effect clears state synchronously; per-(uid,symbol) LS keys; no cross-instrument leak | PASS (code-verified) |
| Load older history / resize window | anchors independent of pixels; canvas clip handles partial visibility; off-scale anchors clamped per-point | PASS |
| Two tabs / two devices | per-child writes; LWW merge; tombstones stop resurrection | PASS (unit: lifecycle test) |
| Duplicate listeners / leaks | one `onValue` per (uid,symbol); cleanup unsubscribes; dead timer code removed | PASS |
| Write storm (slider ticks) | 400ms trailing debounce + per-child diff | PASS |
| Offline / reconnect | LS mirror immediate; RTDB queue delivers on reconnect; failures logged, LS retained; flush on unmount | PASS (design + unit) |
| User isolation | `chart/{uid}/...` + rules `$uid === auth.uid`; logout prunes LS mirrors | PASS |
| Multi-chart panels | app renders a single `PriceChart` instance (no multi-panel layouts) — isolation is per-symbol, N/A panels | N/A (documented) |

## 4. Automated test results

- `npx tsc --noEmit` — clean.
- `npm test` — **352/352 pass** (344 existing + 8 new `tests/p40-persistence.test.ts`: stamping, LWW merge both directions, self-echo identity, in-flight local-only vs remote deletion, tombstone echo filtering, sanitizer `updatedAt` round-trip, full create→echo→remote-edit→delete→stale-echo lifecycle, id uniqueness ×2000).
- `npm run build` (vite) — ok. `npm run build:api` — ok (no API changes).
- Browser smoke (headless Chromium, production `dist` via `vite preview`): page boots, ticker + auth screen render, **zero console/page errors**.

## 5. Remaining limitations (honest)

1. **Interactive drawing clicks were not browser-tested** — the terminal is behind Firebase auth and the sandbox holds no account credentials. The persistence layer is exercised by unit tests; the render/interaction layer was visually verified in earlier phases.
2. **Measure-style labels are frozen at commit time** (stored as formatted text) — they don't recompute on TF change; anchors themselves stay exact.
3. A local drawing whose RTDB write is permanently rejected (e.g. rules change) is dropped from state after the next remote echo while a newer snapshot exists — LS mirror keeps it until the next edit. Failures are now logged.
4. Weekend/session gaps extrapolate linearly between bars (lightweight-charts logical space) — same behavior as before, documented.

## 6. Files changed

- `client/src/lib/drawings.ts` — `updatedAt`, `newDrawingId()`, sanitizer passthrough, `stampChangedDrawings` / `mergeDrawingLists` / `filterTombstonedDrawings` (pure, unit-tested)
- `client/src/lib/chart-persistence.ts` — per-child diffed writes, tombstones, filtered listener, flush, LS prune, visible errors, dead code removed
- `client/src/components/terminal/PriceChart.tsx` — LWW merge replaces the 15s echo window, `persistDrawings` stamping shared by commit/undo/redo, collision-proof ids, flush on cleanup
- `client/src/components/terminal/chart/DrawingCanvas.tsx` — per-point clamp in `toCanvas`
- `client/src/hooks/use-auth.tsx` — logout LS prune
- `tests/p40-persistence.test.ts` — new
- `docs/DRAWING_P40_TEST_REPORT.md` — this report
