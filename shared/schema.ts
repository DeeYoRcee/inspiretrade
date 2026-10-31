import { z } from "zod";

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
  instrumentSymbol: z.string().optional(),
  instrumentName: z.string().optional(),
});

export type Trade = z.infer<typeof tradeSchema>;
export type InsertTrade = Omit<Trade, "id" | "userId">;
