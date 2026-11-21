/**
 * Trading store — all Firestore writes for the trading domain happen here,
 * server-side only (clients have zero direct access; firestore.rules denies
 * the whole domain to clients, the Admin SDK bypasses rules).
 *
 * Every mutation runs inside a Firestore transaction that first applies the
 * engine evaluator (SL/TP hits, pending triggers, stop-out) so the account is
 * always in a consistent, fully-evaluated state before and after the change.
 * Fills use the server price service — never a client-reported price.
 */
import { HttpError, firestore, rtdb } from "../lib/firebase";
import { getPlatformSettings, writeAdminAlert } from "../lib/platform";
import { getInstrument } from "../../../shared/terminal";
import { marketHours } from "../../../shared/market-hours";
import {
  DEFAULT_LEVERAGE, MIN_LOTS, MAX_LOTS, computeMetrics, evaluateAccount, exitPriceFor,
  positionPnlUsd, validateNewOrder, dayKey, evaluatePropRules, swapForPosition, nightsHeld,
  validateAgainstRules, validateOrderModify, validatePositionModify, periodExpired, bumpTradeStats,
  type Quote, type PositionLike, type OrderLike, type OrderKind, type Side,
  type PropRules, type AccountStatus, type RuleEvaluation, type TradeStats,
} from "../../../shared/trading-engine";
import { getQuotes, withConversionSymbols } from "./prices";

const MAX_ACCOUNTS = 10;
const MAX_OPEN_POSITIONS = 30;
const MAX_PENDING_ORDERS = 30;
const TRADE_HISTORY_KEEP = 500;
const ALLOWED_LEVERAGES = [10, 20, 30, 50, 100, 200, 500];

// ---------------------------------------------------------------------------
// Firestore handles
// ---------------------------------------------------------------------------

const db = () => firestore();
const accountsCol = (uid: string) => db().collection("users").doc(uid).collection("accounts");
const posCol = (uid: string, aid: string) => accountsCol(uid).doc(aid).collection("positions");
const ordCol = (uid: string, aid: string) => accountsCol(uid).doc(aid).collection("orders");
const tradeCol = (uid: string, aid: string) => accountsCol(uid).doc(aid).collection("trades");

interface AccountDoc {
  label: string;
  type: "DEMO" | "CHALLENGE";
  /** challenge template this account was assigned from (admin-managed) */
  challengeTypeId: string | null;
  challengeName: string | null;
  balance: number;
  startingBalance: number;
  leverage: number;
  status: AccountStatus;
  /** prop-firm rules; null/absent for DEMO accounts */
  rules: PropRules | null;
  /** failed hard-breach reason (status failed) */
  failedReason: string | null;
  /** admin freeze — trading is blocked while set; rules still evaluate */
  adminSuspended: boolean;
  /** challenge period start (resets on reset) */
  startedAt: number;
  /** high-water mark for stats */
  peakEquity: number;
  /** dayKey → closed trades that day (minimum-trading-days rule) */
  tradingDays: Record<string, number>;
  /** running win/loss counters (server-side only) */
  stats: TradeStats;
  createdAt: number;
  dayStart: Record<string, number>;
}

type StorePosition = PositionLike & { comment?: string | null; swapAccrued?: number; swapNights?: number };

interface AccountState {
  id: string;
  account: AccountDoc;
  positions: StorePosition[];
  orders: OrderLike[];
  /** USD commission per closed lot from platform settings (0 = off) */
  commissionRate: number;
}

// ---------------------------------------------------------------------------
// Quote plumbing
// ---------------------------------------------------------------------------

/** Live two-sided quotes for every symbol the account touches (+ conversions). */
async function quotesForState(state: { positions: { symbol: string }[]; orders: { symbol: string }[] }, extra: string[] = []) {
  const symbols = withConversionSymbols([
    ...state.positions.map((p) => p.symbol),
    ...state.orders.map((o) => o.symbol),
    ...extra,
  ]);
  const quotes = await getQuotes(symbols);
  const prices: Record<string, number> = {};
  for (const [sym, q] of Object.entries(quotes)) prices[sym] = q.mid;
  return { quotes, prices };
}

function requireQuote(quotes: Record<string, Quote>, symbol: string): Quote {
  const q = quotes[symbol];
  if (!q) throw new HttpError(503, "NO_QUOTE", `No executable price for ${symbol} right now — try again`);
  return q;
}

// ---------------------------------------------------------------------------
// Evaluation application (shared by every mutation)
// ---------------------------------------------------------------------------

interface CloseOutcome { symbol: string; side: Side; lots: number; entry: number; exit: number; pnl: number; swap: number; reason: string; openedAt: number; closedAt: number; positionId: string; commission?: number }

function writeTradeDoc(tx: any, uid: string, aid: string, o: CloseOutcome) {
  tx.set(tradeCol(uid, aid).doc(), { ...o });
}

