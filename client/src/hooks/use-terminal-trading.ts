/**
 * Terminal trading store — DEMO execution environment.
 *
 * ⚠️ All orders here are SIMULATED. Nothing is sent to any broker. Balances
 * and positions live in the user's own RTDB node (`terminalDemo/{uid}`) and
 * exist only inside InspireTrade. The `ExecutionAdapter` interface below is
 * the single integration point for a future MT5 / broker bridge — a real
 * adapter must enforce everything server-side before it is enabled.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ref, get, set, update, push } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
import { getInstrument, type InstrumentSpec } from "@shared/terminal";

export interface DemoAccount {
  label: "DEMO";
  balance: number;
  startingBalance: number;
  createdAt: number;
  /** day start balance snapshot { "YYYY-MM-DD": balance } for daily drawdown */
  dayStart: Record<string, number>;
}

export interface DemoPosition {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  openedAt: number;
  status: "open" | "closed";
  exit?: number;
  profit?: number;
  closedAt?: number;
  comment?: string;
}

export interface OpenOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  /** market price now */
  price: number;
  /** limit/stop entry price (undefined = market) */
  limitPrice?: number;
  sl: number | null;
  tp: number | null;
}

export interface ExecutionResult {
  ok: boolean;
  position?: DemoPosition;
  error?: string;
}

/**
 * Execution adapter seam — swap this for a broker-backed implementation later.
 * The demo adapter executes instantly at the requested price.
 */
export interface ExecutionAdapter {
  name: "demo" | string;
  execute(req: OpenOrderRequest, account: DemoAccount): Promise<ExecutionResult>;
}

const demoAdapter: ExecutionAdapter = {
  name: "demo",
  async execute(req) {
    const pos: DemoPosition = {
      id: Math.random().toString(36).slice(2, 12),
      symbol: req.symbol,
      side: req.side,
      lots: req.lots,
      entry: req.limitPrice ?? req.price,
      sl: req.sl,
      tp: req.tp,
      openedAt: Date.now(),
      status: "open",
    };
    return { ok: true, position: pos };
  },
};

const EMPTY_ACCOUNT: DemoAccount = { label: "DEMO", balance: 0, startingBalance: 0, createdAt: 0, dayStart: {} };

export function useTerminalTrading() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const node = user ? `terminalDemo/${user.uid}` : null;

  const accountQ = useQuery({
    queryKey: ["terminalAccount", user?.uid],
    enabled: !!node,
    queryFn: async (): Promise<DemoAccount> => {
      const snap = await get(ref(db, node!));
      if (!snap.exists()) {
        // first visit — create a $100,000 demo challenge account
        const acc: DemoAccount = { label: "DEMO", balance: 100000, startingBalance: 100000, createdAt: Date.now(), dayStart: {} };
        await set(ref(db, node!), acc);
        return acc;
      }
      return { ...EMPTY_ACCOUNT, ...snap.val() };
    },
  });

  const positionsQ = useQuery({
    queryKey: ["terminalPositions", user?.uid],
    enabled: !!node,
    queryFn: async (): Promise<DemoPosition[]> => {
      const snap = await get(ref(db, `${node}/positions`));
      return snap.exists() ? Object.values<DemoPosition>(snap.val()) : [];
    },
  });

  async function persistAccount(acc: DemoAccount) {
    if (!node) return;
    await set(ref(db, node), { ...acc, label: "DEMO" });
    qc.setQueryData(["terminalAccount", user?.uid], acc);
  }

  /** Floating P/L in USD (approximation using contract size; quote-ccy pairs simplified). */
  function floatingProfit(pos: DemoPosition, price: number, inst?: InstrumentSpec): number {
    const diff = pos.side === "buy" ? price - pos.entry : pos.entry - price;
    const contract = inst?.contractSize ?? 1;
    // For non-USD quote currencies this is a reference approximation (labeled in UI).
    return diff * pos.lots * contract;
  }

  async function openPosition(req: OpenOrderRequest): Promise<ExecutionResult> {
    if (!node) return { ok: false, error: "Not authenticated" };
    const res = await demoAdapter.execute(req, accountQ.data ?? EMPTY_ACCOUNT);
    if (!res.ok || !res.position) return res;
    const posRef = ref(db, `${node}/positions/${res.position.id}`);
    await set(posRef, res.position);
    qc.invalidateQueries({ queryKey: ["terminalPositions", user?.uid] });
    return res;
  }

  async function closePosition(pos: DemoPosition, price: number, profit: number) {
    if (!node) return;
    await update(ref(db, `${node}/positions/${pos.id}`), {
      status: "closed", exit: price, profit: Math.round(profit * 100) / 100, closedAt: Date.now(),
    });
    const acc = accountQ.data ?? EMPTY_ACCOUNT;
    await persistAccount({ ...acc, balance: Math.round((acc.balance + profit) * 100) / 100 });
    qc.invalidateQueries({ queryKey: ["terminalPositions", user?.uid] });
  }

  async function updatePosition(pos: DemoPosition, patch: Partial<DemoPosition>) {
    if (!node) return;
    await update(ref(db, `${node}/positions/${pos.id}`), patch);
    qc.invalidateQueries({ queryKey: ["terminalPositions", user?.uid] });
  }

  async function resetAccount(starting: number) {
    if (!node) return;
    const acc: DemoAccount = { label: "DEMO", balance: starting, startingBalance: starting, createdAt: Date.now(), dayStart: {} };
    await set(ref(db, node!), { ...acc, positions: null });
    qc.setQueryData(["terminalAccount", user?.uid], acc);
    qc.invalidateQueries({ queryKey: ["terminalPositions", user?.uid] });
  }

  return {
    account: accountQ.data ?? null,
    positions: positionsQ.data ?? [],
    openPosition,
    closePosition,
    updatePosition,
    resetAccount,
    floatingProfit,
    loading: accountQ.isLoading || positionsQ.isLoading,
  };
}

