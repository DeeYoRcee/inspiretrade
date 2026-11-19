/**
 * Phase 7 — platform management handlers (user management, analytics, live
 * monitor, admin alerts, platform settings, roles). Every handler resolves
 * the caller's role server-side and enforces the shared permission matrix
 * (shared/roles.ts) — frontend checks are never trusted.
 *
 * All admin mutations append to the immutable propAudit collection with the
 * administrator identity, timestamp and action details.
 */
import * as adminNamespace from "firebase-admin";
const adminPkg: any = (adminNamespace as any).default ?? adminNamespace;
import { HttpError, rtdb, firestore, type AuthedUser } from "../lib/firebase";
import { getAdminRole, writeAdminAlert, getPlatformSettings, invalidateSettingsCache } from "../lib/platform";
import { assertRole } from "./platform-guard";
import * as store from "../trading/store";
import { getQuotes } from "../trading/prices";
import { getInstrument } from "../../../shared/terminal";
import { convQuoteToUsd } from "../../../shared/trading-engine";
import {
  ADMIN_ROLES, bucketByDay, maskEmail, sanitizePlatformSettings,
  type AdminRole, type PlatformSettings,
} from "../../../shared/roles";

const MAX_LIST_USERS = 1000;

function db() { return firestore(); }
function adminAuth(): any {
  return adminPkg.auth();
}

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

async function audit(admin: AuthedUser, action: string, details: Record<string, unknown> = {}) {
  try {
    await db().collection("propAudit").add({
      at: Date.now(), by: admin.email || admin.uid, byUid: admin.uid, action, ...details,
    });
  } catch (e) {
    console.error("[admin] audit write failed", e);
  }
}

// ---------------------------------------------------------------------------
// 1. USER MANAGEMENT
// ---------------------------------------------------------------------------

interface AuthUserRow {
  uid: string;
  email: string;
  displayName: string;
  username: string | null;
  emailVerified: boolean;
  disabled: boolean;
  restricted: boolean;
  creationTime: number;
  lastSignInTime: number | null;
  coins: number | null;
  role: AdminRole | null;
}

async function fetchAuthUsers(): Promise<any[]> {
  const out: any[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3 && out.length < MAX_LIST_USERS; page++) {
    const res = await adminAuth().listUsers(1000, pageToken);
    out.push(...res.users);
    pageToken = res.pageToken;
    if (!pageToken) break;
  }
  return out;
}

/** Registration alerts: diff against the knownUsers marker (throttled here). */
async function flagNewUsers(users: any[]) {
  try {
    const knownRef = rtdb().ref("adminState/knownUsers");
    const known = (await knownRef.once("value")).val() || {};
    const fresh = users.filter((u: any) => !known[u.uid]);
    for (const u of fresh.slice(0, 10)) {
      await writeAdminAlert({
        type: "new_user", severity: "info",
        text: `New registration: ${u.email || u.uid}`,
        uid: u.uid, details: { email: u.email || null },
      });
    }
    if (fresh.length) {
      const patch: Record<string, boolean> = {};
      for (const u of fresh) patch[u.uid] = true;
      await knownRef.update(patch);
    }
  } catch (e) {
    console.error("[admin] registration diff failed", e);
  }
}

export async function listUsers(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "users.read");
  const q = String(body?.q || body?.query || "").trim().toLowerCase();
  const status = String(body?.status || "all");

  const [users, names, rolesSnap, restrictedSnap, ecoSnap] = await Promise.all([
    fetchAuthUsers(),
    traderNames(),
    rtdb().ref("adminRoles").once("value"),
    rtdb().ref("restricted").once("value"),
    rtdb().ref("economy").once("value"),
  ]);
  const roles = (rolesSnap.val() || {}) as Record<string, string>;
  const restricted = (restrictedSnap.val() || {}) as Record<string, boolean>;
  const economy = (ecoSnap.val() || {}) as Record<string, any>;

  void flagNewUsers(users);

  const rows: AuthUserRow[] = users.map((u: any) => {
    const email = String(u.email || "");
    return {
      uid: u.uid,
      email: role === "analyst" ? maskEmail(email) : email,
      displayName: names[u.uid] ? `@${names[u.uid]}` : email.split("@")[0] || u.uid.slice(0, 8),
      username: names[u.uid] || null,
      emailVerified: !!u.emailVerified,
      disabled: !!u.disabled,
      restricted: !!restricted[u.uid],
      creationTime: new Date(u.metadata?.creationTime || 0).getTime(),
      lastSignInTime: u.metadata?.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : null,
      coins: typeof economy[u.uid]?.coins === "number" ? economy[u.uid].coins : null,
      role: (roles[u.uid] as AdminRole) || null,
    };
  });

  let filtered = rows;
  if (q) {
    filtered = filtered.filter((r) =>
      r.email.toLowerCase().includes(q) || r.uid.toLowerCase().includes(q)
      || (r.username || "").toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q),
    );
  }
  const now = Date.now();
  if (status === "suspended") filtered = filtered.filter((r) => r.disabled);
  else if (status === "active") filtered = filtered.filter((r) => !r.disabled);
  else if (status === "recent") filtered = filtered.filter((r) => now - r.creationTime < 30 * 86_400_000);
  filtered.sort((a, b) => b.creationTime - a.creationTime);
  return { users: filtered.slice(0, 300), total: rows.length, filtered: filtered.length };
}