/**
 * Record one realized close against the account: immutable trade doc +
 * trading-day count (min-days rule) + win/loss stats (dashboard/leaderboard).
 * CHALLENGE accounts also append a top-level leaderboardLog entry — the
 * public leaderboard must range-filter by close time, and TOP-LEVEL
 * collections keep the automatic single-field index (the trades COLLECTION
 * GROUP scope has no closedAt index exemption, which 500s that query).
 */
function recordClose(state: AccountState, tx: any, uid: string, aid: string, o: CloseOutcome) {
  // platform commission (settings) is charged on top of the raw P/L
  const commission = Math.round((o.lots || 0) * (state.commissionRate || 0) * 100) / 100;
  if (commission > 0) {
    o.commission = commission;
    state.account.balance = Math.round((state.account.balance - commission) * 100) / 100;
  }
  writeTradeDoc(tx, uid, aid, o);
  bumpTradingDay(state.account, o.closedAt);
  state.account.stats = bumpTradeStats(state.account.stats, o.pnl);
  if (state.account.type === "CHALLENGE") {
    tx.set(firestore().collection("leaderboardLog").doc(), {
      at: o.closedAt,
      uid,
      aid,
      net: Math.round((o.pnl + o.swap - (o.commission || 0)) * 100) / 100,
    });
  }
}

/** Delete the leaderboardLog feed of one account (on authorized resets). */
export async function clearLeaderboardLog(aid: string) {
  const snap = await firestore().collection("leaderboardLog").where("aid", "==", aid).limit(500).get();
  if (snap.empty) return;
  const batch = firestore().batch();
  for (const d of snap.docs) batch.delete(d.ref);
  await batch.commit();
}

/**
 * Settle overnight swap owed by one position into the account balance
 * (whole UTC nights crossed minus the already-charged nights). Mutates the
 * position's swapAccrued/swapNights and the state balance in place; returns
 * the position's total accumulated swap (USD, signed).
 */
function settleSwap(state: AccountState, pos: StorePosition, now: number): number {
  const spec = getInstrument(pos.symbol);
  if (!spec) return pos.swapAccrued ?? 0;
  const nights = Math.max(nightsHeld(pos.openedAt, now), 0);
  const charged = pos.swapNights ?? 0;
  if (nights <= charged) return pos.swapAccrued ?? 0;
  const owed = swapForPosition(spec, pos.side, pos.lots, pos.openedAt + charged * 86_400_000, now);
  state.account.balance = Math.round((state.account.balance + owed) * 100) / 100;
  pos.swapAccrued = Math.round(((pos.swapAccrued ?? 0) + owed) * 100) / 100;
  pos.swapNights = nights;
  return pos.swapAccrued;
}

/**
 * Apply SL/TP exits + stop-out + pending fills to the in-transaction state.
 * Mutates state.positions / state.orders / state.account.balance and queues
 * all Firestore writes. Returns the realized close outcomes and fill count.
 *
 * Also runs, in order: (1) overnight swap accrual — whole UTC nights crossed
 * since the last charge are settled into the balance; (2) prop-rule checks —
 * a hard breach force-closes the book, cancels pendings and fails the
 * account, a satisfied target + flat book + enough trading days passes it.
 */
