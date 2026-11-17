/**
 * Prop-firm leaderboard — verified rankings computed SERVER-SIDE from the
 * immutable trade ledger. Only public, aggregate fields are ever exposed:
 * display name, profit %, net USD, win rate, trade count, challenge size and
 * status. Account balances, uids and positions stay private.
 *
 * Periods: daily = current UTC day, weekly = last 7 days, monthly = last 30
 * days, all = the whole challenge. Admin can disable public rankings via
 * settings/leaderboard.enabled (see admin.ts).
 */
import { firestore, rtdb } from "../lib/firebase";
import * as adminStore from "./admin";

export type LeaderboardPeriod = "daily" | "weekly" | "monthly" | "all";

export interface LeaderboardRow {
  rank: number;
  name: string;
  profitPct: number;
  profitUsd: number;
  winRate: number | null;
  trades: number;
  status: string;
  size: number;
  challengeName: string | null;
}

const PERIOD_MS: Record<LeaderboardPeriod, number> = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
  all: 0,
};

function periodStart(period: LeaderboardPeriod): number {
  if (period === "daily") {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (period === "weekly") return Date.now() - PERIOD_MS.weekly;
  if (period === "monthly") return Date.now() - PERIOD_MS.monthly;
  return 0;
}

export function isPeriod(v: unknown): v is LeaderboardPeriod {
  return v === "daily" || v === "weekly" || v === "monthly" || v === "all";
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

interface Acc {
  uid: string;
  startingBalance: number;
  status: string;
  challengeName: string | null;
  net: number;
  trades: number;
  wins: number;
}

export async function getLeaderboard(period: LeaderboardPeriod): Promise<{ enabled: boolean; period: LeaderboardPeriod; rows: LeaderboardRow[] }> {
  const enabled = await adminStore.getLeaderboardEnabled();
  if (!enabled) return { enabled: false, period, rows: [] };

  const start = periodStart(period);
  // leaderboardLog is a TOP-LEVEL feed written on every challenge close —
  // top-level single-field indexes are automatic, so the `at` range query
  // needs no manual index (the trades collection-group scope does).
  const snap = await firestore()
    .collection("leaderboardLog")
    .where("at", ">=", start)
    .limit(2000)
    .get();

  // group fills by account, then fetch only CHALLENGE account docs
  const byAccount = new Map<string, { uid: string; net: number; trades: number; wins: number }>();
  for (const doc of snap.docs) {
    const e = doc.data() || {};
    const aid = String(e.aid || "");
    if (!aid) continue;
    const net = Number(e.net) || 0;
    const cur = byAccount.get(aid) || { uid: String(e.uid || ""), net: 0, trades: 0, wins: 0 };
    cur.net += net;
    cur.trades += 1;
    if (net > 0) cur.wins += 1;
    byAccount.set(aid, cur);
  }

  const accounts: Acc[] = [];
  const entries = [...byAccount.entries()];
  const db = firestore();
  const accSnaps = await Promise.all(entries.map(([aid, e]) => db.collection("users").doc(e.uid).collection("accounts").doc(aid).get()));
  for (let i = 0; i < entries.length; i++) {
    const data = accSnaps[i].data() || {};
    if (data.type !== "CHALLENGE") continue;
    const e = entries[i][1];
    accounts.push({
      uid: e.uid,
      startingBalance: Number(data.startingBalance) || 0,
      status: data.status || "active",
      challengeName: data.challengeName ?? null,
      net: Math.round(e.net * 100) / 100,
      trades: e.trades,
      wins: e.wins,
    });
  }

  // opportunistic prune — the feed keeps 90 days of history
  const old = await firestore().collection("leaderboardLog").where("at", "<", Date.now() - 90 * 86_400_000).limit(500).get();
  if (!old.empty) {
    const batch = firestore().batch();
    for (const d of old.docs) batch.delete(d.ref);
    await batch.commit();
  }

  const names = await traderNames();
  const ranked = accounts
    .filter((a) => a.startingBalance > 0)
    .map((a) => ({
      name: names[a.uid] ? `@${names[a.uid]}` : "Trader",
      profitPct: Math.round((a.net / a.startingBalance) * 10000) / 100,
      profitUsd: a.net,
      winRate: a.trades > 0 ? Math.round((a.wins / a.trades) * 1000) / 10 : null,
      trades: a.trades,
      status: a.status,
      size: a.startingBalance,
      challengeName: a.challengeName,
    }))
    .sort((x, y) => y.profitPct - x.profitPct || y.profitUsd - x.profitUsd)
    .slice(0, 50);

  // public rows only — no uids, no balances, no positions leave the server
  const rows: LeaderboardRow[] = ranked.map((r, i) => ({ rank: i + 1, ...r }));

  return { enabled: true, period, rows };
}
