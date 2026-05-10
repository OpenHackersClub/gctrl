// Production health-check adapter for the kernel sidecar singleton probe.
//
// Probes `http://127.0.0.1:<port>/health` with a short timeout. A 2xx response
// whose JSON body matches the gctrl `/health` shape (`{"status":"ok",...}`)
// means a gctrl daemon is already there — the lifecycle defers to it instead
// of spawning the bundled binary, which would race for `:4318` and the DuckDB
// writer lock.
//
// The shape check matters: the bundled sidecar must NOT defer to a foreign
// service squatting on `:4318` that happens to return 200 for `/health`
// (a misconfigured Vite dev server, a Python `http.server`, etc.). Without
// the check, autostart would silently brick with no log clue.
//
// The probe MUST NOT throw. Per the `HealthCheck` contract in
// `kernel-sidecar.ts`, any failure (timeout, connection refused, non-2xx,
// non-gctrl service squatting on the port, malformed JSON) resolves `false`
// so the lifecycle proceeds to spawn.

import type { HealthCheck } from "./kernel-sidecar"

export const PROBE_TIMEOUT_MS = 1500

export const createHealthCheck = (): HealthCheck => async (config) => {
  const url = `http://127.0.0.1:${config.port}/health`
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: unknown }
    return body?.status === "ok"
  } catch {
    return false
  } finally {
    globalThis.clearTimeout(timer)
  }
}
