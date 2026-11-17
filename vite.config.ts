import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // .tsx/.ts MUST win over stale .jsx/.js artifacts — vite's default order
    // prefers .js/.jsx, which let old compiled twins shadow the TypeScript
    // sources and shipped a hybrid bundle (black-screened the terminal).
    extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    // Only the app entry ships to production; *-harness.html pages are
    // dev-only visual-test rigs served by `vite dev`.
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "client", "index.html"),
    },
  },
});
