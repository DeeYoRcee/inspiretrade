/**
 * Prop-firm administration — challenge templates, account assignment,
 * monitoring, suspension and resets.
 *
 * Every function here runs with the Admin SDK behind `requireAdmin` (see
 * trading/index.ts routes); clients have zero direct Firestore access and
 * every admin mutation is recorded in the immutable `propAudit` collection.
 */
import { HttpError, firestore, rtdb } from "../lib/firebase";
import { computeMetrics, type PropRules, type AccountStatus } from "../../../shared/trading-engine";
import { getQuotes } from "./prices";
import * as store from "./store";

const challengeTypesCol = () => firestore().collection("challengeTypes");
const auditCol = () => firestore().collection("propAudit");
const settingsDoc = () => firestore().collection("settings").doc("leaderboard");

export const ALLOWED_LEVERAGES = [10, 20, 30, 50, 100, 200, 500];

// ---------------------------------------------------------------------------
// Challenge templates
// ---------------------------------------------------------------------------

export interface ChallengeTypeInfo {
  id: string;
  name: string;
  size: number;
  profitTargetPct: number | null;
  dailyLossLimitPct: number | null;
  maxDrawdownPct: number | null;
  minTradingDays: number;
  maxTradingDays: number | null;
  maxLotsPerOrder: number | null;
  maxLotsTotal: number | null;
  maxOpenPositions: number | null;
  leverage: number;
  active: boolean;
  description: string;
  createdAt: number;
  updatedAt: number;
}

const clampPct = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

/** Sanitize an admin-supplied challenge template (all inputs untrusted). */
export function sanitizeChallengeType(raw: any): Omit<ChallengeTypeInfo, "id" | "createdAt" | "updatedAt"> {
  const size = Math.round(Number(raw.size));
  if (!Number.isFinite(size) || ![5000, 10000, 25000, 50000, 100000].includes(size)) {
    throw new HttpError(400, "BAD_SIZE", "Account size must be one of $5,000 / $10,000 / $25,000 / $50,000 / $100,000");
  }
  const name = String(raw.name || "").trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, "BAD_NAME", "Challenge name must be at least 2 characters");
  const leverageRaw = Number(raw.leverage);
  const type = {
    name,
    size,
    profitTargetPct: clampPct(raw.profitTargetPct, 0.5, 100),
    dailyLossLimitPct: clampPct(raw.dailyLossLimitPct, 0.5, 50),
    maxDrawdownPct: clampPct(raw.maxDrawdownPct, 0.5, 50),
    minTradingDays: Math.min(60, Math.max(0, Math.floor(Number(raw.minTradingDays) || 0))),
    maxTradingDays: clampPct(raw.maxTradingDays, 0, 365),
    maxLotsPerOrder: clampPct(raw.maxLotsPerOrder, 0.01, 100),
    maxLotsTotal: clampPct(raw.maxLotsTotal, 0.01, 100),
    maxOpenPositions: raw.maxOpenPositions == null || raw.maxOpenPositions === ""
      ? null
      : Math.min(30, Math.max(1, Math.floor(Number(raw.maxOpenPositions) || 1))),
    leverage: ALLOWED_LEVERAGES.includes(leverageRaw) ? leverageRaw : 100,
    active: raw.active === undefined ? true : !!raw.active,
    description: String(raw.description || "").slice(0, 400),
  };
  if (type.profitTargetPct == null && type.dailyLossLimitPct == null && type.maxDrawdownPct == null) {
    throw new HttpError(400, "BAD_RULES", "A challenge needs at least a profit target or a drawdown limit");
  }
  return type;
}

export async function listChallengeTypes(activeOnly = false): Promise<ChallengeTypeInfo[]> {
  const snap = await challengeTypesCol().get();
  const rows = snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) as ChallengeTypeInfo[];
  rows.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  return activeOnly ? rows.filter((r) => r.active !== false) : rows;
}

export async function saveChallengeType(body: any, admin: { uid: string; email?: string }) {
  const type = sanitizeChallengeType(body);
  const now = Date.now();
  let id = String(body.id || "").trim();
  if (id) {
    const ref = challengeTypesCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, "NO_CHALLENGE_TYPE", "Challenge type not found");
    await ref.update({ ...type, updatedAt: now });
  } else {
    const ref = await challengeTypesCol().add({ ...type, createdAt: now, updatedAt: now });
    id = ref.id;
  }
  await writeAudit(admin, "challenge_type_save", { challengeTypeId: id, name: type.name, size: type.size });
  return { id, ...type };
}

export async function deleteChallengeType(id: string, admin: { uid: string; email?: string }) {
  const ref = challengeTypesCol().doc(String(id || "").trim());
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "NO_CHALLENGE_TYPE", "Challenge type not found");
  await ref.delete();
  await writeAudit(admin, "challenge_type_delete", { challengeTypeId: id, name: snap.data()?.name });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** Resolve an admin-supplied target to a uid (direct uid or @username). */
