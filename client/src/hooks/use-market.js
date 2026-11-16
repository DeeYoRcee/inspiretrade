import { useQuery } from "@tanstack/react-query";
import { ref, get } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
export function useMarketListings() {
    const { user } = useAuth();
    return useQuery({
        queryKey: ["market", user?.uid],
        queryFn: async () => {
            if (!user)
                return [];
            const snap = await get(ref(db, "market"));
            if (!snap.exists())
                return [];
            const data = snap.val();
            return Object.entries(data)
                .map(([id, listing]) => ({ ...listing, id }))
                .filter((listing) => listing.status === "active")
                .sort((a, b) => (a.price || 0) - (b.price || 0))
                .map((listing) => ({ ...listing, isOwn: listing.sellerUid === user.uid }));
        },
        enabled: !!user,
        refetchInterval: 30000,
    });
}
