import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { cloudflare } from "@cloudflare/vite-plugin";

// The React application lives under web/ (index.html, src/, public/); the Worker entry
// (worker/src/index.ts) and wrangler.jsonc stay at the repository root.
export default defineConfig({
  root: "web",
  // Build into <repo>/dist (dist/client and dist/contexttrace), not web/dist.
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react(), cloudflare({ configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) })],
});