function applyEvaluationTx(
  tx: any, uid: string, aid: string, state: AccountState,
  quotes: Record<string, Quote>, prices: Record<string, number>,
): { closed: CloseOutcome[]; filled: number; ruleState: RuleEvaluation | null } {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const now = Date.now();
  const result = evaluateAccount({
    balance: state.account.balance,
    positions: state.positions,
    orders: state.orders,
    quotes,
    prices,
    leverage,
  });
  const closed: CloseOutcome[] = [];

  // ---- stop-out force-closes everything; otherwise close the SL/TP hits --
  const toClose: { pos: StorePosition; exit: number; reason: string }[] = [];
  if (result.stopOut) {
    for (const p of state.positions) {
      const q = requireQuote(quotes, p.symbol);
      toClose.push({ pos: p, exit: exitPriceFor(p.side, q), reason: "stopout" });
    }
  } else {
    for (const e of result.exits) {
      const pos = state.positions.find((p) => p.id === e.positionId);
      if (pos) toClose.push({ pos, exit: e.exit, reason: e.reason });
    }
  }
  for (const { pos, exit, reason } of toClose) {
    const spec = getInstrument(pos.symbol)!;
    const swap = settleSwap(state, pos, now);
    const pnl = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    closed.push({
      symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, exit,
      pnl, swap, reason, openedAt: pos.openedAt, closedAt: now, positionId: pos.id,
    });
    tx.delete(posCol(uid, aid).doc(pos.id));
    state.positions = state.positions.filter((p) => p.id !== pos.id);
  }
  for (const o of closed) {
    recordClose(state, tx, uid, aid, o);
  }

  // ---- pending fills -------------------------------------------------------
  // Phase 27 §6: a pending order NEVER triggers against a frozen closed-market
  // quote (weekend FX/metals). The order stays armed and fills at the reopen —
  // no false executions while the provider has not actually updated.
  result.fills = result.fills.filter((f: any) => {
    const order = state.orders.find((o) => o.id === f.orderId);
    if (!order) return false;
    return marketHours(order.symbol).open;
  });
  for (const f of result.fills) {
    const order = state.orders.find((o) => o.id === f.orderId);
    if (!order) continue;
    const posRef = posCol(uid, aid).doc();
    const pos: StorePosition = {
      id: posRef.id, symbol: order.symbol, side: order.side, lots: order.lots,
      entry: f.entry, sl: order.sl, tp: order.tp, openedAt: now,
      swapAccrued: 0, swapNights: 0,
    };
    tx.set(posRef, { symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, sl: pos.sl, tp: pos.tp, openedAt: pos.openedAt, swapAccrued: 0, swapNights: 0 });
    tx.delete(ordCol(uid, aid).doc(order.id));
    state.orders = state.orders.filter((o) => o.id !== order.id);
    state.positions.push(pos);
  }

  // ---- swap accrual for positions that stay open ---------------------------
  for (const p of state.positions) {
    const spec = getInstrument(p.symbol);
    if (!spec) continue;
    const nights = Math.max(nightsHeld(p.openedAt, now), 0);
    if (nights > (p.swapNights ?? 0)) {
      settleSwap(state, p, now);
      tx.update(posCol(uid, aid).doc(p.id), { swapAccrued: p.swapAccrued, swapNights: p.swapNights });
    }
  }

  // ---- daily balance snapshot (for daily-drawdown rules) -------------------
  const today = dayKey();
  const dayStart = { ...(state.account.dayStart || {}) };
  if (dayStart[today] == null) dayStart[today] = state.account.balance;
  state.account.dayStart = dayStart;

  // ---- prop-rule enforcement ----------------------------------------------
  const rules = state.account.rules ?? null;
  if (rules && state.account.status !== "failed") {
    const prevStatus = state.account.status || "active";
    const leverage2 = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage2);
    const ruleState = evaluatePropRules({
      rules,
      status: state.account.status || "active",
      balance: state.account.balance,
      equity: metrics.equity,
      startingBalance: state.account.startingBalance,
      dayStartBalance: dayStart[today] ?? state.account.balance,
      peakEquity: state.account.peakEquity ?? state.account.balance,
      tradingDays: Object.keys(state.account.tradingDays || {}).length,
      openPositions: state.positions.length,
      openLots: state.positions.reduce((s, p) => s + p.lots, 0),
      periodExpired: periodExpired(rules, state.account.startedAt || state.account.createdAt, now),
    });
    state.account.peakEquity = ruleState.peakEquity;
    state.account.status = ruleState.status;
    state.account.failedReason = ruleState.status === "failed" ? ruleState.failedReason : null;
    // admin notifications on PASSED / FAILED transitions (fire-and-forget —
    // must never block or fail the trading transaction)
    if (ruleState.status !== prevStatus && ruleState.status === "passed") {
      void writeAdminAlert({
        type: "challenge_passed", severity: "info",
        text: `Challenge PASSED — profit target reached on ${state.account.challengeName || state.account.label}`,
        uid, details: { aid, balance: state.account.balance },
      });
    } else if (ruleState.status !== prevStatus && ruleState.status === "failed") {
      void writeAdminAlert({
        type: "challenge_failed", severity: "critical",
        text: `Challenge FAILED — ${state.account.failedReason || "rule breached"}`,
        uid, details: { aid, reason: state.account.failedReason },
      });
    }

    if (ruleState.hardBreach) {
      // terminate the account: close the whole book at market, kill pendings
      for (const p of [...state.positions]) {
        const q = requireQuote(quotes, p.symbol);
        const spec = getInstrument(p.symbol)!;
        const swap = settleSwap(state, p, now);
        const exit = exitPriceFor(p.side, q);
        const pnl = positionPnlUsd(spec, p.side, p.lots, p.entry, exit, prices);
        state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
        const outcome: CloseOutcome = {
          symbol: p.symbol, side: p.side, lots: p.lots, entry: p.entry, exit,
          pnl, swap, reason: "rule-breach", openedAt: p.openedAt, closedAt: now, positionId: p.id,
        };
        closed.push(outcome);
        recordClose(state, tx, uid, aid, outcome);
        tx.delete(posCol(uid, aid).doc(p.id));
      }
      state.positions = [];
      for (const o of state.orders) tx.delete(ordCol(uid, aid).doc(o.id));
      state.orders = [];
    }
    return { closed, filled: result.fills.length, ruleState };
  }

  return { closed, filled: result.fills.length, ruleState: null };
}

/** Count the day of a closed trade toward the minimum-trading-days rule. */
function bumpTradingDay(account: AccountDoc, closedAt: number) {
  const key = dayKey(closedAt);
  const days = { ...(account.tradingDays || {}) };
  days[key] = (days[key] || 0) + 1;
  account.tradingDays = days;
}

