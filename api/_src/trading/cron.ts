/**
 * PHASE 64 — reliable server-side position monitoring (24/7 chain model).
 *
 * Vercel Hobby cannot schedule sub-daily crons, so this cron runs as a
 * SELF-CONTINUING CHAIN of bounded invocations:
 *   1. `runTradingCron` acquires a LEASE on platformMonitoring/tradingCron
 *      (Firestore transaction — concurrent invocations never overlap);
 *   2. it sweeps every trading account that needs evaluation — open positions,
 *      pending orders and active challenge accounts — with a PERSISTED CURSOR
 *      so an interrupted or budget-exhausted pass resumes exactly where it
 *      stopped (re-running a partially processed page is safe: store.evaluate
 *      is idempotent);
 *   3. it writes full diagnostics (lastRunAt, processed/failed/remaining,
 *      cursors, lastError, provider-health counters) into the monitoring doc;
 *   4. it re-invokes ITSELF (authenticated self-fetch) so the chain continues
 *      indefinitely — no browser, no client heartbeat, no external scheduler.
 * A dropped hop is re-seeded by the daily alerts-cron floor AND by any
 * authenticated `evaluate` request (kickCronChainIfStale — e.g. the client
 * heartbeat of an online user). Financial execution itself is ALWAYS the
 * shared transactional engine (store.evaluate → applyEvaluationTx) — the
 * chain is only the scheduler.
 */
import { firestore } from "../lib/firebase";
import { writeAdminAlert } from "../lib/platform";
import * as store from "./store";

export interface TradingCronResult {
  ok: boolean;
  targets: number;
  processed: number;
  failed: number;
  remaining: number;
  runMs: number;
  errors: string[];
  /** PHASE 64 — set when the lease said another pass is already running */
  skipped?: string;
}

/** Work budget per invocation — trading.js runs with maxDuration 60. */
export const CHAIN_BUDGET_MS = 45_000;
/** Lease window — a hung run blocks the chain for at most this long. */
export const LEASE_MS = 90_000;
/** A chain hop is kicked when the monitoring doc has not advanced this long. */
export const KICK_STALE_MS = 90_000;
/** Page sizes for the resumable collection-group sweeps. */
const PAGE_POSITIONS = 300;
const PAGE_ORDERS = 300;
const PAGE_ACCOUNTS = 400;

/** Fire the next chain hop. A dropped hop is re-seeded by the daily floor
 *  and by heartbeat kicks — the chain is self-healing, not lossless. */
