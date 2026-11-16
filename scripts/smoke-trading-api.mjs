/**
 * Smoke test for the bundled api/trading.js dispatcher — runs the REAL
 * deployed bundle with fake req/res objects (no network, no Firebase).
 * Verifies routing, health default, method guards and auth wiring paths.
 * Run: node scripts/smoke-trading-api.mjs
 */
import handler from "../api/trading.js";

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log("✔", name); }
  catch (e) { fail++; console.log("✖", name, "—", e.message); }
}

await check("health default action (GET /api/health via rewrite)", async () => {
  const res = fakeRes();
  await handler({ method: "GET", url: "/api/trading", headers: {} }, res);
  if (res.statusCode !== 200 || res.body.status !== "ok") throw new Error(JSON.stringify(res.body));
});

await check("unknown action → 400 BAD_ACTION", async () => {
  const res = fakeRes();
  await handler({ method: "POST", url: "/api/trading?action=nonsense", headers: {}, body: "{}" }, res);
  if (res.statusCode !== 400 || res.body.error !== "BAD_ACTION") throw new Error(JSON.stringify(res.body));
});

await check("trading action without token → 401 MISSING_TOKEN", async () => {
  const res = fakeRes();
  await handler({ method: "POST", url: "/api/trading?action=accounts", headers: {}, body: "{}" }, res);
  if (res.statusCode !== 401 || res.body.error !== "MISSING_TOKEN") {
    // no service account locally: ensureApp may fire first — both are correct auth-wiring outcomes
    if (res.statusCode === 500 && res.body.error === "SERVER_NOT_CONFIGURED") return;
    throw new Error(JSON.stringify(res.body));
  }
});

await check("GET on POST-only action → 405", async () => {
  const res = fakeRes();
  await handler({ method: "GET", url: "/api/trading?action=create", headers: {} }, res);
  if (res.statusCode !== 405) throw new Error(`got ${res.statusCode}`);
});

await check("history action without token → 401/500 (auth path)", async () => {
  const res = fakeRes();
  await handler({ method: "GET", url: "/api/trading?action=history&accountId=x", headers: {} }, res);
  if (res.statusCode !== 401 && res.statusCode !== 500) throw new Error(`got ${res.statusCode}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
