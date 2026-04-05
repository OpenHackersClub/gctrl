import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Acceptance test config for gctl-board.
 *
 * Architecture:
 *   Kernel (Rust, :memory: DuckDB)  ←  Vite proxy  ←  Playwright (Chromium + CDP)
 *
 * The two webServer entries start an isolated kernel and Vite dev server.
 * Set GCTL_KERNEL_PORT / GCTL_VITE_PORT to override defaults.
 */

const KERNEL_PORT = Number(process.env.GCTL_KERNEL_PORT ?? 14318)
const VITE_PORT = Number(process.env.GCTL_VITE_PORT ?? 14200)

export default defineConfig({
  testDir: "./tests/acceptance",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "html",
  timeout: 30_000,

  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // CDP access enabled by default in Chromium
        launchOptions: {
          args: ["--remote-debugging-port=0"],
        },
      },
    },
  ],

  webServer: [
    {
      // Kernel: in-memory DuckDB for full test isolation
      command: `cargo run -p gctl-cli -- --db :memory: serve --host 127.0.0.1 --port ${KERNEL_PORT}`,
      port: KERNEL_PORT,
      reuseExistingServer: !process.env.CI,
      cwd: path.resolve(__dirname, "../.."),
      timeout: 120_000,
    },
    {
      // Vite: proxies /api/* to the test kernel
      command: `pnpm exec vite --config web/vite.config.ts --port ${VITE_PORT}`,
      port: VITE_PORT,
      reuseExistingServer: !process.env.CI,
      env: { GCTL_KERNEL_PORT: String(KERNEL_PORT) },
    },
  ],
})