export async function userDetail(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "users.read");
  const uid = String(body?.uid || "").trim();
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");
  const showFull = role !== "analyst";

  const [authRec, profileSnap, ecoSnap, accSnap, notesSnap, ledgerSnap, names] = await Promise.all([
    adminAuth().getUser(uid).catch(() => null),
    rtdb().ref(`users/${uid}/profile`).once("value"),
    rtdb().ref(`economy/${uid}`).once("value"),
    db().collection(`users/${uid}/accounts`).get(),
    rtdb().ref(`adminNotes/${uid}`).limitToLast(50).once("value"),
    rtdb().ref("ledger").orderByChild("uid").equalTo(uid).limitToLast(40).once("value"),
    traderNames(),
  ]);
  if (!authRec) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  const profile = profileSnap.val() || {};
  const eco = ecoSnap.val() || {};
  const accounts = accSnap.docs.map((d: any) => {
    const a = d.data() || {};
    const starting = Number(a.startingBalance) || 0;
    const balance = Number(a.balance) || 0;
    return {
      aid: d.id,
      label: a.label || "DEMO",
      type: a.type || "DEMO",
      challengeName: a.challengeName ?? null,
      balance,
      startingBalance: starting,
      profitPct: starting > 0 ? Math.round(((balance - starting) / starting) * 10000) / 100 : 0,
      status: a.status || "active",
      adminSuspended: !!a.adminSuspended,
      leverage: a.leverage || 100,
      stats: a.stats || { totalTrades: 0, wins: 0, losses: 0 },
      tradingDays: Object.keys(a.tradingDays || {}).length,
      createdAt: a.createdAt || null,
      rules: a.rules || null,
      failedReason: a.failedReason ?? null,
    };
  });
  const challengeAccounts = accounts.filter((a: any) => a.type === "CHALLENGE");
  const notes: any[] = [];
  const notesVal = notesSnap.val() || {};
  for (const [id, n] of Object.entries(notesVal as Record<string, any>)) notes.push({ id, ...(n as any) });
  notes.sort((a, b) => (b.at || 0) - (a.at || 0));
  const activity: any[] = [];
  const ledgerVal = ledgerSnap.val() || {};
  for (const [id, e] of Object.entries(ledgerVal as Record<string, any>)) activity.push({ id, ...(e as any) });
  activity.sort((a, b) => (b.at || 0) - (a.at || 0));

  const email = String(authRec.email || "");
  return {
    uid,
    email: showFull ? email : maskEmail(email),
    displayName: names[uid] ? `@${names[uid]}` : email.split("@")[0] || uid.slice(0, 8),
    username: profile.username || names[uid] || null,
    ceo: !!profile.ceo,
    emailVerified: !!authRec.emailVerified,
    disabled: !!authRec.disabled,
    restricted: !!((await rtdb().ref(`restricted/${uid}`).once("value")).val()),
    creationTime: new Date(authRec.metadata?.creationTime || 0).getTime(),
    lastSignInTime: authRec.metadata?.lastSignInTime ? new Date(authRec.metadata.lastSignInTime).getTime() : null,
    provider: (authRec.providerData || []).map((p: any) => p.providerId).filter(Boolean),
    economy: { coins: eco.coins ?? null, cases: eco.cases ?? null, goldCases: eco.goldCases ?? null, totalClaimed: eco.totalClaimed ?? null },
    profileBio: String(profile.bio || "").slice(0, 200) || null,
    accounts,
    challengeProgress: {
      assigned: challengeAccounts.length,
      passed: challengeAccounts.filter((a: any) => a.status === "passed").length,
      failed: challengeAccounts.filter((a: any) => a.status === "failed").length,
      active: challengeAccounts.filter((a: any) => a.status === "active").length,
      totalTrades: accounts.reduce((s: number, a: any) => s + (a.stats?.totalTrades || 0), 0),
      wins: accounts.reduce((s: number, a: any) => s + (a.stats?.wins || 0), 0),
    },
    notes,
    activity,
  };
}

