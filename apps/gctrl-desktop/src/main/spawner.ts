// Production spawner: wraps `node:child_process.spawn` to satisfy the
// `Spawner` port from `kernel-sidecar.ts`.
//
// Argv construction is split into a pure helper (`buildKernelArgs`) so it can
// be unit-tested without touching `child_process`. The full spawner itself
// is integration-tested implicitly when the Electron app launches.

import { spawn, type ChildProcess } from "node:child_process"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

import type { SidecarConfig, SpawnedProcess, Spawner } from "./kernel-sidecar"

/**
 * Directories where user-installed CLIs (`gh`, `wrangler`, …) live but that a
 * macOS GUI launch does not put on `PATH`. When the app is opened from Finder
 * / LaunchServices its `PATH` is the bare `/usr/bin:/bin:/usr/sbin:/sbin`, so
 * the kernel sidecar inherits that and its GitHub/Cloudflare drivers fail to
 * spawn `gh` / `wrangler` (ENOENT → 502 → callers fall back to bare CLIs).
 */
const STANDARD_BIN_DIRS = (home: string): readonly string[] => [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  join(home, ".local/bin"),
  join(home, ".cargo/bin"),
  join(home, ".bun/bin"),
]

/**
 * Augment `PATH` with the standard user-CLI bin dirs so the kernel sidecar can
 * resolve `gh`/`wrangler` regardless of how the app was launched. Existing
 * entries are preserved and take precedence; standard dirs are appended and
 * deduped. Pure for testability.
 */
export const augmentPath = (
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string => {
  const existing = (env.PATH ?? "").split(delimiter).filter(Boolean)
  const seen = new Set(existing)
  const merged = [...existing]
  for (const dir of STANDARD_BIN_DIRS(home)) {
    if (!seen.has(dir)) {
      seen.add(dir)
      merged.push(dir)
    }
  }
  return merged.join(delimiter)
}

/** CLI args passed to the kernel binary. Pure for testability. */
export const buildKernelArgs = (config: SidecarConfig): readonly string[] => {
  const args: string[] = [
    "serve",
    "--port",
    String(config.port),
    "--db",
    `${config.dataDir}/gctrl.duckdb`,
    // Always bind loopback. Never `0.0.0.0` — the desktop kernel must not be
    // reachable from the network, both for security and to avoid Apple App
    // Store review pushback on inbound connections.
    "--host",
    "127.0.0.1",
  ]
  if (config.vaultDir) {
    args.push("--board-dir", config.vaultDir)
  }
  return args
}

/**
 * Wrap a `ChildProcess` as a `SpawnedProcess`. Single-fire `onExit` per the
 * interface contract — a guard prevents the underlying `exit` and `error`
 * events from both calling the handler.
 */
const wrap = (child: ChildProcess): SpawnedProcess => {
  let exitFired = false

  // Stream sidecar logs to the Electron main process console. In a packaged
  // app these end up in the unified log; piping to a file under userData/
  // for support diagnostics is a future enhancement.
  child.stdout?.on("data", (chunk) => process.stdout.write(`[kernel] ${chunk}`))
  child.stderr?.on("data", (chunk) => process.stderr.write(`[kernel] ${chunk}`))

  return {
    pid: child.pid,
    kill: (signal) => {
      child.kill(signal ?? "SIGTERM")
    },
    onExit: (handler) => {
      const fire = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exitFired) return
        exitFired = true
        handler(code, signal)
      }
      child.on("exit", (code, signal) => fire(code, signal))
      // execFile raises 'error' for spawn-time failures (ENOENT, EACCES).
      // Map that to a synthetic exit so the lifecycle treats it as a crash
      // and applies its backoff schedule, rather than hanging silently.
      child.on("error", () => fire(null, null))
    },
  }
}

export const createSpawner = (): Spawner => (config) => {
  const env = { ...process.env, ...(config.env ?? {}) }
  const child = spawn(config.binPath, [...buildKernelArgs(config)], {
    // Augment PATH last so it reflects any config.env override merged above,
    // ensuring the kernel's gh/wrangler drivers resolve even on a bare
    // LaunchServices PATH.
    env: { ...env, PATH: augmentPath(env) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return wrap(child)
}
