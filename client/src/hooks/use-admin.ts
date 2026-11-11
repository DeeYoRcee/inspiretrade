import { useMemo } from "react";
import { useAuth } from "./use-auth";

/**
 * Client-side owner check (VITE_ADMIN_EMAILS). This only controls UI
 * visibility — the server enforces ADMIN_EMAILS on every admin endpoint.
 */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return useMemo(() => {
    const emails = String(import.meta.env.VITE_ADMIN_EMAILS || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return !!user?.email && emails.includes(user.email.toLowerCase());
  }, [user]);
}
