/**
 * PHASE 61 §10 — pure request-body normalizers for the trading routes.
 *
 * Extracted so the payload contract is regression-testable without Firebase:
 * tests/p61-forwarding.test.ts locks the exact fields the client sends and
 * the route must forward (the Phase-59/60 bug was the `order` route silently
 * dropping `expiryAt` / `tsPct` here). No firebase imports allowed in this
 * file — it must stay importable from plain `node --test`.
 */
import type { Side, OrderKind } from "@shared/trading-engine";
import type { PlaceOrderRequest } from "./store";

const trimmed = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const numOrUndef = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** POST /api/trading?action=order body → store.placeOrder request. */
export function orderBodyToPlaceOrderRequest(body: Record<string, unknown>): PlaceOrderRequest {
  const requestId = trimmed(body.requestId);
  return {
    accountId: String(body.accountId),
    symbol: String(body.symbol || ""),
    side: body.side as Side,
    lots: Number(body.lots),
    kind: body.kind as OrderKind,
    price: numOrNull(body.price),
    sl: numOrNull(body.sl),
    tp: numOrNull(body.tp),
    comment: typeof body.comment === "string" ? body.comment : undefined,
    // PHASE 61 §10 — the payload-forwarding fix: the ticket sends "Day"
    // expiry and trailing percent, the route used to drop both.
    expiryAt: numOrNull(body.expiryAt),
    tsPct: numOrNull(body.tsPct),
    requestId: requestId ? requestId.slice(0, 64) : null,
  };
}

/** POST /api/trading?action=modify-order body → store.modifyOrder patch.
 *  `undefined` = "leave unchanged", `null` = "clear" (SL/TP/expiry). */
export function modifyOrderBodyToPatch(body: Record<string, unknown>): {
  price?: number | null;
  lots?: number | null;
  sl?: number | null;
  tp?: number | null;
  tsPct?: number | null;
  expiryAt?: number | null;
} {
  return {
    price: numOrUndef(body.price),
    lots: numOrUndef(body.lots),
    sl: body.sl !== undefined ? numOrNull(body.sl) : undefined,
    tp: body.tp !== undefined ? numOrNull(body.tp) : undefined,
    // PHASE 61 §7 — trailing percent and expiry are now modifiable
    tsPct: body.tsPct !== undefined ? numOrUndef(body.tsPct) : undefined,
    expiryAt: body.expiryAt !== undefined ? numOrNull(body.expiryAt) : undefined,
  };
}
