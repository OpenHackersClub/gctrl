import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Acceptance test config for gctrl-board.
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
 * Set GCTRL_KERNEL_PORT / GCTRL_VITE_PORT to override local defaults.
 */

const KERNEL_PORT = Number(process.env.GCTRL_KERNEL_PORT ?? 14318)
const VITE_PORT = Number(process.env.GCTRL_VITE_PORT ?? 14200)
// LLM relay path: kernel forwards /v1/chat/completions to a mock OpenAI-compat
// server we boot alongside the kernel. Tests POST through the relay port and
// assert the captured prompt/span lands in /api/sessions + /api/analytics.
const RELAY_PORT = Number(process.env.GCTRL_RELAY_PORT ?? 14319)
const MOCK_LLM_PORT = Number(process.env.MOCK_LLM_PORT ?? 14299)

// Remote mode: drive a (deployed) Worker at PREVIEW_URL. Browser is either
// local Chromium (fallback) or Cloudflare Browser Rendering CDP (set
// CDP_ENDPOINT + CF_API_TOKEN). CDP mode enforces a single-connect
// invariant to stay under CF's free-tier rate limit — see fixtures/test.ts.
const isRemote = !!process.env.PREVIEW_URL
const isRemoteCDP = isRemote && !!process.env.CDP_ENDPOINT

// In CI, use the pre-built kernel binary to avoid needing cargo/Rust toolchain.
// Set GCTRL_KERNEL_BIN to the absolute path of the gctrl binary.
const kernelBaseArgs = `--db :memory: serve --host 127.0.0.1 --port ${KERNEL_PORT} --relay-port ${RELAY_PORT} --relay-upstream http://127.0.0.1:${MOCK_LLM_PORT}/v1/chat/completions`
const kernelCommand = process.env.GCTRL_KERNEL_BIN
  ? `${process.env.GCTRL_KERNEL_BIN} ${kernelBaseArgs}`
  : `cargo run -p gctrl-cli -- ${kernelBaseArgs}`

export default defineConfig({
  testDir: "./tests/acceptance",
  // In remote mode (preview deploy), skip tests that need kernel-only
  // endpoints (filesystem, OTLP ingest) not served by the Worker.
  ...(isRemote
    ? {
        testIgnore: [
          "**/agent-integration.spec.ts",
          "**/markdown-sync.spec.ts",
          // Remote Workers don't expose /v1/traces or the LLM relay port,
          // and the mock-llm-server is only booted by the local webServer.
          "**/analytics-llm-relay.spec.ts",
          // Analytics dashboard tests seed via /v1/traces, which is
          // kernel-only. Skip in remote mode for the same reason as
          // agent-integration above.
          "**/analytics-dashboard.spec.ts",
          // Schedule page tests seed via `POST /api/schedules` directly
          // against the kernel; deployed Workers proxy to KERNEL_URL
          // when set, but the schedule routes are kernel-only and the
          // preview Worker has no reachable kernel. Same shape as the
          // analytics-dashboard skip above.
          "**/schedule-page.spec.ts",
        ],
      }
    : {}),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Disable test-level retries in CDP mode: Playwright spawns a new worker
  // (and thus a new connectOverCDP) on retry, which compounds the rate limit.
  retries: process.env.CI && !isRemoteCDP ? 1 : 0,
  workers: 1,
  // In CDP mode, cap failures so a true rate-limit cascade aborts fast,
  // but allow enough failures through to see the full pattern while we're
  // stabilizing the suite against CF Browser Rendering.
  ...(isRemoteCDP ? { maxFailures: 10 } : {}),
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "html",
  timeout: isRemoteCDP ? 60_000 : 30_000,

  use: {
    baseURL: isRemote
      ? process.env.PREVIEW_URL
      : `http://localhost:${VITE_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },

  projects: [
    {
      name: isRemoteCDP ? "cloudflare-cdp" : isRemote ? "remote" : "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Local mode: enable CDP on a random port
        ...(isRemoteCDP
          ? {}
          : {
              // Full-browser new headless instead of chromium-headless-shell:
              // CI installs with `--no-shell` because the shell's download
              // stalls on GitHub runners (see ci.yml). Locally both work;
              // pinning the channel keeps the two environments identical.
              channel: "chromium",
              launchOptions: {
                args: ["--remote-debugging-port=0"],
              },
            }),
      },
    },
  ],

  // Only start local servers in local mode
  ...(isRemote
    ? {}
    : {
        webServer: [
          {
            // Mock OpenAI-compat upstream for the kernel LLM relay. Must
            // start before the kernel so the relay's first request to
            // it succeeds; playwright launches webServers in parallel,
            // but we use `port` health checks so the kernel only waits
            // on its own port and bringup ordering doesn't matter as
            // long as both ports come up before the first test.
            command: `node tests/acceptance/fixtures/mock-llm-server.cjs`,
            port: MOCK_LLM_PORT,
            reuseExistingServer: !process.env.CI,
            env: { MOCK_LLM_PORT: String(MOCK_LLM_PORT) },
            timeout: 30_000,
          },
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
            env: { GCTRL_KERNEL_PORT: String(KERNEL_PORT) },
          },
        ],
      }),
})
