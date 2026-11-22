# PHASE 46 — TradingView-Grade Long/Short Position Tools & Magnet Mode — Report

**Date:** 2026-11-22 · Includes the 4 user UI tweaks requested alongside.

## 1. Root causes identified (previous behavior)

| Problem | Root cause (anchored) |
|---|---|
| Position creation felt clunky (3 clicks) | `TOOL_POINT_COUNT = 3` appended a point per click; no side-aware derivation — the user had to place all three levels by hand |
| Levels landed on arbitrary prices | The drawing layer never consumed `tickSize` (the spec field existed in `shared/terminal.ts` but was unused); raw `coordinateToPrice` floats were stored |
| Drags could invert the position | `onPointerMove` handle branch wrote raw cursor price — stop could cross entry with one pixel |
| Magnet "didn't work" | It only snapped the CROSSHAIR (native `CrosshairMode`) and NEW anchors at creation; **drags/resize never snapped** (`DrawingCanvas.tsx` old comment: "dragging existing drawings never snaps"); single fixed 12px threshold; no visual feedback; no strong mode |
| No axis price labels | Level labels were in-canvas text only; nothing on the price scale |

## 2. Files changed and what matters

**`client/src/lib/drawings.ts`** — new pure, unit-tested helpers: `snapToTick` (tick rounding with float-noise strip), `clampPositionPrice` (directional integrity: long stop ≤ entry−tick, target ≥ entry+tick, short mirrored), `createPositionFromGesture` (ONE press-drag-release OR two clicks: the drag's side picks stop vs target, the other level mirrors via the universal reflection 2·entry−drag — 1:R by construction; all levels tick-snapped), `MAGNET_PX {normal:12, strong:36}`, `magnetModeOf` (legacy boolean → 3-state migration). Renderer: 2-point live 1:R preview during creation; header block now honours `showLabels:false`.
**`client/src/components/terminal/chart/DrawingCanvas.tsx`** — position creation special-case (press→drag→release derive + click-click fallback); **drag magnet** (the dragged anchor only: position levels snap price to real bar OHLC then tick+clamp; band edges snap time to the containing bar's open; hline/text price-only, vline time-only); snap-flash ring overlay; **post-clip TradingView price-axis tags** for Entry/Stop/Target on the price scale; flash cleanup on every gesture end.
**`client/src/components/terminal/chart/dialogs.tsx`** — `ChartSettings.magnetMode?: 0|1|2`, default `1`, settings checkbox re-wired; `magnetModeOf` re-exported.
**`client/src/components/terminal/PriceChart.tsx`** — crosshair = `Magnet` when mode>0; rail cycle wiring; `renderEnv` now carries `tickSize`; per-tool defaults persist `riskPct`.
**`client/src/components/terminal/chart/LeftRail.tsx`** — magnet control is a **3-state cycle** (OFF → ON → STRONG), amber badge marks STRONG, tooltips updated.
**`client/src/components/terminal/chart/DrawingPropsBar.tsx`** — Entry/Stop/Target inputs snap to tick on edit; (see §4 for the removed controls).
**`client/src/lib/drawing-defaults.ts`** — `riskPct` is a persistable per-tool default for position tools (sanitized 0.01–100).
**`client/src/components/terminal/TerminalSettingsDialog.tsx`, `InstrumentSettingsPanel.tsx`** — magnet toggles drive the 3-state mode.
**`tests/p46-position-magnet.test.ts`** — 13 tests (see §6). UI tweaks files: `theme-context.tsx`, `LeftRail.tsx`, `FavoritesToolbar.tsx`, `ChartToolbar.tsx`, `ObjectTree.tsx`, `DrawingPropsBar.tsx`, `PriceChart.tsx`.

## 3. Calculations & instrument specs verified

`positionCalc` math re-verified against `shared/terminal.ts` specs: XAUUSD (digits 2, pip 0.1, contract 100, tick 0.01) — 1% risk on $10k over a 30.00 stop → **0.03 lots, risk $100 / reward $100**; EURUSD contract 100000; NAS100 tick 0.25 rounding; BTCUSD contract 1. Money fields appear ONLY when `contractSize > 0 && balance > 0` — never fabricated (live balance flows only in live mode, replay shows "—"). RR = reward/risk; risk/reward % of entry price; pips = distance/pipSize. **Harness evidence** (`/tmp/render/p46-harness.png`, also in `download/`): Long 1,000/970/1,030 → RR 1.00 · 0.03 lots · Risk $100 / Reward $100; Short 1,002/1,020/984 → 0.08 lots · $150/$150 — both correct.

## 4. The 4 requested UI tweaks (done)

1. **Theme renamed**: "Darth Vader" → **"Skywalker"** (`THEME_LABELS`; CSS key `vader` kept so saved user prefs survive; poster/animations untouched).
2. **4 z-order buttons removed** from the drawing properties bar (Bring forward / Send backward / Bring to front / Send to back). Reorder remains available in the object-tree row context menu (front/back). Note: z-order is array order and does not survive reload (pre-existing limitation, unchanged).
3. **3 endpoint-label toggles removed** from the trend section (`$`/`Δ`/`T`).
4. **Sizes up**: drawing rail 44px→48px wide, rail buttons 32→36px, icons 18→20px, submenu tiles 28→32px, favorites toolbar 32→36px; terminal chrome: ChartToolbar buttons 24×28→28×32 with 16px icons, props-bar action buttons 20→24px, object-tree header/row icons 12–14→14–16px.

## 5. Browser testing — actual results

- **Render harness (real browser, Chromium)**: production `renderDrawing`/`positionCalc`/`createPositionFromGesture`/`snapToTick`/`magnetSnapPrice`/`fmtPositionPrice`/`positionAnchors` bundled via esbuild and driven on a canvas with a synthetic XAUUSD-like series + candles. Evidence `p46-harness.png`: correct green/red geometry for both directions, Entry/Stop/Target labels, % + pip labels, RR/size/money header, 5 semantic handles, price-axis tags for all 6 levels, magnet flash ring snapped to a real bar high ("snap → 1,016.00").
- **Landing regression smoke (375px & 1440px)**: no horizontal overflow, no console errors, SEO title intact.
- **Honest limitation — full interactive flow**: `/terminal` is gated by Firebase auth AND mandatory email verification; a headless signup cannot receive the verification email, so the pointer-gesture suite (create/drag/resize inside the live app) could not be executed in this sandbox. Everything those gestures execute is covered by unit tests (gesture derivation, clamps, magnet thresholds, migration) + the render harness. The interactive checklist (long/short drag tests, magnet on live data, mobile touch) remains for the owner's signed-in session — steps in §4 of the previous phase's docs still apply, plus: cycle the magnet rail button (OFF→ON→STRONG), draw a trendline near a candle high (cursor snaps + flash ring), drag a position level (snaps to OHLC, cannot cross entry).

## 6. TypeScript / build / tests

`npx tsc --noEmit` clean · `npm run build` ✓ (14.2s) · `npm test` **404/404 pass, 0 fail** (391 + 13 new). The tests caught and fixed two real bugs: float noise in `snapToTick` (1.2345700000000002) and an inverted SHORT mirror in the first gesture implementation.

## 7. SEO / project protection

No route, metadata, robots.txt or sitemap changes; no removed drawing tools (all ~70 tools intact); favorites, object manager, groups, templates, fib presets, per-tool defaults, undo/redo, persistence (LWW + tombstones) untouched and still tested.