async function resolveTargetUid(body: any): Promise<string> {
  const uid = String(body.uid || "").trim();
  if (uid) return uid;
  const username = String(body.username || body.target || "").trim().toLowerCase().replace(/^@/, "");
  if (!username) throw new HttpError(400, "MISSING_TARGET", "Provide a uid or username");
  const resolved = (await rtdb().ref(`usernames/${username}`).once("value")).val();
  if (typeof resolved !== "string" || !resolved) {
    throw new HttpError(404, "USER_NOT_FOUND", `No user with username "${username}"`);
  }
  return resolved;
}

/** Build the account's PropRules from a sanitized template. */
function rulesFromTemplate(t: any): PropRules {
  return {
    dailyLossLimitPct: t.dailyLossLimitPct ?? null,
    maxDrawdownPct: t.maxDrawdownPct ?? null,
    profitTargetPct: t.profitTargetPct ?? null,
    minTradingDays: t.minTradingDays || 0,
    maxLotsTotal: t.maxLotsTotal ?? null,
    maxLotsPerOrder: t.maxLotsPerOrder ?? null,
    maxOpenPositions: t.maxOpenPositions ?? null,
    maxTradingDays: t.maxTradingDays ?? null,
  };
}

export async function assignChallengeAccount(admin: { uid: string; email?: string }, body: any) {
  const uid = await resolveTargetUid(body);
  const typeId = String(body.typeId || "").trim();
  const snap = await challengeTypesCol().doc(typeId).get();
  if (!snap.exists) throw new HttpError(404, "NO_CHALLENGE_TYPE", "Challenge type not found");
  const t = { id: snap.id, ...snap.data() } as ChallengeTypeInfo;
  if (t.active === false) throw new HttpError(409, "CHALLENGE_INACTIVE", "This challenge type is deactivated");
  const account = await store.createAccount(uid, t.name.slice(0, 32), t.size, {
    leverage: t.leverage,
    rules: rulesFromTemplate(t),
    challengeTypeId: t.id,
    challengeName: t.name,
  });
  await writeAudit(admin, "account_assign", { uid, aid: account.id, challengeTypeId: t.id, name: t.name, size: t.size });
  return { uid, account };
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

export interface AdminAccountRow {
  uid: string;
  aid: string;
  label: string;
  challengeName: string | null;
  challengeTypeId: string | null;
  balance: number;
  startingBalance: number;
  profitPct: number;
  status: AccountStatus;
  adminSuspended: boolean;
  failedReason: string | null;
  stats: { totalTrades: number; wins: number; losses: number };
  tradingDays: number;
  startedAt: number | null;
  createdAt: number;
  traderName: string;
}

/** @username map (username → uid), inverted for display names. */
async function traderNames(): Promise<Record<string, string>> {
  try {
    const snap = await rtdb().ref("usernames").once("value");
    const map = (snap.val() || {}) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [name, uid] of Object.entries(map)) if (typeof uid === "string") out[uid] = name;
    return out;
  } catch {
    return {};
  }
}