export async function setUserState(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "user.suspend");
  const uid = String(body?.uid || "").trim();
  const action = String(body?.action || "");
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");
  if (uid === admin.uid) throw new HttpError(400, "SELF_ACTION", "Administrators cannot change their own access state");

  if (action === "suspend" || action === "reactivate") {
    const disabled = action === "suspend";
    await adminAuth().updateUser(uid, { disabled });
    // suspension also freezes trading; reactivation lifts both
    await rtdb().ref(`restricted/${uid}`).set(disabled);
    await writeAdminAlert({
      type: "user_state", severity: disabled ? "warning" : "info",
      text: `User ${disabled ? "suspended" : "reactivated"} (${uid.slice(0, 8)}…) by ${admin.email || admin.uid}`,
      uid,
    });
    await audit(admin, `user_${action}`, { uid });
    return { ok: true, disabled, restricted: disabled };
  }
  if (action === "restrict" || action === "unrestrict") {
    const restricted = action === "restrict";
    await rtdb().ref(`restricted/${uid}`).set(restricted);
    await writeAdminAlert({
      type: "user_state", severity: restricted ? "warning" : "info",
      text: `Trading ${restricted ? "restricted" : "unrestricted"} for ${uid.slice(0, 8)}… by ${admin.email || admin.uid}`,
      uid,
    });
    await audit(admin, `user_${action}`, { uid });
    return { ok: true, restricted };
  }
  throw new HttpError(400, "BAD_ACTION", "action must be suspend | reactivate | restrict | unrestrict");
}

/**
 * Public-profile redirect stubs (Phase 18 repair): admin username moves leave
 * { redirect } records at old handles. A chain that ends nowhere (or a stub
 * at the PUBLISHED handle) makes every client-side save fail with
 * PERMISSION_DENIED — the owner rules require data.uid === auth.uid and a
 * stub has no uid, so the account can never overwrite it. This admin action
 * purges every stub at the handles a user owns so the client can republish
 * cleanly. Permission: user.note-level admins and up.
 */
export async function purgeProfileStubs(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "user.note");
  const uid = String(body?.uid || admin.uid).trim();
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");

  const dbR = rtdb();
  const registry = (await dbR.ref("usernames").once("value")).val() || {};
  const owned = Object.entries(registry).filter(([, owner]) => owner === uid).map(([k]) => k);
  const settingsSnap = await dbR.ref(`privatePublicProfileSettings/${uid}`).once("value");
  const published = String(settingsSnap.val()?.publishedUsername || "").toLowerCase();
  const targets = Array.from(new Set([...owned, ...(published ? [published] : [])]));

  const purged: string[] = [];
  for (const key of targets) {
    const snap = await dbR.ref(`publicProfiles/${key}`).once("value");
    if (!snap.exists()) continue;
    const val = snap.val() || {};
    const isStub = typeof val.redirect === "string" && !val.uid;
    const brokenSnapshot = !!val.uid && val.uid === uid && !(val.username && val.usernameKey && val.displayName);
    const foreignSnapshot = !!val.uid && val.uid !== uid;
    if (foreignSnapshot) continue; // never touch another user's live snapshot
    if (isStub || brokenSnapshot) {
      await dbR.ref(`publicProfiles/${key}`).remove();
      purged.push(key);
    }
  }
  await writeAdminAlert({
    type: "platform", severity: "info",
    text: `Purged ${purged.length} public-profile stub(s) for ${uid.slice(0, 8)}… by ${admin.email || admin.uid}`,
    uid,
  });
  await audit(admin, "profile_stub_purge", { uid, purged });
  return { ok: true, uid, owned: targets, purged };
}

