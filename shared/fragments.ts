/**
 * Shared fragment / economy definitions.
 * Re-exports the canonical source at api/fragments-helper.ts so it is bundled
 * into the Vercel serverless functions (which only deploy the api/ directory).
 * The client imports this file via the @shared/fragments alias.
 * Keep api/fragments-helper.ts dependency-free (no imports).
 */
export * from "../api/fragments-helper";
