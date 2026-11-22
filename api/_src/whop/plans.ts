/**
 * P45 §1 — plan catalog. The single source of truth lives in webhook-core.ts
 * (kept dependency-free so it is unit-testable in node); this module keeps
 * the original import paths working.
 */
export {
  WHOP_CHECKOUT_URLS, PLAN_BY_ID, PUBLIC_PLANS,
  type PublicPlan, type WhopPlanKey,
} from "./webhook-core";