export async function listAllChallengeAccounts(status?: string): Promise<AdminAccountRow[]> {
  const snap = await firestore().collectionGroup("accounts").where("type", "==", "CHALLENGE").limit(300).get();
  const names = await traderNames();
  const rows: AdminAccountRow[] = [];
  for (const doc of snap.docs) {
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    const a = doc.data() || {};
    const startingBalance = Number(a.startingBalance) || 0;
    const balance = Number(a.balance) || 0;
    const row: AdminAccountRow = {
      uid,
      aid: doc.id,
      label: a.label || "CHALLENGE",
      challengeName: a.challengeName ?? null,
      challengeTypeId: a.challengeTypeId ?? null,
      balance,
      startingBalance,
      profitPct: startingBalance > 0 ? Math.round(((balance - startingBalance) / startingBalance) * 10000) / 100 : 0,
      status: (a.status || "active") as AccountStatus,
      adminSuspended: !!a.adminSuspended,
      failedReason: a.failedReason ?? null,
      stats: a.stats || { totalTrades: 0, wins: 0, losses: 0 },
      tradingDays: Object.keys(a.tradingDays || {}).length,
      startedAt: a.startedAt ?? a.createdAt ?? null,
      createdAt: a.createdAt || 0,
      traderName: names[uid] ? `@${names[uid]}` : `trader ${uid.slice(0, 6)}`,
    };
    if (status && status !== "all") {
      const wanted = status === "suspended" ? row.adminSuspended : row.status === status && !row.adminSuspended;
      if (!wanted) continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}

export async function accountDetail(uid: string, aid: string) {
  const db = firestore();
  const accRef = db.collection("users").doc(uid).collection("accounts").doc(aid);
  const [accSnap, posSnap, ordSnap, tradeSnap] = await Promise.all([
    accRef.get(),
    accRef.collection("positions").get(),
    accRef.collection("orders").get(),
    accRef.collection("trades").orderBy("closedAt", "desc").limit(50).get(),
  ]);
  if (!accSnap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const account = accSnap.data() || {};
  const positions = posSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const orders = ordSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const trades = tradeSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const symbols = [...new Set([...positions.map((p: any) => p.symbol), ...orders.map((o: any) => o.symbol)])];
  const quotes = symbols.length ? await getQuotes(symbols) : {};
  const prices: Record<string, number> = {};
  for (const [sym, q] of Object.entries(quotes)) prices[sym] = q.mid;
  const metrics = computeMetrics(
    Number(account.balance) || 0,
    positions as any,
    quotes as any,
    prices,
    Number(account.leverage) || 100,
  );
  const names = await traderNames();
  return {
    uid,
    aid,
    traderName: names[uid] ? `@${names[uid]}` : `trader ${uid.slice(0, 6)}`,
    account: {
      label: account.label,
      type: account.type,
      challengeName: account.challengeName ?? null,
      challengeTypeId: account.challengeTypeId ?? null,
      balance: account.balance,
      startingBalance: account.startingBalance,
      leverage: account.leverage,
      status: account.status || "active",
      adminSuspended: !!account.adminSuspended,
      rules: account.rules ?? null,
      failedReason: account.failedReason ?? null,
      startedAt: account.startedAt ?? account.createdAt ?? null,
      createdAt: account.createdAt,
      peakEquity: account.peakEquity ?? account.balance,
      tradingDays: Object.keys(account.tradingDays || {}).length,
      stats: account.stats || { totalTrades: 0, wins: 0, losses: 0 },
      dayStart: account.dayStart || {},
    },
    positions,
    orders,
    trades,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Account state — suspend / reactivate / force reset
// ---------------------------------------------------------------------------

export async function setAccountState(
  admin: { uid: string; email?: string },
  body: { uid?: string; aid?: string; action?: string },
) {
  const uid = String(body.uid || "").trim();
  const aid = String(body.aid || "").trim();
  const action = String(body.action || "");
  if (!uid || !aid) throw new HttpError(400, "BAD_TARGET", "uid and aid are required");
  const accRef = firestore().collection("users").doc(uid).collection("accounts").doc(aid);
  const snap = await accRef.get();
  if (!snap.exists) throw new HttpError(404, "NO_ACCOUNT", "Account not found");
  const acc = snap.data() || {};

  if (action === "suspend") {
    await accRef.update({ adminSuspended: true, suspendedAt: Date.now() });
    await writeAudit(admin, "account_suspend", { uid, aid, challengeName: acc.challengeName ?? null });
    return { ok: true, adminSuspended: true };
  }
  if (action === "reactivate") {
    if (acc.status === "failed") {
      throw new HttpError(409, "ACCOUNT_FAILED", "A failed challenge can only be restored via Reset");
    }
    await accRef.update({ adminSuspended: false, suspendedAt: null });
    await writeAudit(admin, "account_reactivate", { uid, aid });
    return { ok: true, adminSuspended: false };
  }
  if (action === "reset") {
    // authorized reset: close the whole book, cancel pendings, wipe the attempt
    const closeResult = await store.closeAll(uid, aid).catch((e: any) => {
      if (String(e?.message || "").includes("No executable price")) throw e;
      return null; // nothing open / already flat
    });
    await store.resetAccount(uid, aid);
    await writeAudit(admin, "account_reset", { uid, aid, closed: Array.isArray(closeResult?.closed) ? closeResult.closed.length : 0 });
    return { ok: true, reset: true };
  }
  throw new HttpError(400, "BAD_ACTION", "action must be suspend | reactivate | reset");
}

// ---------------------------------------------------------------------------
// Audit log (immutable — only the Admin SDK writes here)
// ---------------------------------------------------------------------------

export async function writeAudit(admin: { uid: string; email?: string }, action: string, details: Record<string, unknown> = {}) {
  try {
    await auditCol().add({
      at: Date.now(),
      by: admin.email || admin.uid,
      byUid: admin.uid,
      action,
      ...details,
    });
  } catch (e) {
    console.error("[admin] audit write failed", e);
  }
}

export async function listAudit(filter: { uid?: string; aid?: string } = {}, limit = 100) {
  let q: any = auditCol();
  if (filter.uid) q = q.where("uid", "==", filter.uid);
  if (filter.aid) q = q.where("aid", "==", filter.aid);
  const snap = await q.limit(Math.min(300, Math.max(1, limit))).get();
  const rows = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  rows.sort((a: any, b: any) => (b.at || 0) - (a.at || 0));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Leaderboard settings
// ---------------------------------------------------------------------------

export async function setLeaderboardEnabled(enabled: boolean, admin: { uid: string; email?: string }) {
  await settingsDoc().set({ enabled: !!enabled, updatedAt: Date.now(), updatedBy: admin.email || admin.uid });
  await writeAudit(admin, "leaderboard_toggle", { enabled: !!enabled });
  return { enabled: !!enabled };
}

export async function getLeaderboardEnabled(): Promise<boolean> {
  try {
    const snap = await settingsDoc().get();
    return snap.exists ? snap.data()?.enabled !== false : true;
  } catch {
    return true;
  }
}