/** Persist account balance/dayStart + cached metrics after evaluation. */
function persistAccountTx(tx: any, uid: string, aid: string, state: AccountState, quotes: Record<string, Quote>, prices: Record<string, number>) {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
  tx.update(accountsCol(uid).doc(aid), {
    balance: state.account.balance,
    dayStart: state.account.dayStart,
    status: state.account.status || "active",
    rules: state.account.rules ?? null,
    failedReason: state.account.failedReason ?? null,
    peakEquity: state.account.peakEquity ?? state.account.balance,
    tradingDays: state.account.tradingDays || {},
    stats: state.account.stats || { totalTrades: 0, wins: 0, losses: 0 },
    adminSuspended: !!state.account.adminSuspended,
    startedAt: state.account.startedAt || state.account.createdAt || Date.now(),
    challengeTypeId: state.account.challengeTypeId ?? null,
    challengeName: state.account.challengeName ?? null,
    balanceUpdatedAt: Date.now(),
    metrics: { ...metrics, updatedAt: Date.now() },
  });
  return metrics;
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

async function readState(uid: string, aid: string): Promise<AccountState> {
  const accSnap = await accountsCol(uid).doc(aid).get();
  if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const [posSnap, ordSnap, settings] = await Promise.all([
    posCol(uid, aid).get(),
    ordCol(uid, aid).get(),
    getPlatformSettings(),
  ]);
  const positions = posSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const orders = ordSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return {
    id: aid,
    account: accSnap.data() as AccountDoc,
    positions,
    orders,
    commissionRate: settings.commissionPerLotUsd || 0,
  };
}

export async function listAccounts(uid: string) {
  const snap = await accountsCol(uid).orderBy("createdAt", "asc").get();
  const today = dayKey();
  const out = [];
  for (const doc of snap.docs) {
    const state = await readState(uid, doc.id);
    const { quotes, prices } = await quotesForState(state);
    const leverage = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
    const acc = state.account;
    const ruleState = acc.rules
      ? evaluatePropRules({
          rules: acc.rules,
          status: acc.status || "active",
          balance: acc.balance,
          equity: metrics.equity,
          startingBalance: acc.startingBalance,
          dayStartBalance: acc.dayStart?.[today] ?? acc.balance,
          peakEquity: acc.peakEquity ?? acc.balance,
          tradingDays: Object.keys(acc.tradingDays || {}).length,
          openPositions: state.positions.length,
          openLots: state.positions.reduce((s, p) => s + p.lots, 0),
          periodExpired: periodExpired(acc.rules, acc.startedAt || acc.createdAt, Date.now()),
        })
      : null;
    out.push({
      id: doc.id, label: acc.label, type: acc.type,
      challengeTypeId: acc.challengeTypeId ?? null,
      challengeName: acc.challengeName ?? null,
      balance: acc.balance, startingBalance: acc.startingBalance,
      leverage: acc.leverage, createdAt: acc.createdAt,
      status: acc.status || "active",
      rules: acc.rules ?? null,
      failedReason: acc.failedReason ?? null,
      adminSuspended: !!acc.adminSuspended,
      startedAt: acc.startedAt ?? acc.createdAt ?? null,
      peakEquity: acc.peakEquity ?? acc.balance,
      tradingDays: Object.keys(acc.tradingDays || {}).length,
      stats: acc.stats || { totalTrades: 0, wins: 0, losses: 0 },
      dayStart: acc.dayStart ?? {},
      ruleState,
      positions: state.positions, orders: state.orders, metrics,
      quotes: Object.fromEntries(Object.entries(quotes).filter(([s]) =>
        state.positions.some((p) => p.symbol === s) || state.orders.some((o) => o.symbol === s))),
    });
  }
  return out;
}

export async function history(uid: string, aid: string, limit = 100) {
  const snap = await tradeCol(uid, aid).orderBy("closedAt", "desc").limit(Math.min(200, Math.max(1, limit))).get();
  return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateAccountOptions {
  /** leverage for margin math — clamped to ALLOWED_LEVERAGES (default 100) */
  leverage?: number | null;
  /** prop-firm rules → account type CHALLENGE; null/absent → DEMO */
  rules?: PropRules | null;
  /** challenge template this account was assigned from */
  challengeTypeId?: string | null;
  /** display name of the challenge template */
  challengeName?: string | null;
}

function sanitizeRules(raw: any): PropRules | null {
  if (!raw || typeof raw !== "object") return null;
  const pct = (v: unknown, lo: number, hi: number): number | null => {
    const n = Number(v);
    if (v == null || v === "" || !Number.isFinite(n)) return null;
    return Math.min(hi, Math.max(lo, n));
  };
  const rules: PropRules = {
    dailyLossLimitPct: pct(raw.dailyLossLimitPct, 1, 50),
    maxDrawdownPct: pct(raw.maxDrawdownPct, 1, 50),
    profitTargetPct: pct(raw.profitTargetPct, 1, 100),
    minTradingDays: Math.min(60, Math.max(0, Math.floor(Number(raw.minTradingDays) || 0))),
    maxLotsTotal: pct(raw.maxLotsTotal, 0.01, 100),
    maxLotsPerOrder: pct(raw.maxLotsPerOrder, 0.01, 100),
    maxOpenPositions: raw.maxOpenPositions == null ? null : Math.min(30, Math.max(1, Math.floor(Number(raw.maxOpenPositions) || 1))),
    maxTradingDays: pct(raw.maxTradingDays, 0, 365),
  };
  // at least one constraint must be set for it to count as a challenge
  const hasAny = rules.dailyLossLimitPct != null || rules.maxDrawdownPct != null
    || rules.profitTargetPct != null || rules.minTradingDays > 0
    || rules.maxLotsTotal != null || rules.maxLotsPerOrder != null || rules.maxOpenPositions != null
    || rules.maxTradingDays != null;
  return hasAny ? rules : null;
}

export async function createAccount(uid: string, label?: string, startingBalance?: number, opts: CreateAccountOptions = {}) {
  const existing = await accountsCol(uid).get();
  if (existing.size >= MAX_ACCOUNTS) throw new HttpError(409, "TOO_MANY_ACCOUNTS", `Maximum ${MAX_ACCOUNTS} accounts`);
  const settings = await getPlatformSettings();
  const balance = Math.round(Math.min(5_000_000, Math.max(1_000, Number(startingBalance) || settings.defaultAccountBalance)) * 100) / 100;
  const rules = sanitizeRules(opts.rules);
  const leverageRaw = Number(opts.leverage) || settings.defaultLeverage;
  const allowed = settings.allowedLeverages?.length ? settings.allowedLeverages : ALLOWED_LEVERAGES;
  const leverage = allowed.includes(leverageRaw) ? leverageRaw : allowed.includes(settings.defaultLeverage) ? settings.defaultLeverage : DEFAULT_LEVERAGE;
  const today = dayKey();
  const doc = {
    label: String(label || (rules ? "CHALLENGE" : "DEMO")).slice(0, 32) || "DEMO",
    type: rules ? ("CHALLENGE" as const) : ("DEMO" as const),
    challengeTypeId: opts.challengeTypeId ?? null,
    challengeName: String(opts.challengeName || "").slice(0, 60) || null,
    balance, startingBalance: balance,
    leverage,
    status: "active" as AccountStatus,
    rules,
    failedReason: null,
    adminSuspended: false,
    startedAt: Date.now(),
    peakEquity: balance,
    tradingDays: {},
    stats: { totalTrades: 0, wins: 0, losses: 0 },
    createdAt: Date.now(),
    dayStart: { [today]: balance },
  };
  const ref = await accountsCol(uid).add(doc);
  return { id: ref.id, ...doc, metrics: computeMetrics(balance, [], {}, {}, leverage), positions: [], orders: [] };
}

export async function resetAccount(uid: string, aid: string) {
  const dbRef = db();
  const accRef = accountsCol(uid).doc(aid);
  // the fresh attempt also drops the account's public leaderboard feed
  await clearLeaderboardLog(aid);
  return dbRef.runTransaction(async (tx: any) => {
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
    const [posSnap, ordSnap, tradeSnap] = await Promise.all([
      tx.get(posCol(uid, aid)),
      tx.get(ordCol(uid, aid)),
      tx.get(tradeCol(uid, aid).limit(TRADE_HISTORY_KEEP + 1)),
    ]);
    if (posSnap.size || ordSnap.size) {
      throw new HttpError(409, "ACCOUNT_BUSY", "Close all positions and pending orders before resetting");
    }
    if (tradeSnap.size > TRADE_HISTORY_KEEP) throw new HttpError(409, "TOO_MANY_TRADES", "Reset keeps the last 500 trades — this account has more");
    for (const d of tradeSnap.docs) tx.delete(d.ref);
    const account = accSnap.data() as AccountDoc;
    const balance = account.startingBalance;
    tx.update(accRef, {
      balance,
      // a reset starts a fresh attempt: challenge status back to active
      status: "active" as AccountStatus,
      failedReason: null,
      adminSuspended: false,
      startedAt: Date.now(),
      peakEquity: balance,
      tradingDays: {},
      stats: { totalTrades: 0, wins: 0, losses: 0 },
      dayStart: { [dayKey()]: balance },
      metrics: { ...computeMetrics(balance, [], {}, {}, account.leverage || DEFAULT_LEVERAGE), updatedAt: Date.now() },
      balanceUpdatedAt: Date.now(),
    });
    return { balance };
  });
}

export async function evaluate(uid: string, aid: string) {
  const dbRef = db();
  const accRef = accountsCol(uid).doc(aid);
  const preState = await readState(uid, aid);
  const { quotes, prices } = await quotesForState(preState);
  return dbRef.runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, aid);
    const before = state.account.balance;
    const { closed } = applyEvaluationTx(tx, uid, aid, state, quotes, prices);
    const metrics = persistAccountTx(tx, uid, aid, state, quotes, prices);
    return { metrics, realized: Math.round((state.account.balance - before) * 100) / 100, closed };
  });
}

