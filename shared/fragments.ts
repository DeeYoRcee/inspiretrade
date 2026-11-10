/**
 * Shared fragment / economy definitions.
 *
 * The canonical source lives at `api/lib/fragments.ts` so it is bundled into
 * the Vercel serverless functions (which only deploy the `api/` directory).
 * The client imports this file via the `@shared/fragments` alias and re-exports
 * the same definitions, keeping a single source of truth.
 *
 * Keep `api/lib/fragments.ts` dependency-free (no imports).
 */
export * from "../api/lib/fragments";