// ---- Challenge-style metrics (computed client-side for the DEMO account) ------

export interface ChallengeMetrics {
  balance: number;
  equity: number;
  startingBalance: number;
  profit: number;
  profitPct: number;
  profitTargetPct: number;
  profitTarget: number;
  dailyDrawdownLimit: number;
  maxDrawdownLimit: number;
  currentDailyDD: number;
  currentMaxDD: number;
  remainingDaily: number;
  remainingMax: number;
  breached: boolean;
  targetReached: boolean;
  openRisk: number;
}

export function computeChallengeMetrics(
  account: DemoAccount,
  positions: DemoPosition[],
  prices: Record<string, number>,
  opts: { profitTargetPct?: number; dailyDDPct?: number; maxDDPct?: number } = {},
): ChallengeMetrics {
  const profitTargetPct = opts.profitTargetPct ?? 8;
  const dailyDDPct = opts.dailyDDPct ?? 5;
  const maxDDPct = opts.maxDDPct ?? 10;

  const starting = account.startingBalance || 1;
  const today = new Date().toISOString().slice(0, 10);
  const dayStartBalance = account.dayStart?.[today] ?? account.balance;

  let floating = 0;
  let openRisk = 0;
  for (const p of positions.filter((x) => x.status === "open")) {
    const inst = getInstrument(p.symbol);
    const price = prices[p.symbol] ?? p.entry;
    floating += (p.side === "buy" ? price - p.entry : p.entry - price) * p.lots * (inst?.contractSize ?? 1);
    if (p.sl) openRisk += Math.abs(p.entry - p.sl) * p.lots * (inst?.contractSize ?? 1);
  }
  const equity = account.balance + floating;
  const profit = equity - starting;
  const currentMaxDD = Math.max(0, starting - equity);
  const currentDailyDD = Math.max(0, dayStartBalance - equity);
  const profitTarget = starting * (profitTargetPct / 100);

  return {
    balance: account.balance,
    equity,
    startingBalance: starting,
    profit,
    profitPct: (profit / starting) * 100,
    profitTargetPct,
    profitTarget,
    dailyDrawdownLimit: starting * (dailyDDPct / 100),
    maxDrawdownLimit: starting * (maxDDPct / 100),
    currentDailyDD,
    currentMaxDD,
    remainingDaily: Math.max(0, starting * (dailyDDPct / 100) - currentDailyDD),
    remainingMax: Math.max(0, starting * (maxDDPct / 100) - currentMaxDD),
    breached: currentDailyDD >= starting * (dailyDDPct / 100) || currentMaxDD >= starting * (maxDDPct / 100),
    targetReached: profit >= profitTarget,
    openRisk,
  };
}

export async function markDayStart(uid: string, acc: DemoAccount) {
  const today = new Date().toISOString().slice(0, 10);
  if (acc.dayStart?.[today]) return;
  await update(ref(db, `terminalDemo/${uid}`), { [`dayStart/${today}`]: acc.balance });
}
