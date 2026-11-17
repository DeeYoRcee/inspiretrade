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
  const snap = await firestore()
    .collectionGroup("trades")
    .where("closedAt", ">=", start)
    .limit(2000)
    .get();

  // group fills by parent account, then fetch only CHALLENGE account docs
  const byAccount = new Map<string, { net: number; trades: number; wins: number; ref: any }>();
  for (const doc of snap.docs) {
    const parent = doc.ref.parent.parent;
    if (!parent) continue;
    const t = doc.data() || {};
    const key = parent.path;
    const cur = byAccount.get(key) || { net: 0, trades: 0, wins: 0, ref: parent };
    const net = (Number(t.pnl) || 0) + (Number(t.swap) || 0);
    cur.net += net;
    cur.trades += 1;
    if (net > 0) cur.wins += 1;
    byAccount.set(key, cur);
  }

  const accounts: Acc[] = [];
  const parents = [...byAccount.values()];
  const accSnaps = await Promise.all(parents.map((p) => p.ref.get()));
  for (let i = 0; i < parents.length; i++) {
    const data = accSnaps[i].data() || {};
    if (data.type !== "CHALLENGE") continue;
    const p = parents[i];
    accounts.push({
      uid: p.ref.parent.parent?.id || "",
      startingBalance: Number(data.startingBalance) || 0,
      status: data.status || "active",
      challengeName: data.challengeName ?? null,
      net: Math.round(p.net * 100) / 100,
      trades: p.trades,
      wins: p.wins,
    });
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
