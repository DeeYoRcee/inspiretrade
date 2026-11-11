/**
 * POST /api/market?action=list|buy|cancel
 *
 * Single serverless function for every market action. Vercel Hobby allows
 * max 12 Serverless Functions per deployment, so related endpoints are
 * merged into one dispatcher with an `action` query parameter.
 *
 *   ?action=list   { fragmentId, price }   — escrow fragment, create listing
 *   ?action=buy    { listingId }           — buy an active listing
 *   ?action=cancel { listingId }           — cancel own listing, refund escrow
 */
import list from "./list";
import buy from "./buy";
import cancel from "./cancel";

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getAction(req: any): string {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("action");
    if (q) return String(q);
  } catch {
    // fall through to body
  }
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  return String(body?.action || "");
}

export default async function handler(req: any, res: any) {
  const action = getAction(req);
  switch (action) {
    case "list":
      return list(req, res);
    case "buy":
      return buy(req, res);
    case "cancel":
      return cancel(req, res);
    default:
      return res
        .status(400)
        .json({ error: "BAD_ACTION", message: "Unknown market action (use ?action=list|buy|cancel)" });
  }
}
