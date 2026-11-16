# InspireTrade Terminal Rebuild — Technical Audit & Implementation Roadmap

> Audit date: 2026-11-16 · Evidence commit: 1c867c6 · Status: **for sign-off — no implementation started**
> Scope: trading terminal domain only (chart, market data, execution, accounts). No MT5, no broker, no paid platform; all balances virtual; website outside the terminal untouched.


## 1. Executive Summary

This document is the requested technical audit of the InspireTrade trading terminal and the implementation roadmap for rebuilding it into a professional, fully functional simulated trading platform. It is based on a line-by-line inspection of the current codebase carried out on 2026-11-16, including the chart implementation, the trading hooks, the Firebase layer, the serverless API, and the deployment configuration. No code was changed for this audit; the document is the decision basis for the rebuild that follows.

The verdict in one sentence: InspireTrade today has a genuinely real charting surface (TradingView Lightweight Charts on real market data) wrapped around a trading core that cannot be trusted as a product. Order execution happens entirely inside the user's browser, balances and positions are written by the client directly into Firebase Realtime Database, Stop Loss and Take Profit levels on the live demo account are stored but never evaluated, pending orders execute instantly at the requested price instead of waiting for the market, and the prop-firm offering is a marketing page rather than a functioning product. At the same time the terminal user interface re-renders wholesale on every market tick, which is the direct cause of the perceived sluggishness.

The rebuild replaces the trading core with a server-authoritative simulated engine on Firebase Firestore, keeps Lightweight Charts as the rendering layer, keeps crypto (Binance) and gold spot as live data sources, adds a server-side price service for execution, and introduces multi-user isolated virtual accounts of type DEMO and PROP. The legacy terminal surface is deleted at cutover after the new one ships behind the same route. The roadmap is split into six phases with acceptance criteria per phase and an estimated effort of 16 to 23 working days.

Constraints honoured throughout the plan: no MT5, no broker, no paid trading platform integration; every account balance is virtual; the website outside the terminal is not redesigned; and no feature is declared working until it is implemented and covered by the tests listed in the Definition of Done (section 10).


## 2. Scope, Method and Evidence Base

Scope covers the terminal domain only: market data feeds, chart rendering, trading execution, account state, prop-firm challenge logic, replay practice tooling, and the Firebase structures backing them. The InspireTrade website outside the terminal (wallet, rewards, cases, music, profile, blog surfaces) is explicitly out of scope and is not redesigned.

Method: static inspection of source files with line counts, tracing of the live data path (WebSocket and polling) from provider to chart pixel, tracing of the order path from the trading panel button to the database write, enumeration of every Firebase Realtime Database node the terminal touches, bundle analysis of the production build, and reachability tests of the market data endpoints from an external network.

Evidence highlights that the findings in section 4 reference: the terminal domain spans roughly 12,900 lines of TypeScript across 30+ files, with the two largest files being TerminalChart.tsx at 1,351 lines and TerminalPage.tsx at 1,286 lines. The production bundle ships a 1.8 MB main JavaScript chunk out of a 5.1 MB dist directory. The stack is React 18.3.1, Vite 7.3.0, TypeScript, lightweight-charts 4.2.3, Firebase 12.9.0 (Auth plus Realtime Database; Firestore is not used anywhere in the repository), TanStack Query 5.60.5, Tailwind 4, and the Whop SDK 0.0.40 for subscriptions. The server is a set of Vercel serverless functions under api/ (quotes, market, news, wallet, cases, rewards, referral, admin, whop, alerts-cron, push) built from api/_src TypeScript sources; there is no trading endpoint of any kind on the server today.


## 3. Current Architecture (as-is)

The terminal is a single-page React application served statically by Vercel, with serverless functions acting only as data proxies. Everything that constitutes trading happens in the browser. The table below summarises each layer, its implementation, and the audit verdict.

**Table 1. Layer-by-layer inventory of the current terminal**

