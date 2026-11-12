import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ref, get } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
import { ALL_FRAGMENTS } from "@shared/fragments";

export interface Economy {
  coins: number;
  /** Inspire Case count (5k$ fragments) — legacy field name kept for RTDB compat */
  cases: number;
  /** Gold Case count (10k$ fragments) — the Day-7 streak reward */
  goldCases: number;
  streak: number;
  lastClaimDate?: string;
  totalClaimed?: number;
}

export const EMPTY_ECONOMY: Economy = { coins: 0, cases: 0, goldCases: 0, streak: 0, totalClaimed: 0 };

export function useEconomy() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["economy", user?.uid],
    queryFn: async (): Promise<Economy> => {
      if (!user) return EMPTY_ECONOMY;
      const snap = await get(ref(db, `economy/${user.uid}`));
      if (!snap.exists()) return EMPTY_ECONOMY;
      return { ...EMPTY_ECONOMY, ...snap.val() };
    },
    enabled: !!user,
  });
}

/** Record<fragmentId, owned count> — only counts > 0 are meaningful. */
export type Inventory = Record<string, number>;

export const EMPTY_INVENTORY: Inventory = {};

export function useInventory() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["inventory", user?.uid],
    queryFn: async (): Promise<Inventory> => {
      if (!user) return EMPTY_INVENTORY;
      const snap = await get(ref(db, `inventory/${user.uid}`));
      if (!snap.exists()) return EMPTY_INVENTORY;
      const data = snap.val() as Record<string, { count?: number }>;
      const inventory: Inventory = {};
      for (const fragment of ALL_FRAGMENTS) {
        inventory[fragment.id] = data[fragment.id]?.count || 0;
      }
      return inventory;
    },
    enabled: !!user,
  });
}

export interface Claim {
  id: string;
  createdAt: number;
  reference: string;
  status: "pending" | "completed";
  /** which fragment set built this claim: inspire = $5k account, gold = $10k */
  set?: "inspire" | "gold";
  accountSize?: number;
}

export function useClaims() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["claims", user?.uid],
    queryFn: async (): Promise<Claim[]> => {
      if (!user) return [];
      const snap = await get(ref(db, `claims/${user.uid}`));
      if (!snap.exists()) return [];
      const data = snap.val() as Record<string, any>;
      return Object.entries(data)
        .map(([id, claim]) => ({ ...claim, id }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    enabled: !!user,
  });
}

export function useEconomyInvalidator() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["economy"] });
    queryClient.invalidateQueries({ queryKey: ["inventory"] });
    queryClient.invalidateQueries({ queryKey: ["claims"] });
    queryClient.invalidateQueries({ queryKey: ["market"] });
  };
}

/** YYYY-MM-DD in Asia/Tashkent — must match the server's daily boundary. */
export function todayTashkent(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tashkent" });
}
