import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

/**
 * Workers runtime tests — runs inside Miniflare V8 isolate with D1 bindings.
 * Validates Worker API routes in the same runtime they deploy to, catching
 * D1/nodejs_compat issues that Node.js-based vitest misses.
 */
export default defineWorkersConfig({
  test: {
    setupFiles: ["tests/worker/apply-migrations.ts"],
    include: ["tests/worker/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
})
