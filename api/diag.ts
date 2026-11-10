// Minimal diag — only tests shared/fragments import.
import { FRAGMENTS, DAILY_COINS } from "../shared/fragments";

export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    fragmentsCount: FRAGMENTS.length,
    dailyCoins: DAILY_COINS,
    firstFragment: FRAGMENTS[0] ? { id: FRAGMENTS[0].id, rarity: FRAGMENTS[0].rarity } : null,
    cwd: process.cwd(),
  });
}
