import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The Workers runtime cannot read modules that Vitest 5 caches on disk
    // mid-run (ENOENT on node_modules/.vitest-cache/<hash>), so keep this off.
    fsModuleCache: false,
  },
});
