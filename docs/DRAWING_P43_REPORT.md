# PHASE 43 — Complete Mobile Experience — Completion Report

**Date:** 2026-11-22 · Commit: this commit on `main` (pushed to origin).

**Critical incident handled first:** the sandbox recycled between turns and the local repo had been reset to the P40 snapshot (P41/P42 commits missing locally, work deleted from disk). The commits were intact on `origin/main`; the working tree was restored via `git stash (P43 WIP) → git reset --hard origin/main → git stash pop` with a clean, conflict-free reapplication. Final state verified: P41 + P42 files present, **372/372 tests pass, tsc clean, both builds green**.

## PART 1 — Audit findings (code recon + headless rendering)

Rendered scan at 320/360/375/390/414/430/1440 of public routes found **no page-level horizontal overflow** on the landing/news/market/auth pages (`scrollWidth === innerWidth` at all widths). Auth-gated surfaces were audited in code (route-by-route), which found the real issues:

| # | Issue | Root cause |
|---|---|---|
| 1 | Tall dialogs (incl. Daily Rewards) clip top/bottom on phones | `ui/dialog` primitive centers with translate and has **no max-height/overflow guarantee**; DailyRewardDialog adds fixed `max-w-md` with no scroll |
| 2 | Terminal panels unusable <1024px | `TerminalShell` stacked branch renders chart+panel+blotter with no tabbing/sizing; desktop pixel widths (`w-[860px]` settings, `w-[210px]` symbol button, `w-[150px]` account select) leak into narrow layouts |
| 3 | Sideways drift risk from wide tables | `min-w-[720px]/[640px]` blotter tables, `min-w-[760px]` calendar, `min-w-[540px]` leaderboard (some already wrapped, blotter was not) |
| 4 | No touch-visible panel controls | TerminalShell divider collapse buttons were `opacity-0 group-hover:opacity-100` — invisible on touch |
| 5 | No mobile nav surface | Header nav strip only (scrollable pills below `xl`); no bottom navigation; `sheet.tsx`/`drawer.tsx` shipped unused |
| 6 | Floating chat overlaps any bottom UI | `fixed bottom-5 end-5` trigger |
| 7 | Zero safe-area handling despite `viewport-fit=cover` | no `env(safe-area-inset-*)` anywhere |
| 8 | Performance: 5 of 7 infinite theme-background animations lacked `prefers-reduced-motion` guards | CSS keyframes on `body::before/::after` |
| 9 | Fixed-width overlays | PriceChart indicator store panel `w-96` with no max-width guard; NotificationBell `w-80` unguarded |

Viewmeta was already correct (`width=device-width, initial-scale=1.0, viewport-fit=cover`, no user-scalable=no) — **SEO/mobile meta untouched**.

## Files changed

**New:** `client/src/components/layout/MobileTabBar.tsx` — dedicated mobile navigation (see PART 3).
**Modified:** `App.tsx` (tab bar in AppLayout + bottom padding) · `Navbar.tsx` (strip starts at md; phones use tab bar) · `ui/dialog.tsx` (viewport-fit guarantee) · `rewards/DailyRewardDialog.tsx` · `layout/NotificationBell.tsx` · `terminal/TerminalShell.tsx` (tabbed mobile branch + touch-visible dividers) · `pages/TerminalPage.tsx` (height + toolbar touch sizing + TF strip scroll) · `terminal/TradingBlotter.tsx` (3 tables in scroll containers) · `terminal/TerminalSettingsDialog.tsx` + `InstrumentExplorer.tsx` (fluid `min(px,dvh/vw)` sizes) · `terminal/PriceChart.tsx` (indicator panel max-width) · `chat/GlobalChat.tsx` (floats above tab bar) · `dashboard/StatsCards.tsx` (user request: the Total Net PNL / Win Rate / Total Trades cards now use a near-invisible `bg-card/[0.08]` + hairline border instead of `glass-panel`, so the theme shows through) · `index.css` (mobile clip guard + safe-area utilities + reduced-motion guards) · `lib/language-context.tsx` (`more` key ×4 languages).

