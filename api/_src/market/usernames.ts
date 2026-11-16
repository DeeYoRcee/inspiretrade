/**
 * GET /api/market?action=usernames   (logged-in users)
 * The username directory for the market page:
 *   taken    — every claimed handle with its owner's public name + CEO badge
 *   listings — active username sale listings
 * Public snapshot data (publicProfiles) is joined server-side so the client
 * never needs read access to the raw `usernames/` mapping.
 */
import { handle, requireUser, rtdb } from "../lib/firebase";

const MAX_REGISTRY = 300;

export default handle(async (req, res) => {
  await requireUser(req);
  const db = rtdb();

  const [rawMap, rawMarket] = await Promise.all([
    db.ref("usernames").once("value"),
    db.ref("market").once("value"),
  ]);
  const map: Record<string, string> = rawMap.val() || {};
  const market: Record<string, any> = rawMarket.val() || {};

  const listings = Object.entries<any>(market)
    .filter(([, l]) => l && l.kind === "username" && l.status === "active")
    .map(([id, l]) => ({ id, username: l.username, usernameKey: l.usernameKey, price: l.price, listedAt: l.listedAt, sellerName: l.sellerName }))
    .sort((a, b) => a.price - b.price);

  const keys = Object.keys(map).slice(0, MAX_REGISTRY);
  const taken = await Promise.all(
    keys.map(async (key) => {
      let owner = key;
      let ceo = false;
      let avatar: string | null = null;
      try {
        const snap = await db.ref(`publicProfiles/${key}`).once("value");
        const p = snap.val();
        if (p && typeof p === "object") {
          if (typeof p.username === "string") owner = p.username;
          if (typeof p.displayName === "string" && p.displayName) owner = p.displayName;
          ceo = p.ceo === true;
          if (typeof p.avatar === "string") avatar = p.avatar;
        }
      } catch { /* registry entry stays with the raw key */ }
      return { username: owner, key, ceo, avatar };
    }),
  );

  res.status(200).json({ ok: true, taken, listings, total: Object.keys(map).length });
});
