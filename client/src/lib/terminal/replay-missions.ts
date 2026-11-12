/**
 * Replay missions & achievements (§11) — optional practice goals evaluated
 * against the simulated trade history. Completion is written once to
 * RTDB `terminalReplayAchievements/{uid}/{missionId}` and never re-awarded.
 * Pure evaluation; no engine coupling.
 */
import type { ReplayClosedTrade } from "./replay-engine";

export interface MissionDef {
  id: string;
  name: string;
  description: string;
  /** 0..1 progress from the current replay state */
  progress: (closed: ReplayClosedTrade[], ctx: { netProfit: number; riskBreaches: number; challengePassed?: boolean }) => number;
  done: (closed: ReplayClosedTrade[], ctx: { netProfit: number; riskBreaches: number; challengePassed?: boolean }) => boolean;
}

const plannedRiskPct = undefined; void plannedRiskPct; // (kept out — risk discipline uses the streak proxy below)

export const MISSIONS: MissionDef[] = [
  {
    id: "ten-trades",
    name: "First 10 replay trades",
    description: "Complete 10 simulated trades in replay.",
    progress: (c) => Math.min(1, c.length / 10),
    done: (c) => c.length >= 10,
  },
  {
    id: "rr-2",
    name: "Sniper 1:2",
    description: "Close a trade whose planned risk/reward was at least 1:2.",
    progress: (c) => (c.some((t) => (t.rrAtEntry ?? 0) >= 2) ? 1 : 0),
    done: (c) => c.some((t) => (t.rrAtEntry ?? 0) >= 2),
  },
  {
    id: "risk-discipline",
    name: "Risk manager",
    description: "10 trades in a row without a loss bigger than 1.5× the average planned risk (discipline proxy from SL executions).",
    progress: (c) => (c.length < 10 ? c.length / 10 : longestCleanStreak(c) / 10),
    done: (c) => longestCleanStreak(c) >= 10,
  },
  {
    id: "positive-session",
    name: "Green session",
    description: "Finish a replay session (≥5 trades) with positive net results.",
    progress: (c, ctx) => (c.length >= 5 ? (ctx.netProfit > 0 ? 1 : 0.5) : c.length / 5),
    done: (c, ctx) => c.length >= 5 && ctx.netProfit > 0,
  },
  {
    id: "twenty-trades",
    name: "Iron discipline — 20 trades",
    description: "Complete 20 replay trades while keeping losses controlled.",
    progress: (c, ctx) => Math.min(1, c.length / 20) * (ctx.riskBreaches === 0 ? 1 : 0.5),
    done: (c, ctx) => c.length >= 20 && ctx.riskBreaches === 0,
  },
  {
    id: "challenge-clean",
    name: "Challenge passed clean",
    description: "Complete a Replay Challenge without breaking drawdown rules.",
    progress: (_c, ctx) => (ctx.challengePassed ? 1 : 0),
    done: (_c, ctx) => !!ctx.challengePassed,
  },
];

/** Streak of trades whose loss ≤ 1.5× median losing size (no blow-out losses). */
function longestCleanStreak(closed: ReplayClosedTrade[]): number {
  const losses = closed.filter((t) => t.pnl < 0).map((t) => -t.pnl).sort((a, b) => a - b);
  const median = losses.length ? losses[Math.floor(losses.length / 2)] : 0;
  let best = 0, cur = 0;
  for (const t of closed) {
    if (t.pnl < 0 && median > 0 && -t.pnl > median * 1.5) { cur = 0; continue; }
    cur++;
    best = Math.max(best, cur);
  }
  return best;
}

export interface MissionState { id: string; completedAt: number; }

export function missionContext(closed: ReplayClosedTrade[], cfg: { startingBalance: number }, riskBreaches: number, challengePassed?: boolean) {
  return {
    netProfit: closed.reduce((s, t) => s + t.pnl, 0),
    riskBreaches,
    challengePassed,
  };
}
