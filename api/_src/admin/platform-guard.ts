/**
 * Server-side role guard — the ONLY permission check the platform trusts.
 * Every admin handler calls assertRole(role, action) which enforces the
 * shared ACTION_MIN_RANK matrix (shared/roles.ts).
 */
import { HttpError } from "../lib/firebase";
import { can, type AdminRole } from "../../../shared/roles";

export function assertRole(role: AdminRole | null | undefined, action: string): void {
  if (!role || !can(role, action)) {
    throw new HttpError(403, "FORBIDDEN", `Action "${action}" requires elevated admin permissions`);
  }
}
