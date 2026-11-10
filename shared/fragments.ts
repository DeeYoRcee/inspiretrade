/**
 * Shared fragment / economy definitions.
 *
 * The canonical source lives at `api/_fragments.ts` so it is bundled into the
 * Vercel serverless functions (which only deploy the api/ directory; files
 * outside api/ are not bundled). Files prefixed with _ in api/ are not
 * deployed as functions but can be imported by other functions.
 *
 * The client imports this file via the `@shared/fragments` alias and re-exports
 * the same definitions, keeping a single source of truth.
 *
 * Keep `api/_fragments.ts` dependency-free (no imports).
 */
export * from "../api/_fragments";
