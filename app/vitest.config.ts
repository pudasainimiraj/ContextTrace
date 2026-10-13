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
    // Most files run against the live Supabase project in parallel; a single test can
    // wait on several round trips, so the default 5 s is too tight under load.
    testTimeout: 15_000,
  },
});
