/**
 * GET /api/diag  (temporary, authenticated)
 * Returns the caller's own economy + inventory as the SERVER sees it.
 * Used to debug the cases=0 mystery. Remove after diagnosis.
 */
import { handle, requireUser, rtdb } from "./lib/firebase";

export default handle(async (req, res) => {
  const user = await requireUser(req);
  const db = rtdb();
  const [ecoSnap, invSnap, claimsSnap] = await Promise.all([
    db.ref(`economy/${user.uid}`).get(),
    db.ref(`inventory/${user.uid}`).get(),
    db.ref(`claims/${user.uid}`).limitToLast(5).get(),
  ]);
  res.status(200).json({
    uid: user.uid,
    economy: ecoSnap.val(),
    economyExists: ecoSnap.exists(),
    inventory: invSnap.val(),
    inventoryExists: invSnap.exists(),
    claims: claimsSnap.val(),
    envDbUrlSet: !!process.env.FIREBASE_DATABASE_URL,
  });
});
