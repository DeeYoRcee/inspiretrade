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
import { HttpError, firestore } from "../lib/firebase";
import { getInstrument } from "../../../shared/terminal";
import {
  DEFAULT_LEVERAGE, MIN_LOTS, MAX_LOTS, computeMetrics, evaluateAccount, exitPriceFor,
  positionPnlUsd, validateNewOrder, dayKey,
  type Quote, type PositionLike, type OrderLike, type OrderKind, type Side,
} from "../../../shared/trading-engine";
import { getQuotes, withConversionSymbols } from "./prices";

const MAX_ACCOUNTS = 10;
const MAX_OPEN_POSITIONS = 30;
const MAX_PENDING_ORDERS = 30;
const TRADE_HISTORY_KEEP = 500;

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
  type: "DEMO";
  balance: number;
  startingBalance: number;
  leverage: number;
  status: "active";
  createdAt: number;
  dayStart: Record<string, number>;
}

interface AccountState {
  id: string;
  account: AccountDoc;
  positions: (PositionLike & { comment?: string })[];
  orders: OrderLike[];
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

interface CloseOutcome { symbol: string; side: Side; lots: number; entry: number; exit: number; pnl: number; reason: string; openedAt: number; closedAt: number; positionId: string }

function writeTradeDoc(tx: any, uid: string, aid: string, o: CloseOutcome) {
  tx.set(tradeCol(uid, aid).doc(), { ...o });
}

/**
 * Apply SL/TP exits + stop-out + pending fills to the in-transaction state.
 * Mutates state.positions / state.orders / state.account.balance and queues
 * all Firestore writes. Returns the realized close outcomes and fill count.
 */
function applyEvaluationTx(
  tx: any, uid: string, aid: string, state: AccountState,
  quotes: Record<string, Quote>, prices: Record<string, number>,
): { closed: CloseOutcome[]; filled: number } {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const result = evaluateAccount({
    balance: state.account.balance,
    positions: state.positions,
    orders: state.orders,
    quotes,
    prices,
    leverage,
  });
  const closed: CloseOutcome[] = [];

  // stop-out force-closes everything; otherwise close the SL/TP hits
  const toClose: { pos: PositionLike; exit: number; reason: string }[] = [];
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
    const pnl = positionPnlUsd(spec, pos.side, pos.lots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    closed.push({
      symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, exit,
      pnl, reason, openedAt: pos.openedAt, closedAt: Date.now(), positionId: pos.id,
    });
    tx.delete(posCol(uid, aid).doc(pos.id));
    state.positions = state.positions.filter((p) => p.id !== pos.id);
  }
  for (const o of closed) writeTradeDoc(tx, uid, aid, o);

  for (const f of result.fills) {
    const order = state.orders.find((o) => o.id === f.orderId);
    if (!order) continue;
    const posRef = posCol(uid, aid).doc();
    const pos: PositionLike = {
      id: posRef.id, symbol: order.symbol, side: order.side, lots: order.lots,
      entry: f.entry, sl: order.sl, tp: order.tp, openedAt: Date.now(),
    };
    tx.set(posRef, { symbol: pos.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, sl: pos.sl, tp: pos.tp, openedAt: pos.openedAt });
    tx.delete(ordCol(uid, aid).doc(order.id));
    state.orders = state.orders.filter((o) => o.id !== order.id);
    state.positions.push(pos);
  }

  // daily balance snapshot (for daily-drawdown rules)
  const today = dayKey();
  const dayStart = { ...(state.account.dayStart || {}) };
  if (dayStart[today] == null) dayStart[today] = state.account.balance;
  state.account.dayStart = dayStart;

  return { closed, filled: result.fills.length };
}

/** Persist account balance/dayStart + cached metrics after evaluation. */
function persistAccountTx(tx: any, uid: string, aid: string, state: AccountState, quotes: Record<string, Quote>, prices: Record<string, number>) {
  const leverage = state.account.leverage || DEFAULT_LEVERAGE;
  const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
  tx.update(accountsCol(uid).doc(aid), {
    balance: state.account.balance,
    dayStart: state.account.dayStart,
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
  const [posSnap, ordSnap] = await Promise.all([
    posCol(uid, aid).get(),
    ordCol(uid, aid).get(),
  ]);
  const positions = posSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const orders = ordSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { id: aid, account: accSnap.data() as AccountDoc, positions, orders };
}

export async function listAccounts(uid: string) {
  const snap = await accountsCol(uid).orderBy("createdAt", "asc").get();
  const out = [];
  for (const doc of snap.docs) {
    const state = await readState(uid, doc.id);
    const { quotes, prices } = await quotesForState(state);
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, state.account.leverage || DEFAULT_LEVERAGE);
    out.push({
      id: doc.id, label: state.account.label, type: state.account.type,
      balance: state.account.balance, startingBalance: state.account.startingBalance,
      leverage: state.account.leverage, createdAt: state.account.createdAt,
      dayStart: state.account.dayStart ?? {},
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

export async function createAccount(uid: string, label?: string, startingBalance?: number) {
  const existing = await accountsCol(uid).get();
  if (existing.size >= MAX_ACCOUNTS) throw new HttpError(409, "TOO_MANY_ACCOUNTS", `Maximum ${MAX_ACCOUNTS} accounts`);
  const balance = Math.round(Math.min(5_000_000, Math.max(1_000, Number(startingBalance) || 100_000)) * 100) / 100;
  const today = dayKey();
  const doc = {
    label: String(label || "DEMO").slice(0, 32) || "DEMO",
    type: "DEMO" as const,
    balance, startingBalance: balance,
    leverage: DEFAULT_LEVERAGE,
    status: "active" as const,
    createdAt: Date.now(),
    dayStart: { [today]: balance },
  };
  const ref = await accountsCol(uid).add(doc);
  return { id: ref.id, ...doc, metrics: computeMetrics(balance, [], {}, {}, DEFAULT_LEVERAGE), positions: [], orders: [] };
}

export async function resetAccount(uid: string, aid: string) {
  const dbRef = db();
  const accRef = accountsCol(uid).doc(aid);
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
  return {
    id: aid,
    account: accSnap.data() as AccountDoc,
    positions: posSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })),
    orders: ordSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })),
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
  const kind: OrderKind = req.kind === "limit" || req.kind === "stop" ? req.kind : "market";
  const dbRef = db();
  const accRef = accountsCol(uid).doc(req.accountId);

  const preState = await readState(uid, req.accountId);
  const { quotes, prices } = await quotesForState(preState, [spec.symbol]);

  return dbRef.runTransaction(async (tx: any) => {
    const state = await txGetState(tx, uid, req.accountId);
    // bring the account fully up to date first (SL/TP/pending/stop-out)
    applyEvaluationTx(tx, uid, req.accountId, state, quotes, prices);

    const leverage = state.account.leverage || DEFAULT_LEVERAGE;
    const metrics = computeMetrics(state.account.balance, state.positions, quotes, prices, leverage);
    const quote = requireQuote(quotes, spec.symbol);
    const v = validateNewOrder({
      spec, side: req.side, kind, lots: Number(req.lots), price: req.price ?? null,
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
        symbol: spec.symbol, side: req.side, lots: Number(req.lots),
        entry: v.entry!, sl: req.sl ?? null, tp: req.tp ?? null,
        openedAt: Date.now(), comment: String(req.comment || "").slice(0, 120) || null,
      };
      tx.set(posRef, pos);
      const m2 = computeMetrics(state.account.balance, [...state.positions, { id: posRef.id, ...pos }], quotes, prices, leverage);
      tx.update(accRef, {
        dayStart: state.account.dayStart,
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
      symbol: spec.symbol, side: req.side, kind, lots: Number(req.lots),
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
    const pnl = positionPnlUsd(spec, pos.side, closeLots, pos.entry, exit, prices);
    state.account.balance = Math.round((state.account.balance + pnl) * 100) / 100;
    const outcome: CloseOutcome = {
      symbol: pos.symbol, side: pos.side, lots: closeLots, entry: pos.entry, exit,
      pnl, reason: "manual", openedAt: pos.openedAt, closedAt: Date.now(), positionId: pos.id,
    };
    writeTradeDoc(tx, uid, accountId, outcome);
    if (closeLots === pos.lots) {
      tx.delete(posCol(uid, accountId).doc(pos.id));
      state.positions = state.positions.filter((p) => p.id !== pos.id);
    } else {
      const remaining = Math.round((pos.lots - closeLots) * 100) / 100;
      tx.update(posCol(uid, accountId).doc(pos.id), { lots: remaining });
      pos.lots = remaining;
    }
    const metrics = persistAccountTx(tx, uid, accountId, state, quotes, prices);
    return { closed: outcome, metrics, exit, quote };
  });
}

export async function modifyPosition(uid: string, accountId: string, positionId: string, sl: number | null, tp: number | null) {
  const snap = await posCol(uid, accountId).doc(positionId).get();
  const data = snap.data();
  if (!data) throw new HttpError(404, "NO_POSITION", "Position not found");
  const entry = Number(data.entry);
  const num = (x: unknown) => (x == null || x === "" ? null : Number(x));
  const slNum = num(sl), tpNum = num(tp);
  const side: Side = data.side;
  if (slNum != null && !Number.isFinite(slNum)) throw new HttpError(400, "BAD_SL", "Invalid Stop Loss");
  if (tpNum != null && !Number.isFinite(tpNum)) throw new HttpError(400, "BAD_TP", "Invalid Take Profit");
  if (side === "buy") {
    if (slNum != null && slNum >= entry) throw new HttpError(400, "BAD_SL", "For a BUY, Stop Loss must be below the entry price");
    if (tpNum != null && tpNum <= entry) throw new HttpError(400, "BAD_TP", "For a BUY, Take Profit must be above the entry price");
  } else {
    if (slNum != null && slNum <= entry) throw new HttpError(400, "BAD_SL", "For a SELL, Stop Loss must be above the entry price");
    if (tpNum != null && tpNum >= entry) throw new HttpError(400, "BAD_TP", "For a SELL, Take Profit must be below the entry price");
  }
  const patch: Record<string, unknown> = { slModifiedAt: Date.now() };
  if (sl !== undefined) patch.sl = slNum;
  if (tp !== undefined) patch.tp = tpNum;
  await posCol(uid, accountId).doc(positionId).update(patch);
  return { ok: true, ...patch, sl: slNum, tp: tpNum };
}

export async function cancelOrder(uid: string, accountId: string, orderId: string) {
  const ref = ordCol(uid, accountId).doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "NO_ORDER", "Order not found");
  await ref.delete();
  return { ok: true };
}
