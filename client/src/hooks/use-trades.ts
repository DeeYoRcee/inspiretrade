import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ref, get, set, remove, push, runTransaction } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
import { z } from "zod";
import { startOfDay, startOfWeek, startOfMonth, startOfYear } from "date-fns";

export const tradeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  assetName: z.string().min(1, "Asset name is required"),
  entryPrice: z.number().positive("Entry price must be positive"),
  exitPrice: z.number().positive("Exit price must be positive"),
  lotSize: z.number().positive("Lot size must be positive"),
  profit: z.number(),
  type: z.enum(["BUY", "SELL"]).default("BUY"),
  category: z.enum(["FOREX", "CRYPTO"]).default("FOREX"),
  timestamp: z.number(),
  emotion: z.enum(["happy", "neutral", "sad"]).optional(),
  imageBase64: z.string().optional(),
  instrumentSymbol: z.string().optional(),
  instrumentName: z.string().optional(),
});

export type Trade = z.infer<typeof tradeSchema>;
export type InsertTrade = Omit<Trade, "id" | "userId" | "instrumentSymbol" | "instrumentName"> & {
  instrumentSymbol: string;
  instrumentName: string;
};

export function useTrades() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["trades", user?.uid],
    queryFn: async () => {
      if (!user) return [];
      const tradesRef = ref(db, `trades/${user.uid}`);
      const snapshot = await get(tradesRef);
      if (!snapshot.exists()) return [];

      const data = snapshot.val();
      const trades: Trade[] = Object.keys(data).map((key) => ({
        ...data[key],
        id: key,
      }));

      return trades.sort((a, b) => b.timestamp - a.timestamp);
    },
    enabled: !!user,
  });
}

async function updateSiteStats(winDelta: number, totalDelta: number) {
  try {
    const statsRef = ref(db, "siteStats");
    await runTransaction(statsRef, (current) => {
      const s = current || { totalTrades: 0, wins: 0 };
      return {
        totalTrades: Math.max(0, (s.totalTrades || 0) + totalDelta),
        wins: Math.max(0, (s.wins || 0) + winDelta),
      };
    });
  } catch {
    // Firebase rules may not allow this — silently ignore
  }
}

export function useAddTrade() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (tradeData: InsertTrade) => {
      if (!user) throw new Error("Not authenticated");

      if (!tradeData.instrumentSymbol.trim() || !tradeData.instrumentName.trim()) {
        throw new Error("Please select a supported instrument");
      }

      const tradesRef = ref(db, `trades/${user.uid}`);
      const newTradeRef = push(tradesRef);

      const newTrade = { ...tradeData, userId: user.uid };
      await set(newTradeRef, newTrade);

      // Update community stats
      await updateSiteStats(tradeData.profit > 0 ? 1 : 0, 1);

      return { id: newTradeRef.key, ...newTrade };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trades", user?.uid] });
      queryClient.invalidateQueries({ queryKey: ["siteStats"] });
    },
  });
}

export function useDeleteTrade() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ tradeId, profit }: { tradeId: string; profit: number }) => {
      if (!user) throw new Error("Not authenticated");
      const tradeRef = ref(db, `trades/${user.uid}/${tradeId}`);
      await remove(tradeRef);

      // Update community stats
      await updateSiteStats(profit > 0 ? -1 : 0, -1);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trades", user?.uid] });
      queryClient.invalidateQueries({ queryKey: ["siteStats"] });
    },
  });
}

export type StatsPeriod = "allTime" | "yearly" | "monthly" | "weekly" | "daily";

export function useGlobalStats(period: StatsPeriod = "allTime") {
  return useQuery({
    queryKey: ["siteStats", period],
    queryFn: async () => {
      const empty = { totalTrades: 0, wins: 0, losses: 0, winRate: "0.0", totalUsers: 0 };
      try {
        const r = ref(db, "siteStats/users");
        const snap = await get(r);
        if (!snap.exists()) return empty;
        const allUsers = snap.val() as Record<string, Record<string, { totalTrades: number; wins: number }>>;
        let totalTrades = 0;
        let wins = 0;
        let totalUsers = 0;
        for (const userStats of Object.values(allUsers)) {
          const p = (userStats as any)[period] as { totalTrades: number; wins: number } | undefined;
          if (!p) continue;
          totalTrades += p.totalTrades || 0;
          wins += p.wins || 0;
          if ((p.totalTrades || 0) > 0) totalUsers += 1;
        }
        return {
          totalTrades,
          wins,
          losses: totalTrades - wins,
          winRate: totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0",
          totalUsers,
        };
      } catch {
        return empty;
      }
    },
    refetchInterval: 20000,
  });
}

export function useSyncUserStats(trades: Trade[] | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!user || trades === undefined) return;
      const now = new Date();
      const calc = (list: Trade[]) => ({
        totalTrades: list.length,
        wins: list.filter(t => t.profit > 0).length,
      });
      const stats = {
        allTime: calc(trades),
        yearly:  calc(trades.filter(t => new Date(t.timestamp) >= startOfYear(now))),
        monthly: calc(trades.filter(t => new Date(t.timestamp) >= startOfMonth(now))),
        weekly:  calc(trades.filter(t => new Date(t.timestamp) >= startOfWeek(now, { weekStartsOn: 1 }))),
        daily:   calc(trades.filter(t => new Date(t.timestamp) >= startOfDay(now))),
      };
      const r = ref(db, `siteStats/users/${user.uid}`);
      await set(r, stats);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["siteStats"] });
    },
  });
}

export function useDayScreenshot(dateStr: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const screenshotQuery = useQuery({
    queryKey: ["screenshot", user?.uid, dateStr],
    queryFn: async () => {
      if (!user || !dateStr) return null;
      const r = ref(db, `screenshots/${user.uid}/${dateStr}`);
      const snap = await get(r);
      return snap.exists() ? (snap.val().imageBase64 as string) : null;
    },
    enabled: !!user && !!dateStr,
    retry: 1,
  });

  const saveScreenshot = useMutation({
    mutationFn: async (imageBase64: string) => {
      if (!user) throw new Error("Not authenticated");
      const r = ref(db, `screenshots/${user.uid}/${dateStr}`);
      await set(r, { imageBase64, updatedAt: Date.now() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screenshot", user?.uid, dateStr] });
    },
  });

  const deleteScreenshot = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      const r = ref(db, `screenshots/${user.uid}/${dateStr}`);
      await remove(r);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["screenshot", user?.uid, dateStr] });
    },
  });

  return { screenshotQuery, saveScreenshot, deleteScreenshot };
}