/** Transaction-only state read (same shape as readState). */
async function txGetState(tx: any, uid: string, aid: string): Promise<AccountState> {
  const accRef = accountsCol(uid).doc(aid);
  const [accSnap, posSnap, ordSnap] = await Promise.all([
    tx.get(accRef),
    tx.get(posCol(uid, aid)),
    tx.get(ordCol(uid, aid)),
  ]);
  if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const settings = await getPlatformSettings();
  return {
    id: aid,
    account: accSnap.data() as AccountDoc,
    positions: posSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })),
    orders: ordSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })),
    commissionRate: settings.commissionPerLotUsd || 0,
  };
}

export interface PlaceOrderRequest {
  accountId: string;
  symbol: string;
  side: Side;
  lots: number;
  kind: OrderKind;
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
  comment?: string;
}

export async function placeOrder(uid: string, req: PlaceOrderRequest) {
  const spec = getInstrument(req.symbol || "");
  if (!spec) throw new HttpError(400, "BAD_SYMBOL", `Unknown instrument: ${req.symbol}`);
  if (req.side !== "buy" && req.side !== "sell") throw new HttpError(400, "BAD_SIDE", "side must be buy or sell");
  // Phase 27 §2: authoritative market-session gate — the BACKEND blocks
  // market AND pending orders for closed instruments (weekend FX/metals),
  // independent of any frontend state. No order, no balance change, no
  // margin reservation is created when this rejects. Cancellation of
  // pending orders stays allowed (see cancelOrder — deliberately not gated).
  const mh = marketHours(spec.symbol);
  if (!mh.open) {
    throw new HttpError(422, "MARKET_CLOSED", "MARKET_CLOSED: Trading is unavailable for this instrument at the moment.");
  }
  const kind: OrderKind = req.kind === "limit" || req.kind === "stop" ? req.kind : "market";
  const dbRef = db();
  const accRef = accountsCol(uid).doc(req.accountId);

  // platform-level guards (Phase 7): maintenance mode, user restriction,
  // instrument whitelist and the global lot cap — all server-side
  const settings = await getPlatformSettings();
  if (settings.maintenanceMode) {
    throw new HttpError(503, "MAINTENANCE", "Trading is temporarily disabled for platform maintenance");
  }
  if ((await rtdb().ref(`restricted/${uid}`).once("value")).val()) {
    throw new HttpError(403, "ACCOUNT_RESTRICTED", "Trading is restricted for this account by an administrator");
  }
  if (settings.symbolsMode === "custom" && !settings.customSymbols.includes(spec.symbol)) {
    throw new HttpError(403, "SYMBOL_DISABLED", `${spec.symbol} is not enabled on the platform right now`);
  }
  if (settings.maxLotPerOrder != null && Number(req.lots) > settings.maxLotPerOrder) {
    throw new HttpError(403, "LOT_LIMIT", `Max lot per order is ${settings.maxLotPerOrder}`);
  }

  const preState = await readState(uid, req.accountId);
  const { quotes, prices } = await quotesForState(preState, [spec.symbol]);
  if (!quotes[spec.symbol]) {
    void writeAdminAlert({
      type: "engine_error", severity: "warning",
      text: `No executable price for ${spec.symbol}`,
      uid, details: { aid: req.accountId, symbol: spec.symbol },
    }, `no_quote:${spec.symbol}`, 30 * 60_000);
  }

  return dbRef.runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, req.accountId);
    // bring the account fully up to date first (SL/TP/pending/stop-out/rules)
    applyEvaluationTx(tx, uid, req.accountId, state, quotes, prices);

    const leverage = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);

    // terminated challenges cannot trade
    if (state.account.rules && state.account.status !== "active") {
      throw new HttpError(
        403, "ACCOUNT_NOT_ACTIVE",
        state.account.status === "failed"
          ? `Challenge failed: ${state.account.failedReason || "rule breached"} — trading is disabled`
          : "Challenge passed — trading is disabled",
      );
    }
    // admin freeze — challenge accounts only, DEMO accounts never freeze
    if (state.account.rules && state.account.adminSuspended) {
      throw new HttpError(403, "ACCOUNT_SUSPENDED", "Account suspended by an administrator — trading is disabled");
    }

    const lots = Number(req.lots);
    const quote = requireQuote(quotes, spec.symbol);
    const rules = state.account.rules ?? null;
    const rulesCheck = validateAgainstRules({
      rules,
      lots,
      openPositions: state.positions.length,
      openOrders: state.orders.length,
      openLots: state.positions.reduce((s, p) => s + p.lots, 0) + state.orders.reduce((s, o) => s + o.lots, 0),
    });
    if (!rulesCheck.ok) {
      void writeAdminAlert({
        type: "order_rejected", severity: "warning",
        text: `Order rejected by prop rules: ${rulesCheck.error}`,
        uid, details: { aid: req.accountId, symbol: spec.symbol, lots },
      }, `order_reject:${uid}`);
      throw new HttpError(403, "RULE_REJECTED", rulesCheck.error || "Prop rule breached");
    }

    const v = validateNewOrder({
      spec, side: req.side, kind, lots, price: req.price ?? null,
      sl: req.sl ?? null, tp: req.tp ?? null, quote,
      balance: state.account.balance, floatingPnl: metrics.floatingPnl, usedMargin: metrics.usedMargin,
      prices, leverage,
    });
    if (!v.ok) throw new HttpError(400, "ORDER_REJECTED", v.error || "Order rejected");

    if (kind === "market") {
      if (state.positions.length >= MAX_OPEN_POSITIONS) {
        throw new HttpError(409, "TOO_MANY_POSITIONS", `Maximum ${MAX_OPEN_POSITIONS} open positions`);
      }
      const posRef = posCol(uid, req.accountId).doc();
      const pos = {
        symbol: spec.symbol, side: req.side, lots,
        entry: v.entry!, sl: req.sl ?? null, tp: req.tp ?? null,
        openedAt: Date.now(), comment: String(req.comment || "").slice(0, 120) || null,
        swapAccrued: 0, swapNights: 0,
      };
      tx.set(posRef, pos);
      const m2 = computeMetrics(state.account.balance, [...state.positions, { id: posRef.id, ...pos }], quotes, prices, leverage);
      tx.update(accRef, {
        dayStart: state.account.dayStart,
        peakEquity: state.account.peakEquity ?? state.account.balance,
        tradingDays: state.account.tradingDays || {},
        status: state.account.status || "active",
        metrics: { ...m2, updatedAt: Date.now() },
        balanceUpdatedAt: Date.now(),
      });
      return { position: { id: posRef.id, ...pos }, order: null, entry: v.entry, quote, closed: [] as CloseOutcome[] };
    }

    if (state.orders.length >= MAX_PENDING_ORDERS) {
      throw new HttpError(409, "TOO_MANY_ORDERS", `Maximum ${MAX_PENDING_ORDERS} pending orders`);
    }
    const ordRef = ordCol(uid, req.accountId).doc();
    const order = {
      symbol: spec.symbol, side: req.side, kind, lots,
      price: Number(req.price), sl: req.sl ?? null, tp: req.tp ?? null,
      createdAt: Date.now(),
    };
    tx.set(ordRef, order);
    tx.update(accRef, { dayStart: state.account.dayStart });
    return { position: null, order: { id: ordRef.id, ...order }, entry: v.entry, quote, closed: [] as CloseOutcome[] };
  });
}