export async function addNote(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "user.note");
  const uid = String(body?.uid || "").trim();
  const text = String(body?.text || "").trim().slice(0, 500);
  if (!uid || !text) throw new HttpError(400, "BAD_INPUT", "uid and text are required");
  const ref = await rtdb().ref(`adminNotes/${uid}`).push({ at: Date.now(), by: admin.email || admin.uid, text });
  await audit(admin, "user_note", { uid });
  return { ok: true, id: ref.key, text };
}

// ---------------------------------------------------------------------------
// 2. ACCOUNT MANAGEMENT (create for a user; suspend/reactivate/reset live in
//    the trading admin surface — role checks added there)
// ---------------------------------------------------------------------------

export async function createAccount(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "account.create");
  const uid = String(body?.uid || "").trim();
  if (!uid) throw new HttpError(400, "MISSING_UID", "uid is required");
  const settings = await getPlatformSettings();
  const balance = Math.max(1000, Math.min(1_000_000, Math.floor(Number(body?.startingBalance) || settings.defaultAccountBalance)));
  const account = await store.createAccount(uid, String(body?.label || "DEMO").slice(0, 32), balance, {
    leverage: Number(body?.leverage) || settings.defaultLeverage,
    rules: null,
  });
  await writeAdminAlert({
    type: "account_state", severity: "info",
    text: `DEMO account ${account.id.slice(0, 8)}… (${balance} USD) created for ${uid.slice(0, 8)}…`,
    uid,
  });
  await audit(admin, "account_create", { uid, aid: account.id, balance });
  return { uid, account };
}

// ---------------------------------------------------------------------------
// 3. PLATFORM ANALYTICS
// ---------------------------------------------------------------------------

export async function analytics(admin: AuthedUser, role: AdminRole) {
  assertRole(role, "analytics.read");
  const now = Date.now();
  const d30 = 30 * 86_400_000;

  const users = await fetchAuthUsers();
  void flagNewUsers(users);
  const creationTimes = users.map((u: any) => new Date(u.metadata?.creationTime || 0).getTime());
  const lastSignIns = users.map((u: any) => (u.metadata?.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : 0));

  const accSnap = await db().collectionGroup("accounts").limit(500).get();
  const accounts = accSnap.docs.map((d: any) => d.data() || {});
  const challenges = accounts.filter((a: any) => a.type === "CHALLENGE");

  const tradesSnap = await db().collectionGroup("trades").limit(3000).get();
  const trades = tradesSnap.docs.map((d: any) => d.data() || {});
  const tradeTimes = trades.map((t: any) => Number(t.closedAt) || 0);
  // conversion prices for non-USD-quoted instruments (fixed minor set)
  const convSymbols = ["USDJPY", "USDCHF", "USDCAD", "EURUSD", "GBPUSD"];
  const convQuotes = await getQuotes(convSymbols);
  const convPrices: Record<string, number> = {};
  for (const [sym, q] of Object.entries(convQuotes)) convPrices[sym] = q.mid;
  const volume = trades.reduce((sum: number, t: any) => {
    const spec = getInstrument(String(t.symbol || ""));
    if (!spec) return sum;
    const notional = (Number(t.lots) || 0) * spec.contractSize * (Number(t.entry) || 0);
    return sum + notional * (convQuoteToUsd(spec.quote, convPrices) || 1);
  }, 0);

  const posSnap = await db().collectionGroup("positions").limit(1000).get();

  return {
    users: {
      total: users.length,
      new30d: creationTimes.filter((t: number) => now - t < d30).length,
      active30d: lastSignIns.filter((t: number) => t && now - t < d30).length,
      suspended: users.filter((u: any) => u.disabled).length,
      registrationsByDay: bucketByDay(creationTimes.filter((t: number) => now - t < d30), 30, now),
    },
    accounts: {
      total: accounts.length,
      demo: accounts.filter((a: any) => a.type !== "CHALLENGE").length,
      challenge: challenges.length,
      challengeActive: challenges.filter((a: any) => a.status === "active" && !a.adminSuspended).length,
      challengePassed: challenges.filter((a: any) => a.status === "passed").length,
      challengeFailed: challenges.filter((a: any) => a.status === "failed").length,
      challengeSuspended: challenges.filter((a: any) => a.adminSuspended).length,
    },
    trading: {
      closedTrades: trades.length,
      openPositions: posSnap.size,
      volumeUsd: Math.round(volume),
    },
    activity: { tradesByDay: bucketByDay(tradeTimes.filter((t: number) => t && now - t < d30), 30, now) },
  };
}

