/**
 * Inspect the public-profile state for all users: usernames registry,
 * privatePublicProfileSettings and publicProfiles snapshots.
 * Usage: node scripts/inspect-profiles.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

initializeApp({ credential: applicationDefault(), databaseURL: "https://inspiretrade-default-rtdb.europe-west1.firebasedatabase.app" });
const db = getDatabase();

const [usernames, settings, profiles, users] = await Promise.all([
  db.ref("usernames").once("value"),
  db.ref("privatePublicProfileSettings").once("value"),
  db.ref("publicProfiles").once("value"),
  db.ref("users").once("value"),
]);
console.log("=== usernames registry ===");
console.log(JSON.stringify(usernames.val() || {}, null, 1));
console.log("=== privatePublicProfileSettings ===");
for (const [uid, s] of Object.entries(settings.val() || {})) {
  console.log(uid, "→", JSON.stringify({ enabled: s?.enabled, publishedUsername: s?.publishedUsername, strategy: String(s?.strategy || "").slice(0, 40) }));
}
console.log("=== publicProfiles keys ===");
for (const [k, p] of Object.entries(profiles.val() || {})) {
  console.log(k, "→ uid:", p?.uid, "username:", p?.username, "redirect:", p?.redirect ?? "-");
}
console.log("=== users (uid → email/profile summary) ===");
for (const [uid, u] of Object.entries(users.val() || {})) {
  const prof = u?.profile || {};
  console.log(uid, "→", u?.email || prof?.email || "?", "| username:", prof?.username || "-", "| premium:", prof?.isPremium ? "yes" : "no");
}
process.exit(0);
