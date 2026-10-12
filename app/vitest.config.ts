import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Test-only binding so the setup file can apply migrations to the isolated D1.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      // The Workers runtime cannot read modules that Vitest 5 caches on disk
      // mid-run (ENOENT on node_modules/.vitest-cache/<hash>), so keep this off.
      fsModuleCache: false,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