export async function closePosition(uid: string, accountId: string, positionId: string, lots?: number | null) {
  const spec = getInstrument((await posCol(uid, accountId).doc(positionId).get()).data()?.symbol || "");
  if (!spec) throw new HttpError(404, "NO_POSITION", "Position not found");
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);

  return db().runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, accountId);
    // evaluate first so the position set is current (a pending SL may have hit)
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const pos = state.positions.find((p) => p.id === positionId);
    if (!pos) throw new HttpError(404, "NO_POSITION", "Position not found (maybe SL/TP already closed it)");
    const quote = requireQuote(quotes, pos.symbol);
    const exit = exitPriceFor(pos.side, quote);
    const closeLots = lots == null ? pos.lots : Math.round(Number(lots) * 100) / 100;
    if (!Number.isFinite(closeLots) || closeLots < MIN_LOTS) throw new HttpError(400, "BAD_LOTS", `Minimum close size ${MIN_LOTS}`);
    if (closeLots > pos.lots) throw new HttpError(400, "BAD_LOTS", `Position holds ${pos.lots} lots`);
    // settle any unsettled overnight swap before realizing the close
    const lotsBefore = pos.lots;
    const swapTotal = settleSwap(state, pos, Date.now());
    const swapShare = closeLots === lotsBefore
      ? swapTotal
      : Math.round(swapTotal * (closeLots / lotsBefore) * 100) / 100;
    const pnl = positionPnlUsd(spec, pos.side, closeLots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    const outcome: CloseOutcome = {
      symbol: pos.symbol, side: pos.side, lots: closeLots, entry: pos.entry, exit,
      pnl, swap: swapShare, reason: "manual", openedAt: pos.openedAt, closedAt: Date.now(), positionId: pos.id,
    };
    recordClose(state, tx, uid, accountId, outcome);
    if (closeLots === pos.lots) {
      tx.delete(posCol(uid, accountId).doc(pos.id));
      state.positions = state.positions.filter((p) => p.id !== pos.id);
    } else {
      const remaining = Math.round((pos.lots - closeLots) * 100) / 100;
      tx.update(posCol(uid, accountId).doc(pos.id), {
        lots: remaining,
        swapAccrued: Math.round((swapTotal - swapShare) * 100) / 100,
        swapNights: pos.swapNights ?? 0,
      });
      pos.lots = remaining;
    }
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { closed: outcome, metrics, exit, quote };
  });
}

