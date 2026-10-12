// Test-only bindings declared in vitest.config.ts (miniflare.bindings).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: Parameters<typeof import("cloudflare:test").applyD1Migrations>[1];
  }
}
