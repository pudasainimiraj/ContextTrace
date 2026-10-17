import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { cloudflare } from "@cloudflare/vite-plugin";

// The React application lives under web/ (index.html, src/, public/); the Worker entry
// (worker/src/index.ts) and wrangler.jsonc stay at the repository root.
//
// Two builds. The default is the Worker with the SPA as its static assets, into <repo>/dist
// (dist/client and dist/contexttrace), not web/dist. `--mode pages` is the SPA alone for GitHub
// Pages, into dist/pages: served under /ContextTrace/, calling the Worker across origins.

// The Worker the Pages site calls. VITE_API_BASE_URL overrides it (a repository variable in the workflow).
const DEFAULT_API_BASE = "https://contexttrace.contexttrace.workers.dev";

export default defineConfig(({ mode }) => {
  if (mode === "pages") {
    const apiBase = (process.env.VITE_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
    return {
      root: "web",
      base: "/ContextTrace/",
      build: { outDir: "../dist/pages", emptyOutDir: true },
      // The client reads the same value, so its calls and the policy below always agree.
      define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBase) },
      plugins: [react(), cspMeta(new URL(apiBase).origin)],
    };
  }
  return {
    root: "web",
    build: { outDir: "../dist", emptyOutDir: true },
    plugins: [react(), cloudflare({ configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) })],
  };
});

/**
 * GitHub Pages sends no custom headers, so the policy of web/public/_headers goes into a meta
 * tag, with the API's origin added to connect-src. frame-ancestors has no meta form and is left out.
 */
function cspMeta(apiOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    `connect-src 'self' ${apiOrigin}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  return {
    name: "csp-meta",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" }],
  };
}
