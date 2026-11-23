import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionsFor, activeSession, nextSessionStart, zoneWallTimeToUtc, fmtDuration } from "../client/src/lib/market-sessions.ts";

// A Northern-hemisphere winter instant: 2026-01-15 10:00 UTC
// Tokyo = 19:00 JST (after 18:00 close → London open at 08:00 GMT = 08:00 UTC)
const winter = Date.UTC(2026, 0, 15, 10, 0);

test("P56: zone wall time resolves through DST (London GMT vs BST)", () => {
  // 08:00 London wall clock on 2026-01-15 (GMT) = 08:00 UTC
  assert.equal(zoneWallTimeToUtc("Europe/London", "2026-01-15", 8 * 60), Date.UTC(2026, 0, 15, 8, 0));
  // 08:00 London on 2026-07-15 (BST, UTC+1) = 07:00 UTC
  assert.equal(zoneWallTimeToUtc("Europe/London", "2026-07-15", 8 * 60), Date.UTC(2026, 6, 15, 7, 0));
  // 09:00 Tokyo (UTC+9, no DST) = 00:00 UTC
  assert.equal(zoneWallTimeToUtc("Asia/Tokyo", "2026-01-15", 9 * 60), Date.UTC(2026, 0, 15, 0, 0));
  // 08:00 New York on 2026-07-15 (EDT, UTC-4) = 12:00 UTC
  assert.equal(zoneWallTimeToUtc("America/New_York", "2026-07-15", 8 * 60), Date.UTC(2026, 6, 15, 12, 0));
});

test("P56: winter 10:00 UTC — London open, Tokyo closed, NY pre-open", () => {
  const s = sessionsFor(winter);
  const tokyo = s.find((x) => x.id === "tokyo")!;
  const london = s.find((x) => x.id === "london")!;
  const ny = s.find((x) => x.id === "newyork")!;
  assert.equal(tokyo.open, false); // 19:00 JST — after the 18:00 close
  assert.equal(london.open, true); // 10:00 GMT inside 08:00–17:00
  assert.equal(ny.open, false); // 05:00 EST — before 08:00
  // London window today: 08:00–17:00 UTC (winter)
  assert.equal(london.startUtc, Date.UTC(2026, 0, 15, 8, 0));
  assert.equal(london.endUtc, Date.UTC(2026, 0, 15, 17, 0));
});

test("P56: active session + next start", () => {
  const a = activeSession(winter);
  assert.equal(a?.id, "london");
  const nx = nextSessionStart(winter);
  assert.equal(nx?.id, "newyork");
  // NY opens 13:00 UTC in winter (08:00 EST)
  assert.equal(nx?.at, Date.UTC(2026, 0, 15, 13, 0));
});

test("P56: US summer — NY session at 10:00 UTC is pre-open, London open with BST shift", () => {
  const summer = Date.UTC(2026, 6, 15, 10, 0);
  const s = sessionsFor(summer);
  const london = s.find((x) => x.id === "london")!;
  const ny = s.find((x) => x.id === "newyork")!;
  assert.equal(london.open, true); // 11:00 BST — inside
  assert.equal(london.startUtc, Date.UTC(2026, 6, 15, 7, 0)); // 08:00 BST
  assert.equal(ny.open, false); // 06:00 EDT
  assert.equal(ny.todayStartUtc, Date.UTC(2026, 6, 15, 12, 0)); // 08:00 EDT today
  const nx = nextSessionStart(summer);
  assert.equal(nx?.id, "newyork");
  assert.equal(nx?.at, Date.UTC(2026, 6, 15, 12, 0));
});

test("P56: duration formatting", () => {
  assert.equal(fmtDuration(0), "00:00");
  assert.equal(fmtDuration(65_000), "01:05");
  assert.equal(fmtDuration(3 * 3600_000 + 25 * 60_000), "3h 25m");
});
