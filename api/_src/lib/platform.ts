/**
 * Phase 7 server helpers — admin role resolution, admin alert feed and the
 * cached platform-settings reader used by the trading engine.
 *
 * Roles: RTDB adminRoles/{uid} is authoritative; ADMIN_EMAILS members fall
 * back to "admin" (the FIRST entry bootstraps as super_admin so role
 * management is reachable without manual DB edits). Clients can neither read
 * nor write any of these nodes — every check happens here, server-side.
 */
import { rtdb, firestore, type AuthedUser } from "./firebase";
import { ADMIN_ROLES, PLATFORM_SETTINGS_DEFAULTS, sanitizePlatformSettings, type AdminRole, type PlatformSettings } from "../../../shared/roles";

/** Resolve the caller's admin role; null = not an admin. */
export async function getAdminRole(user: AuthedUser): Promise<AdminRole | null> {
  try {
    const role = (await rtdb().ref(`adminRoles/${user.uid}`).once("value")).val();
    if (typeof role === "string" && (ADMIN_ROLES as string[]).includes(role)) return role as AdminRole;
  } catch { /* fall through to env fallback */ }
  const email = String(user.email || "").toLowerCase();
  const emails = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (emails.includes(email)) return emails.indexOf(email) === 0 ? "super_admin" : "admin";
  return null;
}

// ---------------------------------------------------------------------------
// Admin alert feed (RTDB adminAlerts — clients have no rules → denied)
// ---------------------------------------------------------------------------

export type AlertType =
  | "new_user" | "challenge_assigned" | "challenge_passed" | "challenge_failed"
  | "risk_violation" | "order_rejected" | "suspicious_activity" | "engine_error"
  | "user_state" | "account_state" | "settings_changed" | "roles_changed" | "platform";

export interface AdminAlert {
  at: number;
  type: AlertType;
  severity: "info" | "warning" | "critical";
  text: string;
  uid?: string;
  details?: Record<string, unknown>;
  read?: boolean;
}

/**
 * Throttled alert writer — the same key fires at most once per `cooldownMs`
 * (state in RTDB adminAlertsState/{key}). Returns true when written.
 */
export async function writeAdminAlert(
  alert: Omit<AdminAlert, "at" | "read">,
  throttleKey?: string,
  cooldownMs = 10 * 60_000,
): Promise<boolean> {
  try {
    if (throttleKey) {
      const stateRef = rtdb().ref(`adminAlertsState/${throttleKey.replace(/[.#$/[\]]/g, "_")}`);
      const last = (await stateRef.once("value")).val();
      if (typeof last === "number" && Date.now() - last < cooldownMs) return false;
      await stateRef.set(Date.now());
    }
    await rtdb().ref("adminAlerts").push({ ...alert, at: Date.now(), read: false });
    return true;
  } catch (e) {
    console.error("[api] admin alert write failed", e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform settings (Firestore platformSettings/global) — cached 60 s
// ---------------------------------------------------------------------------

let cache: { at: number; settings: PlatformSettings } | null = null;
const CACHE_MS = 60_000;

export async function getPlatformSettings(force = false): Promise<PlatformSettings> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.settings;
  let settings = PLATFORM_SETTINGS_DEFAULTS;
  try {
    const snap = await firestore().collection("platformSettings").doc("global").get();
    if (snap.exists) {
      const raw = snap.data() || {};
      settings = sanitizePlatformSettings({ ...PLATFORM_SETTINGS_DEFAULTS, ...raw });
    }
  } catch (e) {
    console.error("[api] platform settings read failed — using defaults", e);
  }
  cache = { at: Date.now(), settings };
  return settings;
}

export function invalidateSettingsCache() {
  cache = null;
}
