// Acceptance test for the macOS platform driver — closes ship-checklist
// item 10 from `vault/specs/implementation/kernel/driver-macos.md`.
//
// Spawns the real `gctrld` binary on a random port, polls `/health`
// until ready, then asserts the shape of `/api/macos/health`. This is
// the contract the desktop renderer relies on when surfacing the AX
// permission CTA (PR #149) — if the kernel ever stops mounting the
// macOS driver routes, this test fails before the renderer breaks
// silently.
//
// CI: this test runs after `cargo build --bin gctrld --locked` has
// produced `target/debug/gctrld`. Locally it skips itself with a
// helpful message if the binary isn't present, so `pnpm test` on a
// fresh checkout (no Rust build yet) doesn't fail.

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const PROJECT_ROOT = path.resolve(__dirname, "../../../../..")
const KERNEL_BIN =
  process.env.GCTRLD_BIN ??
  path.join(PROJECT_ROOT, "target", "debug", "gctrld")

const KERNEL_AVAILABLE = existsSync(KERNEL_BIN)

/// Returns a port that's unused at the moment of asking. Race-prone
/// on principle; ample margin in practice for an integration test
/// where we're the only contender for the port.
async function findFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error("address() returned no port")))
      }
    })
  })
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
      lastErr = new Error(`status ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `kernel did not become healthy in ${timeoutMs}ms (last: ${String(lastErr)})`,
  )
}

describe.skipIf(!KERNEL_AVAILABLE)(
  "/api/macos/health (live kernel)",
  () => {
    let proc: ChildProcess | null = null
    let port = 0
    let dataDir = ""

    beforeAll(async () => {
      port = await findFreePort()
      dataDir = mkdtempSync(path.join(tmpdir(), "gctrld-acceptance-"))
      proc = spawn(
        KERNEL_BIN,
        [
          "serve",
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
          "--db",
          path.join(dataDir, "gctrl.duckdb"),
          "--no-watch",
          "--no-relay",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          // Disable the default-on prevent-sleep assertion so the power
          // tests below control the state deterministically (and the test
          // daemon doesn't hold a system assertion for its whole lifetime).
          env: { ...process.env, RUST_LOG: "warn", GCTRL_PREVENT_SLEEP: "off" },
        },
      )
      // Surface daemon failures (port already bound, missing migrations,
      // etc.) with their actual stderr instead of a 30s timeout.
      let stderrBuf = ""
      proc.stderr?.on("data", (chunk) => {
        stderrBuf += String(chunk)
      })
      proc.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          // Stash so the assertion reports something useful.
          // eslint-disable-next-line no-console
          console.error(
            `gctrld exited code=${code} signal=${signal}\n${stderrBuf}`,
          )
        }
      })
      await waitForHealth(port, 30_000)
    }, 45_000)

    afterAll(async () => {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM")
        // Give it a moment for graceful shutdown; SIGKILL if it lingers.
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            proc?.kill("SIGKILL")
            resolve()
          }, 3000)
          proc?.on("exit", () => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      if (dataDir && existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true })
      }
    })

    it("returns the platform-driver health shape", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/macos/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        os: string
        version: string | null
        capabilities: string[]
        permissions: { accessibility?: string }
        version_skew: boolean
      }
      // `os` is the host platform discriminator the driver baked in at
      // compile time — on macOS hosts it's "macos"; on Linux CI the
      // driver still mounts the routes but reports "unknown" or the
      // host OS, since the FFI body is excluded by cfg(target_os).
      expect(["macos", "linux", "windows", "unknown"]).toContain(body.os)
      // capabilities is always an array, even when empty (when AX is
      // not granted). The driver reports `["spaces"]` when both AX is
      // granted AND the FfiSpaces port construction succeeds.
      expect(Array.isArray(body.capabilities)).toBe(true)
      // Accessibility status tri-state. On Linux/non-FFI builds the
      // stub probe returns `not_requested`. On macOS+FFI it'll be
      // `granted` or `denied` based on TCC. `not_promptable` is rare
      // (sandboxed daemons that can't surface the prompt at all).
      const ax = body.permissions.accessibility
      expect(ax === undefined || [
        "granted",
        "denied",
        "not_requested",
        "not_promptable",
      ].includes(ax)).toBe(true)
      // version_skew is only true when the layout fixture mismatches
      // a live thumbnail count; a fresh boot can't trigger it.
      expect(body.version_skew).toBe(false)
    })

    it("/api/macos/spaces returns an array (empty on a fresh DB)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/macos/spaces`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as unknown[]
      expect(Array.isArray(body)).toBe(true)
    })

    it("rejects empty space names with 400", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/macos/spaces/1/name`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "  " }),
        },
      )
      expect(res.status).toBe(400)
    })

    it("persistence round-trips: POST 204, DELETE 204", async () => {
      // The name+unname pipeline writes/clears a row in
      // `macos_space_labels` regardless of live CGS state. We verify
      // the storage contract (POST 204 → DELETE 204) here; the
      // /spaces *list* shape is platform-dependent (macOS+FFI joins
      // live CGS data, Linux echoes stored labels), so it's covered
      // by the previous "returns an array" test.
      const post = await fetch(
        `http://127.0.0.1:${port}/api/macos/spaces/42/name`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "acceptance-test" }),
        },
      )
      expect(post.status).toBe(204)

      const del = await fetch(
        `http://127.0.0.1:${port}/api/macos/spaces/42/name`,
        { method: "DELETE" },
      )
      expect(del.status).toBe(204)
    })

    it("/api/macos/power reports the prevent-sleep state shape", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/macos/power`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        supported: boolean
        active: boolean
        kind: string
        reason: string
      }
      expect(typeof body.supported).toBe("boolean")
      expect(typeof body.active).toBe("boolean")
      expect(["display", "system"]).toContain(body.kind)
      // GCTRL_PREVENT_SLEEP=off in beforeAll → no assertion held at boot.
      expect(body.active).toBe(false)
    })

    it("/api/macos/power toggles when the capability is present", async () => {
      const powerUrl = `http://127.0.0.1:${port}/api/macos/power`
      const status = (await (await fetch(powerUrl)).json()) as {
        supported: boolean
      }

      if (!status.supported) {
        // Linux CI / non-FFI build: toggling is unsupported → 501.
        const res = await fetch(powerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enable: true }),
        })
        expect(res.status).toBe(501)
        return
      }

      // macOS + FFI: enable holds a real IOPMAssertion, disable releases it.
      const on = await fetch(powerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enable: true, kind: "display" }),
      })
      expect(on.status).toBe(200)
      expect(((await on.json()) as { active: boolean }).active).toBe(true)

      const off = await fetch(powerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enable: false }),
      })
      expect(off.status).toBe(200)
      expect(((await off.json()) as { active: boolean }).active).toBe(false)
    })
  },
)

if (!KERNEL_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[macos-health.integration] gctrld not found at ${KERNEL_BIN}; ` +
      `skipping. Run \`cargo build --bin gctrld\` first, or set GCTRLD_BIN.`,
  )
}