async function fireChainHop(baseUrl: string, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  try {
    const c = fetch(`${baseUrl}/api/trading?action=cron-evaluate`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    c.catch(() => { /* the next kick/floor re-seeds */ });
    // keep the lambda alive until the request actually leaves the runtime
    await new Promise((r) => setTimeout(r, 400));
    return true;
  } catch {
    return false;
  }
}

/** PHASE 64 §3 — kick the chain when it has gone quiet. Called from the
 *  authenticated `evaluate` route (client heartbeat / any mutation): the
 *  browser is a SEED, never the authority. Module-throttled so concurrent
 *  user requests do not stampede the monitoring doc. */
let lastKickCheck = 0;
export async function kickCronChainIfStale(baseUrl: string): Promise<void> {
  const now = Date.now();
  if (now - lastKickCheck < 30_000) return;
  lastKickCheck = now;
  try {
    const dbx = firestore();
    const cur = (await dbx.collection("platformMonitoring").doc("tradingCron").get()).data() as
      { runningUntil?: number; lastRunAt?: number } | undefined;
    if (cur?.runningUntil && cur.runningUntil > now) return; // chain alive
    if (cur?.lastRunAt && now - cur.lastRunAt < KICK_STALE_MS) return;
    await fireChainHop(baseUrl, process.env.CRON_SECRET);
  } catch { /* diagnostics only — never break the trading request */ }
}

interface MonDoc {
  runningUntil?: number;
  lastRunAt?: number;
  lastOkRunAt?: number;
  lastError?: string | null;
  cursors?: { positions?: string | null; orders?: string | null; accounts?: string | null };
}

export async function runTradingCron(budgetMs = CHAIN_BUDGET_MS, chain?: { baseUrl: string }): Promise<TradingCronResult> {
  const started = Date.now();
  const dbx = firestore();
  const monRef = dbx.collection("platformMonitoring").doc("tradingCron");

  // ---- §3 lease: exactly one evaluation pass platform-wide -----------------
  const leased = await dbx.runTransaction(async (tx: any) => {
    const cur = (await tx.get(monRef)).data() as MonDoc | undefined;
    if (cur?.runningUntil && cur.runningUntil > started) return false;
    tx.set(monRef, { runningUntil: started + LEASE_MS, leaseAt: started }, { merge: true });
    return true;
  });
  if (!leased) {
    // another pass holds the lease — it will continue the chain itself
    return { ok: true, skipped: "busy", targets: 0, processed: 0, failed: 0, remaining: 0, runMs: Date.now() - started, errors: [] };
  }

  let processed = 0;
  let failed = 0;
  const errors: string[] = [];
  let staleSkipped = 0;
  let delayedExec = 0;
  let fatal: string | null = null;
  const ordered: { uid: string; aid: string; prio: number }[] = [];
  // cursor state: where THIS pass starts vs where the NEXT pass continues
  let startCursors: NonNullable<MonDoc["cursors"]> = { positions: null, orders: null, accounts: null };
  let nextCursors: NonNullable<MonDoc["cursors"]> = { ...startCursors };

  try {
    const prev = (await monRef.get()).data() as MonDoc | undefined;
    startCursors = {
      positions: prev?.cursors?.positions ?? null,
      orders: prev?.cursors?.orders ?? null,
      accounts: prev?.cursors?.accounts ?? null,
    };
    nextCursors = { ...startCursors };

    const targets = new Map<string, { uid: string; aid: string; prio: number }>();
    const addTargets = (snap: any, prio: number) => {
      for (const d of snap.docs) {
        const accRef = d.ref.parent.parent; // users/{uid}/accounts/{aid}
        if (!accRef) continue;
        const uid = accRef.parent.parent?.id ?? "";
        const aid = accRef.id;
        if (!uid || !aid) continue;
        const key = `${uid}:${aid}`;
        const p = targets.get(key);
        if (!p || p.prio > prio) targets.set(key, { uid, aid, prio });
      }
    };
    // NOTE: a where("status","==",…) filter on a collectionGroup needs a
    // Firestore composite index the project does not have — plain enumeration
    // (automatic index) + in-memory filtering keeps this index-free.
    // orderBy(documentID) + startAfter gives stable pagination + resumability.
    const { FieldPath } = await import("firebase-admin/firestore");
    const page = async (col: "positions" | "orders" | "accounts", limit: number) => {
      let q: any = dbx.collectionGroup(col).orderBy(FieldPath.documentId()).limit(limit);
      if (startCursors[col]) q = q.startAfter(dbx.doc(startCursors[col]!));
      const snap = await q.get();
      if (snap.empty) { nextCursors[col] = null; return; }
      addTargets(snap, 0);
      // a full page means more documents may exist → continue there next pass
      nextCursors[col] = snap.docs.length === limit ? snap.docs[snap.docs.length - 1].ref.path : null;
      return snap;
    };

    const accountsFilter = (snap: any | undefined) => {
      for (const d of snap?.docs ?? []) {
        if ((d.get("status") || "active") !== "active") continue;
        const accRef = d.ref.parent.parent;
        if (!accRef) continue;
        const uid = accRef.parent.parent?.id ?? "";
        if (!uid) continue;
        const key = `${uid}:${accRef.id}`;
        if (!targets.has(key)) targets.set(key, { uid, aid: accRef.id, prio: 1 });
      }
    };

    // priority 0: accounts with real exposure (positions/orders pages —
    // when a previous pass left a cursor mid-accounts, resume there instead)
    if (!startCursors.accounts) {
      const p1 = await page("positions", PAGE_POSITIONS);
      const o1 = await page("orders", PAGE_ORDERS);
      const accountsReady = !nextCursors.positions && !nextCursors.orders;
      if (accountsReady) accountsFilter(await page("accounts", PAGE_ACCOUNTS));
      void p1; void o1;
    } else {
      // mid-accounts: resume the accounts sweep (positions/orders were swept)
      accountsFilter(await page("accounts", PAGE_ACCOUNTS));
    }

    ordered.push(...[...targets.values()].sort((a, b) => a.prio - b.prio));
    for (const t of ordered) {
      if (Date.now() - started > budgetMs) break;
      try {
        const r = await store.evaluate(t.uid, t.aid) as { diag?: { skipped?: number; delayed?: number } };
        processed++;
        staleSkipped += r?.diag?.skipped ?? 0;
        delayedExec += r?.diag?.delayed ?? 0;
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push(`${t.aid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // advance cursors ONLY when this pass fully consumed its target set —
    // a budget-exhausted pass persists its START cursors, so the next pass
    // re-sweeps the same window (evaluate is idempotent; nothing is skipped)
    const complete = processed + failed >= ordered.length;
    const finalCursors = complete ? nextCursors : startCursors;

    // ---- §12 monitoring — full diagnostics, released lease ----------------
    const prevRun = prev?.lastRunAt || 0;
    const runMs = Date.now() - started;
    const remaining = Math.max(0, ordered.length - processed - failed);
    await monRef.set({
      lastRunAt: started,
      lastOkRunAt: started,
      lastError: errors.length ? errors.slice(0, 3).join(" | ") : null,
      runMs, processed, failed, remaining,
      staleSkipped, delayedExec,
      cursors: finalCursors,
      runningUntil: 0, // lease released — the next hop may start immediately
      updatedAt: started,
    }, { merge: true });
    if (prevRun && started - prevRun > 15 * 60_000) {
      void writeAdminAlert({
        type: "engine_error", severity: "warning",
        text: `Trading cron gap detected: previous evaluation ran ${Math.round((started - prevRun) / 60000)} min late`,
        details: { processed, failed },
      }, "cron_gap", 60 * 60_000);
    }
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
    // monitoring MUST reflect a failed cycle (§12) — release the lease too
    try {
      await monRef.set({
        lastError: `fatal: ${fatal}`, lastRunAt: started,
        cursors: startCursors, runningUntil: 0, updatedAt: started,
      }, { merge: true });
    } catch { /* Firestore itself unreachable — nothing more to do here */ }
  }

  // ---- §3 chain continuation: re-invoke ourselves after the release --------
  // PHASE 67 — the spot recorder rides this chain: one gold-api sample per
  // hop (transaction-throttled to ≥15s per code) keeps the shared spotTicks
  // store accumulating server-side, independent of any open browser. The
  // step is fire-and-forget: its own claim transaction collapses concurrent
  // hops, a failure is diagnosed in diag/spotRecorder and NEVER breaks the
  // trading chain. The fire-and-forget lambda is held alive briefly by the
  // module-level timer inside recorderStep's fetch — a dropped sample is
  // simply retried on the next hop seconds later.
  void import("../lib/spot-recorder").then((m) => m.recorderStep()).catch(() => { /* diagnosed in RTDB */ });
  const runMs = Date.now() - started;
  if (chain?.baseUrl) {
    await fireChainHop(chain.baseUrl, process.env.CRON_SECRET);
  }
  return { ok: true, targets: ordered.length, processed, failed, remaining: Math.max(0, ordered.length - processed - failed), runMs, errors, skipped: fatal ? `error: ${fatal}` : undefined };
}
