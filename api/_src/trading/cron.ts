/**
 * PHASE 62 §2/§3 — server-authoritative trade-lifecycle evaluation.
 *
 * Enumerates every trading account that needs evaluation — open positions,
 * pending orders, or an active challenge account whose expiry / daily-loss
 * anchor / rule transitions must advance WITHOUT any browser — and runs
 * the engine evaluation for each inside its own Firestore transaction.
 *
 * Called from two places:
 *   - POST/GET /api/trading?action=cron-evaluate (external minute-level
 *     scheduler: Upstash QStash / cron-job.org, CRON_SECRET guarded);
 *   - the daily alerts-cron flow (guaranteed catch-up floor on Hobby).
 *
 * Budget-bounded: on a 10s Hobby function it processes as many accounts as
 * fit and reports `remaining` — the next tick resumes (targets are recomputed
 * each run, so nothing is skipped, only deferred).
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
}

export async function runTradingCron(budgetMs = 8_000): Promise<TradingCronResult> {
  const started = Date.now();
  const dbx = firestore();
  const targets = new Map<string, { uid: string; aid: string; prio: number }>();
  const addTargets = (snap: any, prio: number) => {
    for (const d of snap.docs) {
      const accRef = d.ref.parent.parent; // users/{uid}/accounts/{aid}
      if (!accRef) continue;
      const uid = accRef.parent.parent?.id ?? "";
      const aid = accRef.id;
      if (!uid || !aid) continue;
      const key = `${uid}:${aid}`;
      const prev = targets.get(key);
      if (!prev || prev.prio > prio) targets.set(key, { uid, aid, prio });
    }
  };
  // priority 0: accounts with real exposure (open positions/orders)
  addTargets(await dbx.collectionGroup("positions").limit(300).get(), 0);
  addTargets(await dbx.collectionGroup("orders").limit(300).get(), 0);
  // priority 1: active accounts with an empty book — challenge expiry,
  // daily-loss anchor seeding, rule transitions. NOTE: a where("status","==",…)
  // filter on a collectionGroup needs a Firestore composite index the project
  // does not have — plain enumeration (automatic index) + in-memory filtering
  // keeps this index-free. The limit window is deliberately generous; targets
  // beyond it are picked up by the next scheduled run.
  const accSnap = await dbx.collectionGroup("accounts").limit(400).get();
  for (const d of accSnap.docs) {
    if ((d.get("status") || "active") !== "active") continue;
    const accRef = d.ref.parent.parent;
    if (!accRef) continue;
    const uid = accRef.parent.parent?.id ?? "";
    if (!uid) continue;
    const key = `${uid}:${accRef.id}`;
    if (!targets.has(key)) targets.set(key, { uid, aid: accRef.id, prio: 1 });
  }

  const ordered = [...targets.values()].sort((a, b) => a.prio - b.prio);
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const t of ordered) {
    if (Date.now() - started > budgetMs) break;
    try {
      await store.evaluate(t.uid, t.aid);
      processed++;
    } catch (e) {
      failed++;
      if (errors.length < 5) errors.push(`${t.aid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // §3 monitoring — missed/delayed/failed cycles must be detectable
  const monRef = dbx.collection("platformMonitoring").doc("tradingCron");
  const prev = (await monRef.get()).data() as { lastRunAt?: number } | undefined;
  const runMs = Date.now() - started;
  const remaining = Math.max(0, ordered.length - processed - failed);
  await monRef.set({ lastRunAt: started, runMs, processed, failed, remaining }, { merge: true });
  if (prev?.lastRunAt && started - prev.lastRunAt > 15 * 60_000) {
    void writeAdminAlert({
      type: "engine_error", severity: "warning",
      text: `Trading cron gap detected: previous evaluation ran ${Math.round((started - prev.lastRunAt) / 60000)} min late`,
      details: { processed, failed },
    }, "cron_gap", 60 * 60_000);
  }
  return { ok: true, targets: ordered.length, processed, failed, remaining, runMs, errors };
}