// ---------------------------------------------------------------------------
// 4. LIVE TRADING MONITOR
// ---------------------------------------------------------------------------

export async function liveMonitor(admin: AuthedUser, role: AdminRole) {
  assertRole(role, "monitor.read");
  const accSnap = await db().collectionGroup("accounts").limit(300).get();
  const names = await traderNames();

  const flagged: any[] = [];
  const exposure: Record<string, { lots: number; notional: number }> = {};
  const candidates: { uid: string; aid: string; data: any }[] = [];

  for (const doc of accSnap.docs) {
    const uid = doc.ref.parent.parent?.id;
    const a = doc.data() || {};
    if (!uid) continue;
    const openCount = a.metrics?.openCount || 0;
    if (openCount > 0) candidates.push({ uid, aid: doc.id, data: a });
  }

  const cap = candidates.slice(0, 50);
  const posSnaps = await Promise.all(cap.map((c) => db().collection(`users/${c.uid}/accounts/${c.aid}/positions`).get()));
  const symbolSet = new Set<string>();
  for (const ps of posSnaps) for (const d of ps.docs) symbolSet.add(String(d.data()?.symbol || ""));
  const symbols = [...symbolSet].filter(Boolean);
  const quotes = symbols.length ? await getQuotes(symbols) : {};
  const prices: Record<string, number> = {};
  for (const [sym, q] of Object.entries(quotes)) prices[sym] = q.mid;

  const recentTrades: any[] = [];
  for (let i = 0; i < cap.length; i++) {
    const { uid, aid, data: a } = cap[i];
    const positions = posSnaps[i].docs.map((d: any) => {
      const p = d.data() || {};
      const spec = getInstrument(String(p.symbol || ""));
      const notional = spec ? (Number(p.lots) || 0) * spec.contractSize * (Number(p.entry) || 0) * (convQuoteToUsd(spec.quote, prices) || 1) : 0;
      return { id: d.id, symbol: p.symbol, side: p.side, lots: p.lots, entry: p.entry, sl: p.sl ?? null, tp: p.tp ?? null, openedAt: p.openedAt, notionalUsd: Math.round(notional) };
    });
    for (const p of positions) {
      const e = exposure[p.symbol] || { lots: 0, notional: 0 };
      e.lots += p.lots || 0;
      e.notional += p.notionalUsd || 0;
      exposure[p.symbol] = e;
    }
    const starting = Number(a.startingBalance) || 0;
    const balance = Number(a.balance) || 0;
    const equity = Number(a.metrics?.equity) || balance;
    const rules = a.rules || null;
    const flags: string[] = [];
    if (rules?.maxDrawdownPct && starting > 0 && (balance - starting) / starting <= -(0.6 * rules.maxDrawdownPct) / 100) flags.push("risk");
    if (positions.length >= 10) flags.push("heavy_book");
    const notionalSum = positions.reduce((s: number, p: any) => s + p.notionalUsd, 0);
    if (equity > 0 && notionalSum > 5 * equity) flags.push("high_exposure");
    if (a.adminSuspended) flags.push("suspended");
    if (a.status === "failed") flags.push("failed");

    flagged.push({
      uid, aid,
      traderName: names[uid] ? `@${names[uid]}` : `trader ${uid.slice(0, 6)}`,
      label: a.label || "DEMO",
      type: a.type || "DEMO",
      challengeName: a.challengeName ?? null,
      balance, startingBalance: starting, equity,
      floatingPnl: Number(a.metrics?.floatingPnl) || 0,
      status: a.status || "active",
      adminSuspended: !!a.adminSuspended,
      rules,
      flags,
      positions,
    });

    // recent fills for the recent-activity tape (cap 5 per account)
    const ts = await db().collection(`users/${uid}/accounts/${aid}/trades`).orderBy("closedAt", "desc").limit(5).get();
    for (const d of ts.docs) {
      const t = d.data() || {};
      recentTrades.push({ uid, aid, traderName: names[uid] ? `@${names[uid]}` : uid.slice(0, 6), id: d.id, ...t });
    }
  }

  recentTrades.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  return {
    accounts: flagged,
    exposure: Object.entries(exposure)
      .map(([symbol, e]) => ({ symbol, lots: Math.round(e.lots * 100) / 100, notionalUsd: Math.round(e.notional) }))
      .sort((a, b) => b.notionalUsd - a.notionalUsd),
    recentTrades: recentTrades.slice(0, 30),
    openAccounts: candidates.length,
  };
}