export async function modifyPosition(uid: string, accountId: string, positionId: string, sl: number | null | undefined, tp: number | null | undefined) {
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, accountId);
    // evaluate first so SL/TP set is current (a stale TP would fail validation)
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const pos = state.positions.find((p) => p.id === positionId);
    if (!pos) throw new HttpError(404, "NO_POSITION", "Position not found (maybe SL/TP already closed it)");
    const quote = requireQuote(quotes, pos.symbol);
    const num = (x: unknown) => (x == null || x === "" ? null : Number(x));
    // undefined = leave the field unchanged; null = clear it
    const slNum = sl !== undefined ? num(sl) : pos.sl;
    const tpNum = tp !== undefined ? num(tp) : pos.tp;
    const v = validatePositionModify({ pos, quote, sl: slNum, tp: tpNum });
    if (!v.ok) throw new HttpError(400, "BAD_SLTP", v.error || "Invalid SL/TP");
    tx.update(posCol(uid, accountId).doc(positionId), { sl: slNum, tp: tpNum, slModifiedAt: Date.now() });
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { ok: true, sl: slNum, tp: tpNum, metrics };
  });
}

export async function modifyOrder(
  uid: string, accountId: string, orderId: string,
  patch: { price?: number | null; sl?: number | null; tp?: number | null; lots?: number | null },
) {
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, accountId);
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new HttpError(404, "NO_ORDER", "Order not found (maybe it already filled)");
    const spec = getInstrument(order.symbol);
    if (!spec) throw new HttpError(400, "BAD_SYMBOL", `Unknown instrument: ${order.symbol}`);
    const quote = requireQuote(quotes, order.symbol);
    const num = (x: unknown, fallback: number | null) => (x == null || x === "" ? fallback : Number(x));
    const newPrice = patch.price != null ? Number(patch.price) : order.price;
    const newLots = patch.lots != null ? Math.round(Number(patch.lots) * 100) / 100 : order.lots;
    const newSl = num(patch.sl, order.sl);
    const newTp = num(patch.tp, order.tp);
    if (!Number.isFinite(newLots) || newLots < MIN_LOTS || newLots > MAX_LOTS) {
      throw new HttpError(400, "BAD_LOTS", `Volume must be ${MIN_LOTS}–${MAX_LOTS} lots`);
    }
    const rules = state.account.rules ?? null;
    const othersLots = state.orders.filter((o) => o.id !== orderId).reduce((s, o) => s + o.lots, 0)
      + state.positions.reduce((s, p) => s + p.lots, 0);
    const rulesCheck = validateAgainstRules({ rules, lots: newLots, openPositions: state.positions.length, openOrders: state.orders.length - 1, openLots: othersLots });
    if (!rulesCheck.ok) throw new HttpError(403, "RULE_REJECTED", rulesCheck.error || "Prop rule breached");
    const v = validateOrderModify({ order, quote, price: newPrice, sl: newSl, tp: newTp });
    if (!v.ok) throw new HttpError(400, "BAD_ORDER", v.error || "Invalid order modification");
    const updated = { price: newPrice, lots: newLots, sl: newSl, tp: newTp, modifiedAt: Date.now() };
    tx.update(ordCol(uid, accountId).doc(orderId), updated);
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { ok: true, order: { ...order, ...updated, modifiedAt: undefined }, metrics };
  });
}

