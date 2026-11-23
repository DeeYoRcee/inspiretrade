/**
 * PHASE 61 — order-payload forwarding contract tests.
 *
 * Locks the exact request-body → store-contract mapping for the trading
 * routes. The historical bug (introduced Phase 59-era, fixed PHASE 61 §10):
 * the `order` route rebuilt the placeOrder request and silently DROPPED
 * `expiryAt` and `tsPct` — the ticket's "Day" expiry and trailing percent
 * were persisted as null/0 forever. These tests pin the contract so the
 * fields can never vanish again.
 *
 * Run: node --test tests/p61-forwarding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderBodyToPlaceOrderRequest, modifyOrderBodyToPatch } from "../api/_src/trading/route-bodies.ts";
import { endOfUtcDay } from "../shared/trading-engine.ts";
import { evaluateAccount, type OrderLike, type Quote } from "../shared/trading-engine.ts";

const quote = (bid: number, ask: number): Record<string, Quote> => ({
  XAUUSD: { bid, ask, mid: (bid + ask) / 2, time: Date.now(), source: "test", live: true },
});

test("P61 §10 — order route forwards expiryAt, tsPct and requestId to placeOrder", () => {
  const body = {
    accountId: "acc1",
    symbol: "XAUUSD",
    side: "sell",
    lots: 0.5,
    kind: "limit",
    price: "1994.5",
    sl: "1999",
    tp: "",
    comment: "test order",
    expiryAt: 1795500000000,
    tsPct: 1,
    requestId: "9f8e7d6c-request",
  };
  const req = orderBodyToPlaceOrderRequest(body);
  assert.equal(req.expiryAt, 1795500000000, "expiryAt must survive the route");
  assert.equal(req.tsPct, 1, "tsPct must survive the route");
  assert.equal(req.requestId, "9f8e7d6c-request", "requestId must survive the route");
  assert.equal(req.price, 1994.5);
  assert.equal(req.sl, 1999);
  assert.equal(req.tp, null, "empty string TP maps to null (no TP)");
});

test("P61 §10 — GTC order (no expiry) still maps to null expiry, not NaN", () => {
  const req = orderBodyToPlaceOrderRequest({ accountId: "a", symbol: "BTCUSD", side: "buy", lots: 0.1, kind: "market" });
  assert.equal(req.expiryAt, null);
  assert.equal(req.tsPct, null);
  assert.equal(req.requestId, null);
});

test("P61 §3 — requestId is trimmed and capped at 64 chars", () => {
  const req = orderBodyToPlaceOrderRequest({ accountId: "a", symbol: "X", side: "buy", lots: 1, kind: "market", requestId: "  " + "x".repeat(80) + "  " });
  assert.equal(req.requestId!.length, 64);
  assert.ok(!req.requestId!.startsWith(" ") && !req.requestId!.endsWith(" "));
});

test("P61 §7 — modify-order patch forwards tsPct and expiryAt (undefined = unchanged, null = clear)", () => {
  const patch = modifyOrderBodyToPatch({ price: "1990", sl: "", expiryAt: 1795500000000, tsPct: "2" });
  assert.equal(patch.price, 1990);
  assert.equal(patch.sl, null, "empty string SL clears the SL");
  assert.equal(patch.tsPct, 2);
  assert.equal(patch.expiryAt, 1795500000000);
  const untouched = modifyOrderBodyToPatch({ price: "1990" });
  assert.equal(untouched.tsPct, undefined, "absent tsPct must NOT reset trailing");
  assert.equal(untouched.expiryAt, undefined, "absent expiry must NOT reset expiry");
  const gtc = modifyOrderBodyToPatch({ price: "1990", expiryAt: "" });
  assert.equal(gtc.expiryAt, null, "empty string expiry clears to GTC");
});

test("P61 — endOfUtcDay is the last millisecond of the current UTC day", () => {
  const end = endOfUtcDay();
  const d = new Date(end);
  assert.equal(d.getUTCHours(), 23);
  assert.equal(d.getUTCMinutes(), 59);
  assert.equal(d.getUTCSeconds(), 59);
  assert.equal(d.getUTCMilliseconds(), 999);
  assert.ok(end > Date.now(), "expiry must be in the future");
});

test("P61 §2 — engine sweep still honours expiryAt (past expires, future survives)", () => {
  const past: OrderLike = { id: "o1", symbol: "XAUUSD", side: "buy", kind: "limit", lots: 0.1, price: 1995, sl: null, tp: null, expiryAt: Date.now() - 1000 };
  const future: OrderLike = { id: "o2", symbol: "XAUUSD", side: "buy", kind: "limit", lots: 0.1, price: 1995, sl: null, tp: null, expiryAt: Date.now() + 86400_000 };
  const out = evaluateAccount({ balance: 10000, positions: [], orders: [past, future], quotes: quote(1990, 1991) });
  assert.deepEqual(out.expired, ["o1"], "only the expired order is collected");
  const fillIds = out.fills.map((f) => (f as { orderId?: string; id?: string }).orderId ?? (f as { id?: string }).id ?? "");
  assert.deepEqual(fillIds, ["o2"], "the live order still fills; the expired one never does");
});
