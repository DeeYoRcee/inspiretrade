/**
 * Phase 7 — platform administration core tests: the role/permission matrix,
 * email masking, platform-settings sanitization and analytics bucketing.
 * These are the exact functions the server enforces on every admin action.
 * Run: node --test tests/  (picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  can, roleAtLeast, maskEmail, sanitizePlatformSettings, bucketByDay,
  ADMIN_ROLES, PLATFORM_SETTINGS_DEFAULTS,
  type AdminRole,
} from "../shared/roles.ts";

test("role matrix: read actions open to every role, mutations gated", () => {
  const analyst: AdminRole = "analyst";
  const moderator: AdminRole = "moderator";
  const admin: AdminRole = "admin";
  const superAdmin: AdminRole = "super_admin";

  // read surface
  for (const action of ["users.read", "analytics.read", "monitor.read", "audit.read", "alerts.read", "settings.read"]) {
    assert.equal(can(analyst, action), true, `analyst should read: ${action}`);
  }
  assert.equal(can(null, "users.read"), false, "non-admins never pass");

  // moderator: freezes + notes, NOT resets/assignments/roles
  assert.equal(can(moderator, "account.suspend"), true);
  assert.equal(can(moderator, "user.note"), true);
  assert.equal(can(moderator, "account.reset"), false);
  assert.equal(can(moderator, "account.assign"), false);
  assert.equal(can(moderator, "challenge.write"), false);
  assert.equal(can(moderator, "roles.write"), false);

  // admin: destructive + assignments, NOT role management
  assert.equal(can(admin, "account.reset"), true);
  assert.equal(can(admin, "user.suspend"), true);
  assert.equal(can(admin, "challenge.write"), true);
  assert.equal(can(admin, "settings.write"), true);
  assert.equal(can(admin, "roles.write"), false, "roles.write is super_admin only");

  assert.equal(can(superAdmin, "roles.write"), true);

  // unknown actions are deny-by-default for EVERY role (fail closed)
  assert.equal(can(admin, "made_up_action"), false);
  assert.equal(can(superAdmin, "made_up_action"), false);
});

test("role ranking: analysts cannot reach moderator actions", () => {
  assert.equal(roleAtLeast("analyst", 2), false);
  assert.equal(roleAtLeast("moderator", 2), true);
  assert.equal(roleAtLeast(undefined, 1), false);
});

test("email masking hides locals but keeps the domain", () => {
  const masked = maskEmail("trader@gmail.com");
  assert.ok(masked.startsWith("t") && masked.includes("@gmail.com"));
  assert.ok(!masked.includes("trader"));
  assert.equal(maskEmail("a@x.io"), "a**@x.io");
  assert.equal(maskEmail(""), "hidden");
  assert.equal(maskEmail("noat"), "hidden");
  // masking must not leak the full local part
  assert.ok(!maskEmail("longlocalname@corp.io").includes("longlocalname"));
});

test("settings sanitize: clamps values, filters leverages, keeps defaults", () => {
  const s = sanitizePlatformSettings({
    maintenanceMode: true,
    defaultAccountBalance: 999999999,
    commissionPerLotUsd: 1000,
    spreadMultiplier: 50,
    allowedLeverages: [100, 777, 10],
    defaultLeverage: 777,
    customSymbols: ["btcusd", " XAUUSD ", "btcusd"],
    maxLotPerOrder: -5,
    symbolsMode: "custom",
  });
  assert.equal(s.maintenanceMode, true);
  assert.equal(s.defaultAccountBalance, 1_000_000); // clamped
  assert.equal(s.commissionPerLotUsd, 100); // clamped to 100
  assert.equal(s.spreadMultiplier, 5);
  assert.deepEqual(s.allowedLeverages.sort(), [10, 100]);
  assert.equal(s.defaultLeverage, 100); // falls back to an ALLOWED leverage
  assert.deepEqual(s.customSymbols, ["BTCUSD", "XAUUSD"]); // uppercased + deduped
  assert.equal(s.maxLotPerOrder, 0.01);
  assert.equal(s.symbolsMode, "custom");

  // empty patch → current defaults preserved, updatedAt stamped
  const s2 = sanitizePlatformSettings({});
  assert.equal(s2.maintenanceMode, PLATFORM_SETTINGS_DEFAULTS.maintenanceMode);
  assert.equal(typeof s2.updatedAt, "number");
});

test("bucketByDay: zero-fills the window and buckets by UTC day", () => {
  const now = Date.UTC(2026, 10, 17, 15, 0, 0); // Nov 17 2026, 15:00 UTC
  const t0 = Date.UTC(2026, 10, 16, 12, 0);     // Nov 16
  const t1 = Date.UTC(2026, 10, 16, 13, 0);     // Nov 16 (2nd)
  const t2 = Date.UTC(2026, 10, 10, 1, 0);      // Nov 10 — outside a 5-day window
  const buckets = bucketByDay([t0, t1, t2, NaN as any], 5, now);
  assert.equal(buckets.length, 5);
  assert.deepEqual(buckets.map((b) => b.day), ["11-13", "11-14", "11-15", "11-16", "11-17"]);
  assert.equal(buckets[3].count, 2); // both Nov 16 events
  assert.equal(buckets[4].count, 0);
  assert.equal(buckets[0].count, 0); // Nov 10 dropped from the window
});

test("roles list is ordered analyst → super_admin", () => {
  assert.deepEqual(ADMIN_ROLES, ["analyst", "moderator", "admin", "super_admin"]);
});