/** Close every open position at market (evaluates first so SL/TP settle). */
export async function closeAll(uid: string, accountId: string) {
  const preState = await readState(uid, accountId);
  const { quotes, prices } = await quotesForState(preState);
  return db().runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, accountId);
    applyEvaluationTx(tx, uid, accountId, state, quotes, prices);
    const closed: CloseOutcome[] = [];
    const now = Date.now();
    for (const pos of [...state.positions]) {
      const spec = getInstrument(pos.symbol)!;
      const quote = requireQuote(quotes, pos.symbol);
      const exit = exitPriceFor(pos.side, quote);
      const swap = settleSwap(state, pos, now);
      const pnl = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
      state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
      const outcome: CloseOutcome = {
        symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, exit,
        pnl, swap, reason: "manual", openedAt: pos.openedAt, closedAt: now, positionId: pos.id,
      };
      closed.push(outcome);
      recordClose(state, tx, uid, accountId, outcome);
      tx.delete(posCol(uid, accountId).doc(pos.id));
    }
    state.positions = [];
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { closed, metrics };
  });
}

export async function cancelOrder(uid: string, accountId: string, orderId: string) {
  const ref = ordCol(uid, accountId).doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "NO_ORDER", "Order not found");
  await ref.delete();
  return { ok: true };
}