| Layer | Implementation today | Key files | Audit verdict |
| --- | --- | --- | --- |
| Chart | lightweight-charts 4.2.3, one component for chart + drawings + replay + overlay + legend + menus | TerminalChart.tsx (1,351 ln) | Rendering is sound; component is a monolith and re-renders too much |
| Trading page | Single orchestrator component with 20+ useState hooks, keyboard shortcuts, alerts, challenge, workspace | TerminalPage.tsx (1,286 ln) | Re-renders wholesale on every tick; must be split |
| Market data | Client providers: BinanceProvider (combined-stream WS with 3-endpoint failover, REST mirror failover, 2s guarded poll), QuotesProvider via /api/quotes to Yahoo Finance | data-feeds.ts (464 ln) | Crypto and gold spot are live; forex and indices are 5-15 min delayed by source |
| Execution | Demo adapter executes orders instantly at the requested price, in the browser | use-terminal-trading.ts (250 ln) | Client-authoritative; insecure; no spread, slippage, commission, stop-out |
| Account state | Firebase Realtime Database node per user; balance, dayStart map, positions written by the client | terminalDemo/{uid} | Forgeable by the user; single DEMO account; no isolation model for products |
| Trading journal | Manual trade entries with zod schema, screenshots as base64, stats by period | use-trades.ts (237 ln), trades/{uid} | Functional; independent of engine fills (reconnect planned) |
| Replay 2.0 | Deterministic client-side engine over deep real history; challenge rules evaluated in-browser; sessions saved to RTDB | use-replay.ts (346 ln), replay-engine.ts (340 ln) | Good practice tool; stays client-side by design, but is not a prop product |
| Prop firm | Static marketing page with sample challenges; purchases not implemented | PropFirmPage.tsx | No product; Whop integration exists for site premium only |
| Auth | Firebase Auth: email/password and Google popup or redirect | use-auth.tsx, AuthPage.tsx | Adequate; reuse as-is |
| Server | Vercel functions: quotes, market, news, wallet, cases, rewards, referral, admin, whop, alerts-cron (one daily cron) | api/_src/** | No trading surface; will host the new engine |

Realtime Database nodes touched by the terminal domain: terminalDemo, trades, terminalReplaySessions, terminalReplayAchievements, terminalDrawings, terminalAlerts, terminalScreener, terminalSettings, instrumentCatalog, plus site-wide nodes (users, usernames, publicProfiles, economy, inventory, chat, screenshots, siteStats, claims, depositRequests, withdrawals). Only instrumentCatalog and market are read-mostly reference data; everything else is client-written user state.


## 4. Audit Findings: Why the Terminal Underperforms

Findings are grouped by impact and each carries an identifier used throughout the roadmap. The two most consequential are F1 (client-authoritative trading) and F2 (Stop Loss and Take Profit never evaluated on the live account), because any paid prop-firm product built on the current core would be both insecure and functionally broken.


### 4.1 Trust and correctness of the trading core

F1 - Client-authoritative execution. Orders are accepted and filled by the demo adapter inside the browser and the resulting balance and position changes are written straight to Realtime Database by client code. There is no server validation of order size, margin, spread, or market price at fill time. Any authenticated user can open the browser console and write arbitrary values to their own terminalDemo node - for example setting the balance to any number - because the database rules must grant the client write access for this design to work at all. A trading platform whose profit figure is a user-editable database field cannot host a paid challenge.

F2 - Stop Loss and Take Profit are never evaluated on the live demo account. The DemoPosition records store sl and tp, and the trading panel lets the user set them, but a repository-wide search finds no code path that compares price against these levels and closes the position. The only periodic evaluator in the terminal (a 30-second loop in TerminalPage) evaluates price alerts, not orders. A user who sets a Stop Loss has no protection; a user who sets a Take Profit never gets filled automatically. Replay mode has its own deterministic per-bar evaluation, which is correct for practice but is a separate world from the live account.

F3 - Pending orders trigger instantly at the requested price. The demo adapter sets entry to the requested limit or stop price at submission time rather than waiting for the market to reach it. In effect a limit order is an instant fill at a price the user picked, which is impossible on any real venue and would make any challenge meaningless.

F4 - Single demo account, no account model. There is exactly one DEMO account per user with a hard-coded 100,000 starting balance. The schema has no concept of account templates, leverage per account, currency, phases, or breach state. Equity, used margin, free margin and floating P/L are computed client-side for display only; there is no margin check at order time, no margin call and no stop-out. Instrument metadata (contract size, pip size, digits) exists in shared/terminal.ts and is good, but nothing enforces it during execution.


### 4.2 Market data

F5 - Non-crypto instruments are delayed by source. Forex pairs and indices come from Yahoo Finance through the /api/quotes proxy with 5 to 15 minutes of delay; metals use futures symbols of the same source. Gold (XAUUSD) additionally paints the live spot price from a free gold API onto the current candle, so the last bar is live while history is delayed. Crypto via Binance is genuinely live. For the products the platform wants to sell - prop challenges on gold and majors - delayed execution data is disqualifying, and the audit treats server-side price sourcing for non-crypto as a first-class roadmap item rather than an afterthought.

F6 - No server-side price store. The server fetches Yahoo quotes on demand for the client and caches nothing material; the alert evaluator and the challenge logic both run in the user's browser and stop when the tab closes. A server-side engine needs a server-side price service with its own cache and its own sources, so that fills, Stop Loss checks and drawdown calculations do not depend on whether a particular user has the tab open.


### 4.3 Performance

F7 - Whole-page re-render on every tick. The primary chart reports each live bar through onLastBar, which calls setPrices on TerminalPage state. Because TerminalPage renders the entire terminal (toolbar, market watch, trading panel, challenge dashboard, alerts, replay tab, chart grid), every WebSocket tick re-renders the whole page tree. This is the single largest runtime cost and the main reason the terminal feels heavy compared with TradingView.

F8 - Full indicator recomputation per tick. Inside updateLive, for every active indicator the code calls the indicator compute function over the entire bar array to update only the last point, and it does so on two separate paths (overlay indicators and pane indicators). With three indicators on a 1,000-bar series this is roughly 3,000 data-point computations per tick per chart, repeated for every open chart in multi-chart layouts.

F9 - Array copy and sort per tick. The upsert helper clones the whole series (up to 3,000 bars) and re-sorts it on every incoming update, per chart. Combined with F7 and F8 this puts the main thread into constant garbage-collection churn during volatile markets.

F10 - No render isolation. TerminalPage holds more than twenty useState hooks; panel components receive recreated object and function props each render; there are no memo boundaries between tick-heavy regions (prices, chart) and static regions (tools, settings, dialogs). Chart-grid render functions are re-created per render, defeating child memoisation.

F11 - Bundle weight. The main chunk is 1.8 MB (5.1 MB dist total). Third-party heavies outside the main chunk (hls.js, jspdf, html2canvas) are already split, but the application itself is monolithic: the terminal, music player, wallet, blog and admin surfaces all live in the main chunk. Route-level code splitting would cut the terminal's first-load cost substantially.


### 4.4 Architecture and maintainability

F12 - Monolith components. TerminalChart.tsx mixes at least six concerns (series management, drawing-tools engine glue, replay slicing, session overlays, legend and menus, status surfaces) and TerminalPage.tsx orchestrates alerts, challenge, workspace persistence, keyboard shortcuts and four side panels in one file. Every fix risks breaking unrelated behaviour; the rebuild splits both along those seams.

F13 - State scattered across three stores. Terminal settings, drawings and workspace live in Realtime Database; server-ish data lives in TanStack Query; transient UI state lives in component useState. Trading state specifically has no single source of truth - it is assembled from a useQuery over RTDB plus local derivation. The new design gives trading one server-owned truth (Firestore) mirrored into one client store.

F14 - Realtime Database is the wrong tool for accounts. RTDB offers weak per-path rule expressiveness and no query model; accounts need per-document rules, transactions and range queries - exactly what Firestore provides. The platform already pays the Firebase bill; switching the trading domain to Firestore adds no vendor.


### 4.5 Security

F15 - The trade path contains no server component. api/ serves quotes, market, news, wallet, cases, rewards, referral, admin and Whop surfaces, but there is no trading endpoint; every order, close, modify and balance change is a client-to-RTDB write. This is the root security gap; the roadmap makes every account mutation a server function call authenticated with a verified Firebase ID token.

F16 - Rules are not under version control and cannot be verified from the repository. The client Firebase config carries dummy fallbacks (functional but noisy), and no firestore.rules or database.rules.json file exists to review. The rebuild adds rules files to the repository plus automated rules tests in the Definition of Done.


## 5. Gap Analysis Against the Target Architecture

The requested target architecture has eight pillars. The table maps each pillar to the current state and to the plan item that closes the gap. Nothing in the target requires new infrastructure vendors beyond Firebase and Vercel, which are already in use.

**Table 2. Target pillars versus current state**

| Target pillar | Current state | Gap | Closed by |
| --- | --- | --- | --- |
| 1. Lightweight Charts rendering | LWC 4.2.3 in a 1,351-line monolith | Split, not replace (F12) | P3 ChartCore extraction |
| 2. Reliable market data | Crypto live; gold spot live on last bar; forex and indices delayed (F5, F6) | Server-side price service with caches and spread model | P1 PriceService, P2 fills |
| 3. Server-side engine | None - execution is in the browser (F1) | Full engine: orders, fills, SL/TP, pending, margin, stop-out | P2 Engine |
| 4. Firebase auth + secure Firestore storage | Auth OK; trading state in forgeable RTDB (F14, F15) | Firestore schema, rules, admin-only writes | P1 Data layer |
| 5. Real-time equity, margin, floating P/L, drawdown | Computed in the browser for display (F4) | Server-computed snapshot API plus client mirror | P2 Snapshot, P3 UI |
| 6. Market, pending, SL/TP | Market instant-fill only; pending instant-fill (F3); SL/TP dead letters (F2) | Order lifecycle with triggers on server prices | P2 Engine |
| 7. Secure execution and history | No server in the loop (F15); journal is manual | ID-token-verified endpoints; immutable fills ledger | P2 + P4 |
| 8. Multi-user isolated accounts | One DEMO account per user (F4) | Account collection per user; DEMO and PROP types | P4 Accounts |


## 6. Keep, Rewrite or Delete: File-Level Inventory

The instruction is to remove the old terminal and build the new one. Deletion is correct for the trading core and the page orchestrators; a large part of the terminal investment (pure indicator and drawing libraries, the replay engine math) survives. The inventory below is the concrete cutover list, so nothing is deleted by hand later - the list is the plan.

**Table 3. Disposition of the terminal codebase**

| File (lines) | Disposition | Rationale and destination |
| --- | --- | --- |
| TerminalPage.tsx (1,286) | REWRITE | Split into TerminalLayout, MarketWatch, WatchList, OrderPanel, PositionsPanel, AlertsPanel and a zustand store; alerts loop moves behind the server evaluator |
| TerminalChart.tsx (1,351) | REWRITE | Extract ChartCore (series, panes, live updates), DrawingLayer (drawings.ts glue), ReplayLayer, Legend and StatusBadge; keep LWC 4.2.3 |
| use-terminal-trading.ts (250) | DELETE | Replaced entirely by the server API client (use-trading-store); nothing survives a client-authoritative adapter |
| TradingPanel.tsx (233) | REWRITE | Same UX, new transport: POST /api/trading/orders instead of the demo adapter |
| data-feeds.ts (464) | KEEP + TRIM | BinanceProvider (WS failover, mirror REST, poll) stays as the chart feed; QuotesProvider stays for chart history; execution prices move server-side |
| replay-engine.ts (340) | KEEP | Deterministic math is sound; reuse for Replay 2.0 practice; re-point its evaluation to shared rules used by the server |
| use-replay.ts (346) | KEEP | Practice tool stays client-side; sessions remain in RTDB |
| drawings.ts (1,137) | KEEP | Pure drawing engine; re-glue to DrawingLayer |
| indicators.ts (567) | KEEP + PATCH | Add incremental last-point computation to kill the F8 hot path |
| backtest.ts (350), StrategyTester.tsx (251) | KEEP | Runs on fetched history; unaffected by the rebuild |
| sessions.ts (178), chart-overlay.ts (196), screener.ts (158) | KEEP | Pure libraries over bars |
| ReplayTradingPanel, ReplayToolbar, ReplayStatsPanel, ReplayMissionsPanel, ReplayJournalDialog | KEEP | Replay UI unaffected |
| use-trades.ts (237) | KEEP + EXTEND | Journal gains automatic fills import from the engine ledger |
| CalculatorsDialog.tsx (228) | KEEP | Standalone calculators |
| PropFirmPage.tsx | REWRITE | Becomes the storefront for real challenge templates backed by Whop purchase and server provisioning |
| Terminal-side RTDB nodes (terminalDemo, and on cutover terminalDrawings, terminalSettings, terminalAlerts) | DELETE | terminalDemo is replaced by Firestore accounts; the rest migrate to Firestore user docs during P5 |


## 7. Target Architecture Design


### 7.1 Chart layer

TradingView Lightweight Charts remains the renderer - the audit found nothing wrong with the choice, only with the component around it. The new ChartCore receives bars through a throttled price bus (one 250 ms coalesced flush per chart) and applies incremental series.update calls; it never recomputes full indicator series per tick because indicators.ts gains incremental last-point updates. Drawing, replay and overlay features become optional layers mounted inside ChartCore, so a clean live-trading chart does not pay for practice features.


### 7.2 Market data service (server)

A server-side PriceService in api/_src/market becomes the single execution price authority. Crypto prices come from Binance public REST (real-time, free, no key) with the same mirror failover proven on the client. Gold comes from the spot API already integrated for the last-bar paint, now cached server-side for seconds rather than minutes. Forex and indices stay on Yahoo (delayed) for the first release, with an honest DELAYED badge in the UI, and the provider interface is designed so a paid real-time forex source can be dropped in without touching the engine. The service exposes instrument-consistent bid and ask by applying a configured spread per instrument, stored in a Firestore instruments collection seeded from the current instrument catalog.


### 7.3 Server-side trading engine

The engine lives in api/_src/trading as Vercel functions (Node 20, TypeScript, firebase-admin). Every endpoint verifies a Firebase ID token, loads the account, and mutates state inside Firestore transactions - two concurrent orders can never double-spend margin. Market orders fill at the server bid or ask (never the client price) with the configured spread; pending orders are stored and triggered only by the evaluator; Stop Loss, Take Profit, margin check at order time, margin call and stop-out are all enforced server-side. A single idempotent evaluate endpoint runs on every trigger and processes, for every active account: pending triggers against server prices, SL and TP hits, end-of-bar MTM, daily drawdown resets, max-drawdown breaches and challenge phase transitions.

Evaluator scheduling is the one infrastructure decision: Vercel crons run at one-minute granularity on the Pro plan, and the free tier supports daily only. The plan therefore uses three redundant triggers, all idempotent: a one-minute cron (Pro) or an external scheduler such as Upstash QStash (free tier) if the account stays on Hobby; a client heartbeat that pings evaluate while the terminal is open; and an evaluate-before-every-order guard. Fills then never depend on a single scheduler.


### 7.4 Firestore data model and security rules

**Table 4. Firestore collections for the trading domain**

| Path | Content | Client access |
| --- | --- | --- |
| users/{uid}/accounts/{aid} | Type (demo or prop), template id, status (active, passed, failed, archived), balance, equity cache, leverage, currency, rule set (target pct, max DD pct, daily loss pct, min days), phase, createdAt | read own; write never |
| users/{uid}/accounts/{aid}/positions/{pid} | Symbol, side, lots, entry, sl, tp, openedAt, mtm cache | read own; write never |
| users/{uid}/accounts/{aid}/orders/{oid} | Pending orders: symbol, side, lots, type (limit or stop), price, sl, tp, status | read own; write never |
| users/{uid}/accounts/{aid}/trades/{tid} | Immutable fills ledger: open and close fills, pnl, reason (manual, sl, tp, stopout) | read own; write never |
| users/{uid}/accounts/{aid}/snapshots/{date} | Daily equity and balance snapshot for drawdown math | read own; write never |
| instruments/{symbol} | Digits, pip size, contract size, spread, max lots, quote currency, feed source | read; write never |
| challengeTemplates/{id} | Purchasable prop products: sizes, targets, DD limits, min days, Whop product link | read; write never |

Security rules allow clients to read their own account subtree and nothing else; every write path to accounts, positions, orders, trades, snapshots, instruments and challenge templates is denied to clients outright, because writes happen exclusively through the admin SDK inside server functions. Non-terminal RTDB usage (chat, economy, profiles, replay sessions) is unchanged in this project, which keeps the migration small and reviewable.


### 7.5 Client store and performance budget

The new terminal uses one zustand store with selector-based subscriptions: tick-heavy components (market watch, positions, order panel) subscribe to narrow selectors, and a 250 ms coalesced price flush bounds re-renders regardless of tick frequency. TerminalPage is replaced by TerminalLayout composed of memoised panels; React Query continues to own server cache for non-tick data. The performance budget in the Definition of Done is: chart interaction stays above 55 fps with three indicators and 1,000 bars, tick-to-paint latency under 50 ms, and the terminal route's first-load JavaScript under 800 KB gzipped after route-level code splitting.


### 7.6 Prop accounts and Whop provisioning

Challenge templates become Firestore documents linked to Whop products. A Whop webhook endpoint provisions a PROP account from the purchased template inside the buyer's user tree, sets the rule set, and starts phase one. Breach evaluation (profit target, max drawdown, daily loss, minimum trading days) is computed by the same server evaluator that enforces SL and TP, from the immutable trades ledger - never from client-reported numbers. Passing a phase provisions the next phase account; completing the challenge produces a server-generated certificate, reusing the existing certificate page as the renderer.


## 8. Implementation Roadmap

The rebuild is six phases. Each phase ends with working, tested software that can be demoed; no phase leaves the repository in a broken state. Effort estimates assume one experienced full-stack developer and include tests and documentation written as part of the phase, not after it. Code lands on feature branches with the existing commit discipline; the legacy terminal keeps serving users from the current route until the P5 cutover.

**Table 5. Phase plan with deliverables and acceptance criteria**

| Phase | Scope and deliverables | Acceptance criteria | Estimate |
| --- | --- | --- | --- |
| P0 Audit | This document; decision sign-off; rules and cost questions answered (section 9) | Roadmap approved; decisions D1-D4 taken | done |
| P1 Data and security foundation | Firestore schema and rules files in repo; admin lib with ID-token verification middleware; PriceService with Binance mirror failover, gold spot cache, spread config; instruments collection seeded | Rules tests prove client writes to accounts are denied; PriceService returns bid and ask for all instruments with a documented freshness per source | 2-3 days |
| P2 Trading engine | Endpoints: create account, place market and pending order, modify SL/TP, cancel order, close position (full or partial), snapshot; idempotent evaluate (pending triggers, SL/TP, margin call, stop-out, daily reset); immutable fills ledger; vitest unit suite for pip value, contract size, margin, P/L, spread, DD math | Unit tests green for the full math surface; integration test runs a market order, a limit order triggered by evaluator, an SL hit and a stop-out against seeded prices; two concurrent orders cannot exceed free margin (transaction test) | 4-5 days |
| P3 New terminal UI | TerminalLayout split; ChartCore, DrawingLayer, ReplayLayer extraction; zustand store with 250 ms price flush; OrderPanel and PositionsPanel on the engine API; live equity, margin, floating P/L, drawdown; incremental indicator updates | Page no longer re-renders on ticks (React profiler evidence); chart stays above 55 fps with three indicators; order round-trip demoable end to end on real server prices | 4-6 days |
| P4 Accounts and prop product | Multi-account UI (create DEMO, switch accounts); Whop webhook provisioning; challenge evaluation from the ledger; phase progression; server-generated certificates; PropFirmPage becomes the real storefront | Purchasing a test Whop product provisions a challenge account automatically; breaching max DD fails the account server-side; passing target with min days advances the phase | 3-4 days |
| P5 Migration and cutover | Route switch to the new terminal behind the same URL; one-time migration script copies old demo balances into Firestore DEMO accounts; legacy files from Table 3 deleted; docs updated | Legacy terminal files absent from the repository; migrated users see their previous balance; production smoke test checklist green | 2-3 days |
| P6 Hardening | Firestore rules test suite in CI; load test of evaluate at realistic account counts; Lighthouse and bundle budget check; security review of the trade path; runbook for the evaluator scheduler | Main chunk under 800 KB gzipped; evaluate sustains 10,000 account checks per minute in the load harness; zero critical findings in the security review | 1-2 days |

Total estimated effort: 16 to 23 working days. The critical path is P1 to P2 to P3; P4 can start as soon as P2 endpoints exist and P5 and P6 partially overlap. The highest-risk unknown is not engineering but data sourcing for forex and indices (decision D2), which must be answered before P2 fills design is frozen.


## 9. Risks and Decisions Needed

D1 - Evaluator scheduling. A one-minute Vercel cron requires the Pro plan; the free tier needs an external scheduler (Upstash QStash has a usable free tier) plus the client heartbeat. Recommendation: start with QStash plus heartbeat on the current plan, move to a native cron only if the account is upgraded anyway.

D2 - Real-time forex and indices data. Free sources are delayed; a credible prop challenge on EURUSD or NAS100 needs real-time prices, and real-time forex feeds are paid (typically tens of dollars per month at provider entry tiers). Recommendation: ship phase one with live crypto and gold plus honestly-badged delayed forex and indices, restrict purchasable challenges to crypto and gold instruments until a paid feed is budgeted, and keep the provider interface swappable.

D3 - Firestore cost envelope. Per order the engine writes roughly 10 to 20 documents (account, position, fill, snapshot). A one-minute equity snapshot per active account would add about 1,440 writes per day per account, so the design writes snapshots only for accounts with open positions or active PROP status, and the daily snapshot replaces intrabar snapshots with on-change equity cache updates. At subscriber scale this stays within the Firebase no-cost Spark allowances for years, but it is monitored from day one.

D4 - Scope guard. Replay 2.0, the journal, backtest, screener and calculators are kept as-is and are not rewritten in this project; they run client-side by design and are practice tools, not trading state. RTDB stays for non-terminal community features. LWC stays on 4.2.3; the v5 upgrade is deferred because it is a breaking change with no benefit for this rebuild.

Risk register (top items): price-service single point of failure (mitigated by mirror failover and the proven client pattern); Firestore transaction contention on hot accounts (mitigated by per-account document sharding of counters if contention appears); Whop webhook delivery gaps (mitigated by a reconciliation job and manual provisioning tool for support); migration data loss (mitigated by the copy-only migration script and keeping the old RTDB nodes read-only for 30 days after cutover instead of deleting them).


## 10. Definition of Done

No feature is claimed as working unless the corresponding item below is demonstrably true in the production deployment, not only locally. The list is the acceptance gate for the whole rebuild and each phase's criteria (Table 5) fold into it.

- Market order, pending order (limit and stop), Stop Loss, Take Profit, partial close and cancel all execute against server-side prices and are covered by integration tests that run the full lifecycle against a seeded price sequence.
- Stop Loss and Take Profit are evaluated by the server evaluator even when the user's browser is closed (test: open a position with SL, stop the client, let the evaluator fire, verify the fill in the ledger).
- Equity, used margin, free margin, floating P/L and drawdown shown in the UI match a server-computed snapshot to the cent, verified by a test that compares the two.
- A user cannot change any balance, position, order or fill value from the client: automated Firestore rules tests prove all client writes to the trading domain are denied.
- Multi-user isolation: automated tests create two users and prove neither can read or affect the other's accounts.
- A Whop purchase provisions a challenge account automatically, breach and pass transitions are server-computed, and a certificate is generated on completion.
- Performance budget met: above 55 fps chart interaction with three indicators on 1,000 bars, tick-to-paint under 50 ms, terminal route first-load JavaScript under 800 KB gzipped.
- Legacy terminal files from Table 3 are deleted, the route serves the new terminal, and migrated demo balances match the archived values.
- No mock, generated or placeholder data exists anywhere in the trading path; the only simulated element is the engine itself filling orders against real market prices on virtual balances.

With the decisions in section 9 taken, the next step is P1: the Firestore schema, the security rules and the server-side price service. No implementation begins until this audit is signed off, per the instruction that the audit and roadmap come first.