## Mobile navigation (PART 3)
Bottom tab bar (`md:hidden`): **Dashboard · Terminal · Market · News · Wallet · More**, 56px touch targets, active tint + top indicator, `env(safe-area-inset-bottom)` padding. "More" opens a **bottom sheet** (the previously-unused shadcn `Sheet`) with Prop Firm, Rewards, Leaderboard, Profile, Inventory, Titles, Public profile, Premium, Settings, Admin — 80px grid tiles, active-state aware. The desktop header pill bar is unchanged; the md–xl header strip keeps its old behavior.

## Dialogs (PART 4)
`DialogContent` now guarantees `max-h-[calc(100dvh-1.5rem)] overflow-y-auto` + `p-4 sm:p-6` — **every** dialog using the primitive (Daily Rewards, journal, confirmations, …) can no longer clip. DailyRewardDialog additionally scrolls internally with reduced padding on phones; TerminalSettings (860px) and InstrumentExplorer (620px) are now `min(px, dvh/vw)` fluid. Notifications panel is width-guarded.

## Mobile terminal (PART 5)
`TerminalShell` <1024px branch rebuilt: **chart stays primary** (`min-h-[220px] flex-1`), below it a touch-sized tab strip — **Watchlist · Trade · Alerts · Info · Positions** — rendering ONE docked panel in a `h-[min(45dvh,380px)]` scrollable sheet (tap the active tab to hide it and give the chart the space). Syncs with the desktop panel state; no desktop pixel widths in the branch. Toolbar: symbol button `150px→210px` responsive, account select `120→150px`, TF row **horizontally scrollable** (hidden scrollbar, shrink-0 buttons), page height drops the phone-hostile `min-h-[640px]`. Chart itself: lightweight-charts defaults already provide **touch pan + pinch-zoom** (no `handleScale/handleScroll` overrides), `autoSize` fits container; `DrawingCanvas` is **pointer-events based** (works with touch, incl. Long/Short handles, Favorites, ObjectTree). Price/props overlays got max-width guards so controls don't cover candles.

## Other modules (PART 6)
Journal/TradeTable was already scroll-wrapped; Prop Firm tables wrapped; Leaderboard/Calendar wrapped (pre-existing). Rewards/Profile/Settings/Market/Premium grids audited — already responsive-safe. Blotter tables (positions/orders/history) now each sit in an `overflow-x-auto` container.

## Touch & performance (PARTS 7–8)
Touch targets ≥40px in nav/tab surfaces; no hover-only blockers remain (divider collapse buttons visible at `opacity-60` on touch, hover-only on `md+`); dialogs scroll, not clip; chat trigger lifted above the tab bar. `overflow-x: clip` on `body` ≤640px as a final safety net (root causes fixed individually first; `clip` unlike `hidden` creates no scroll container). Reduced-motion guards added for all 5 unguarded infinite theme animations. No extra Firebase listeners added (tab bar uses existing hooks only).

## Testing
- `npx tsc --noEmit` — clean. `npm test` — **372/372** (incl. the 9 P42 object-tree tests restored with the base). `npm run build` ✓ · `npm run build:api` ✓.
- Headless Chromium: 375×667 and 1440×900 — zero console/page errors, `scrollWidth === innerWidth` (no sideways drift) on rendered routes.
- Honest limitation: Firebase auth gates the terminal/journal/etc in the sandbox (no test credentials), so the tab bar, terminal tabs and dialog fixes on authed pages are verified by type-check, build and code review rather than logged-in clicking — same constraint as earlier phases; real-device (Android/iOS) passes remain for the deployment environment.

## Protection checklist
Desktop layouts untouched below md (all mobile changes are `md:`-scoped additions or new components); drawing tools, Long/Short, Favorites, Fibonacci, ObjectTree, indicators, watchlists, auth/Firebase, trading execution, robots.txt/sitemap/canonical URLs/metadata — unchanged. No noindex introduced.

## Remaining limitations
1. Authed-page interactions not click-verified in sandbox (no credentials) — build/type/unit verified.
2. Desktop settings/explorer dialogs use fluid caps (96vw) — at very narrow landscape they shrink; content scrolls.
3. Pinch-zoom and touch-drawing rely on lightweight-charts + pointer-events defaults (already enabled); a dedicated touch hit-target enlargement pass for drawing handles is future work.
4. Real-device testing (Android Chrome / iOS Safari) to be done on the deployed URL.
