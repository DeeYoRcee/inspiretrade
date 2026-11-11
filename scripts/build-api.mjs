/**
 * Bundles each Vercel serverless function into a self-contained ESM .js file.
 *
 * Why: @vercel/node compiles api/*.ts per-file and its runtime module
 * resolution for extension-less relative imports is unreliable (mixed ESM/CJS
 * on Node 26 caused ERR_MODULE_NOT_FOUND / ERR_REQUIRE_ESM in production).
 * Bundling inlines all local imports (api/_src/lib/*, shared/fragments) so
 * each deployed .js has ZERO relative imports — only bare "firebase-admin"
 * stays external, which resolves from node_modules at runtime (proven to
 * work). Sources live under api/_src/ (underscore dir = not routed).
 *
 * Usage: npm run build:api   (outputs are committed)
 */
import { build } from "esbuild";
import { mkdirSync } from "fs";
import { dirname } from "path";

const entries = [
  ["api/_src/rewards/claim.ts", "api/rewards/claim.js"],
  ["api/_src/cases/open.ts", "api/cases/open.js"],
  ["api/_src/market/list.ts", "api/market/list.js"],
  ["api/_src/market/buy.ts", "api/market/buy.js"],
  ["api/_src/market/cancel.ts", "api/market/cancel.js"],
  ["api/_src/fragments/combine.ts", "api/fragments/combine.js"],
  ["api/_src/diag.ts", "api/diag.js"],
];

for (const [inPath, outPath] of entries) {
  mkdirSync(dirname(outPath), { recursive: true });
  await build({
    entryPoints: [inPath],
    outfile: outPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // firebase-admin must stay external: it resolves from node_modules at
    // runtime and bundling it would blow past the function size limit.
    external: ["firebase-admin"],
    logLevel: "error",
  });
  console.log("bundled:", outPath);
}

console.log("done.");
