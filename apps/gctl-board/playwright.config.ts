import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Acceptance test config for gctl-board.
 *
 * Two modes:
 *
 * 1. **Local** (default):
 *    Kernel (Rust, :memory: DuckDB)  ←  Vite proxy  ←  Playwright (Chromium)
 *    Starts an isolated kernel + Vite dev server via webServer.
 *
 * 2. **Remote CDP** (CDP_ENDPOINT set):
 *    Deployed Worker (D1)  ←  Cloudflare Browser Rendering (CDP)
 *    Tests run against PREVIEW_URL with a remote browser.
 *    Skips tests that require kernel-only endpoints (/v1/traces, filesystem).
 *
 * Set GCTL_KERNEL_PORT / GCTL_VITE_PORT to override local defaults.
 */

const KERNEL_PORT = Number(process.env.GCTL_KERNEL_PORT ?? 14318)
const VITE_PORT = Number(process.env.GCTL_VITE_PORT ?? 14200)

// Remote CDP mode: Cloudflare Browser Rendering via CDP_ENDPOINT
const isRemoteCDP = !!process.env.CDP_ENDPOINT

// In CI, use the pre-built kernel binary to avoid needing cargo/Rust toolchain.
// Set GCTL_KERNEL_BIN to the absolute path of the gctl binary.
const kernelCommand = process.env.GCTL_KERNEL_BIN
  ? `${process.env.GCTL_KERNEL_BIN} --db :memory: serve --host 127.0.0.1 --port ${KERNEL_PORT}`
  : `cargo run -p gctl-cli -- --db :memory: serve --host 127.0.0.1 --port ${KERNEL_PORT}`

export default defineConfig({
  testDir: "./tests/acceptance",
  // In remote CDP mode, skip tests that need kernel-only endpoints
  ...(isRemoteCDP
    ? {
        testIgnore: [
          "**/agent-integration.spec.ts",
          "**/markdown-sync.spec.ts",
        ],
      }
    : {}),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "html",
  timeout: isRemoteCDP ? 60_000 : 30_000,

  use: {
    baseURL: isRemoteCDP
      ? process.env.PREVIEW_URL
      : `http://localhost:${VITE_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },

  projects: [
    {
      name: isRemoteCDP ? "cloudflare-cdp" : "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Local mode: enable CDP on a random port
        ...(isRemoteCDP
          ? {}
          : {
              launchOptions: {
                args: ["--remote-debugging-port=0"],
              },
            }),
      },
    },
  ],

  // Only start local servers in local mode
  ...(isRemoteCDP
    ? {}
    : {
        webServer: [
          {
            // Kernel: in-memory DuckDB for full test isolation
            command: kernelCommand,
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
      }),
})
