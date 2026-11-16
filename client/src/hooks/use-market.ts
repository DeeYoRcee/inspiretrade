import { useQuery } from "@tanstack/react-query";
import { ref, get } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";

export interface MarketListing {
  id: string;
  sellerUid: string;
  sellerName: string;
  /** "case" listings sell an Inspire/Gold/custom case; "username" listings
   *  sell a Telegram-collectible-style @handle; fragments are the default */
  kind?: "fragment" | "case" | "username";
  /** case listings: "inspire" | "gold" | a custom case id */
  caseId?: string;
  /** username listings: the handle being sold */
  username?: string;
  usernameKey?: string;
  /** friendly item name (server-stamped) — fragment id for old listings */
  itemName?: string;
  fragmentId: string;
  price: number;
  status: "active" | "sold" | "canceled";
  listedAt: number;
  soldAt?: number;
  buyerUid?: string;
  /** true when the listing belongs to the current user */
  isOwn?: boolean;
}

export function useMarketListings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["market", user?.uid],
    queryFn: async (): Promise<MarketListing[]> => {
      if (!user) return [];
      const snap = await get(ref(db, "market"));
      if (!snap.exists()) return [];
      const data = snap.val() as Record<string, any>;
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

/** Username-directory entry (market page "Usernames" tab). */
export interface TakenUsername {
  username: string;
  key: string;
  ceo: boolean;
  avatar: string | null;
}

export interface UsernameDirectory {
  taken: TakenUsername[];
  listings: { id: string; username: string; usernameKey: string; price: number; listedAt: number; sellerName: string }[];
  total: number;
}

/** GET /api/market?action=usernames — taken handles + active sale listings. */
export function useUsernameDirectory() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["usernameDirectory", user?.uid],
    queryFn: async (): Promise<UsernameDirectory> => {
      const { authedFetch } = await import("@/lib/api");
      const res = await authedFetch("/api/market?action=usernames") as UsernameDirectory & { ok: boolean };
      if (!res?.ok) throw new Error("USERNAME_DIRECTORY_FAILED");
      return { taken: res.taken || [], listings: res.listings || [], total: res.total || 0 };
    },
    enabled: !!user,
    refetchInterval: 60000,
    staleTime: 30000,
  });
}
