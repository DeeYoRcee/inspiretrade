import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ref, get } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
import { ALL_FRAGMENTS } from "@shared/fragments";
export const EMPTY_ECONOMY = { coins: 0, cases: 0, goldCases: 0, streak: 0, totalClaimed: 0 };
export function useEconomy() {
    const { user } = useAuth();
    return useQuery({
        queryKey: ["economy", user?.uid],
        queryFn: async () => {
            if (!user)
                return EMPTY_ECONOMY;
            const snap = await get(ref(db, `economy/${user.uid}`));
            if (!snap.exists())
                return EMPTY_ECONOMY;
            return { ...EMPTY_ECONOMY, ...snap.val() };
        },
        enabled: !!user,
    });
}
export const EMPTY_INVENTORY = {};
export function useInventory() {
    const { user } = useAuth();
    return useQuery({
        queryKey: ["inventory", user?.uid],
        queryFn: async () => {
            if (!user)
                return EMPTY_INVENTORY;
            const snap = await get(ref(db, `inventory/${user.uid}`));
            if (!snap.exists())
                return EMPTY_INVENTORY;
            const data = snap.val();
            const inventory = {};
            for (const fragment of ALL_FRAGMENTS) {
                inventory[fragment.id] = data[fragment.id]?.count || 0;
            }
            return inventory;
        },
        enabled: !!user,
    });
}
/** The owner's custom case definitions (read-only to all signed-in users). */
export function useCustomCases() {
    const { user } = useAuth();
    return useQuery({
        queryKey: ["caseDefs", user?.uid],
        queryFn: async () => {
            if (!user)
                return [];
            const snap = await get(ref(db, "economyConfig/cases"));
            if (!snap.exists())
                return [];
            const data = snap.val();
            return Object.entries(data)
                .map(([caseId, def]) => ({ caseId, ...def }))
                .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        },
        enabled: !!user,
    });
}
export function useClaims() {
    const { user } = useAuth();
    return useQuery({
        queryKey: ["claims", user?.uid],
        queryFn: async () => {
            if (!user)
                return [];
            const snap = await get(ref(db, `claims/${user.uid}`));
            if (!snap.exists())
                return [];
            const data = snap.val();
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
        queryClient.invalidateQueries({ queryKey: ["caseDefs"] });
    };
}
/** YYYY-MM-DD in Asia/Tashkent — must match the server's daily boundary. */
export function todayTashkent() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tashkent" });
}