// ---------------------------------------------------------------------------
// 5. ADMIN NOTIFICATIONS
// ---------------------------------------------------------------------------

export async function listAlerts(admin: AuthedUser, role: AdminRole) {
  assertRole(role, "alerts.read");
  const snap = await rtdb().ref("adminAlerts").orderByChild("at").limitToLast(100).once("value");
  const val = (snap.val() || {}) as Record<string, any>;
  const alerts = Object.entries(val)
    .map(([id, a]) => ({ id, ...(a as any) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const unread = alerts.filter((a) => !a.read).length;
  return { alerts, unread };
}

export async function markAlertsRead(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "alerts.manage");
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.slice(0, 100) : [];
  const snap = await rtdb().ref("adminAlerts").orderByChild("read").equalTo(false).once("value").catch(() => null);
  const updates: Record<string, boolean> = {};
  if (ids.length) {
    for (const id of ids) updates[id] = true;
  } else if (snap) {
    const val = (snap.val() || {}) as Record<string, any>;
    for (const id of Object.keys(val)) updates[id] = true;
  }
  if (Object.keys(updates).length) await rtdb().ref("adminAlerts").update(Object.fromEntries(Object.keys(updates).map((id) => [`${id}/read`, true])));
  return { ok: true, marked: Object.keys(updates).length };
}

// ---------------------------------------------------------------------------
// 6. PLATFORM SETTINGS + ROLES
// ---------------------------------------------------------------------------

export async function getSettings(admin: AuthedUser, role: AdminRole) {
  assertRole(role, "settings.read");
  const snap = await db().collection("platformSettings").doc("global").get();
  const raw = snap.exists ? snap.data() || {} : {};
  const settings: PlatformSettings = sanitizePlatformSettings({ ...raw });
  return { settings };
}

export async function saveSettings(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "settings.write");
  const snap = await db().collection("platformSettings").doc("global").get();
  const current = snap.exists ? sanitizePlatformSettings(snap.data() || {}) : undefined;
  const next = sanitizePlatformSettings(body?.settings || body || {}, current);
  next.updatedBy = admin.email || admin.uid;
  await db().collection("platformSettings").doc("global").set(next);
  invalidateSettingsCache();
  await writeAdminAlert({
    type: "settings_changed", severity: next.maintenanceMode ? "warning" : "info",
    text: `Platform settings updated by ${admin.email || admin.uid}${next.maintenanceMode ? " — MAINTENANCE MODE ON" : ""}`,
    details: { maintenance: next.maintenanceMode, symbolsMode: next.symbolsMode },
  });
  await audit(admin, "settings_save", { maintenance: next.maintenanceMode, symbolsMode: next.symbolsMode });
  return { settings: next };
}

export async function getRoles(admin: AuthedUser, role: AdminRole) {
  assertRole(role, "roles.read");
  const snap = await rtdb().ref("adminRoles").once("value");
  const val = (snap.val() || {}) as Record<string, string>;
  const names = await traderNames();
  const users = Object.entries(val).map(([uid, r]) => ({
    uid, role: r, name: names[uid] ? `@${names[uid]}` : null,
  }));
  return { roles: users, myRole: role };
}

export async function setRole(admin: AuthedUser, role: AdminRole, body: any) {
  assertRole(role, "roles.write");
  const uid = String(body?.uid || "").trim();
  const target = String(body?.role || "") as AdminRole;
  if (!uid || !(ADMIN_ROLES as string[]).includes(target)) {
    throw new HttpError(400, "BAD_INPUT", `role must be one of ${ADMIN_ROLES.join(", ")}`);
  }
  if (uid === admin.uid) throw new HttpError(400, "SELF_ROLE", "Administrators cannot change their own role");
  await rtdb().ref(`adminRoles/${uid}`).set(target);
  await writeAdminAlert({
    type: "roles_changed", severity: "warning",
    text: `Role ${target} granted to ${uid.slice(0, 8)}… by ${admin.email || admin.uid}`,
    uid, details: { role: target },
  });
  await audit(admin, "role_set", { uid, role: target });
  return { ok: true, uid, role: target };
}
