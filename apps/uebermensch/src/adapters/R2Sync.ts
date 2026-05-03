// Thin HTTP client of the kernel's `/api/sync/vault/push` route.
//
// This adapter replaces the old direct-to-R2 implementation that walked .md
// files locally, computed sha256, maintained `.uber-sync-state.json`, and
// shelled out to `wrangler r2 object put`. All of that now lives in the
// kernel (`gctrl-sync` crate); this module is the kernel-facing port.
//
// Spec: vault/specs/architecture/kernel/sync.md § 2.4 +
//        vault/specs/implementation/kernel/sync-vault.md.
import { Effect, Layer } from "effect"
import {
  SyncError,
  SyncService,
  type SyncInput,
  type SyncResult,
} from "../services/SyncService.js"

// Project key for uebermensch — matches the `[[vault-projects]] key` in
// gctrl-app.toml. The kernel walks `<vault_root>/UBER/` for this key.
const PROJECT_KEY = "UBER"

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

type KernelPlanEntry = {
  rel_path: string
  sha256: string
  size_bytes: number
  action: { kind: "upload" | "skip_hash_match" | "skip_outside_prefix" }
}

type KernelPushResponse = {
  project_key: string
  plan: ReadonlyArray<KernelPlanEntry>
  uploaded: number
  skipped: number
  failed: number
  bytes_uploaded: number
}

const syncErr = (
  kind: SyncError["kind"],
  message: string,
  key?: string,
): SyncError => new SyncError({ kind, message, key })

const pushViaKernel = (input: SyncInput): Effect.Effect<SyncResult, SyncError> =>
  Effect.gen(function* () {
    const url = `${kernelBase()}/api/sync/vault/push`
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project_key: PROJECT_KEY,
            prefixes: input.prefixes,
            dry_run: input.dryRun,
            force: input.force ?? false,
          }),
        }),
      catch: (e) =>
        syncErr(
          "unreachable",
          `kernel ${url} fetch failed: ${String(e)} — start gctrld with --board-dir or set GCTRL_KERNEL_URL`,
        ),
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) => syncErr("unreachable", `kernel ${url} body read failed: ${String(e)}`),
    })
    if (!response.ok) {
      const kind: SyncError["kind"] =
        response.status === 503 || response.status === 404 ? "config" : "io_failure"
      return yield* Effect.fail(
        syncErr(kind, `kernel ${url} HTTP ${response.status}: ${text.slice(0, 500)}`),
      )
    }
    const body = yield* Effect.try({
      try: () => JSON.parse(text) as KernelPushResponse,
      catch: (e) => syncErr("invalid", `kernel ${url} JSON parse failed: ${String(e)}`),
    })
    return {
      uploaded: body.uploaded,
      skipped: body.skipped,
      failed: body.failed,
      entries: body.plan.map((p) => ({
        absPath: p.rel_path,
        key: p.rel_path,
        sizeBytes: p.size_bytes,
        sha256: p.sha256,
        action: p.action.kind === "upload" ? "upload" : "skip",
        remoteSha256: null,
      })),
    } satisfies SyncResult
  })

export const R2SyncLive = Layer.succeed(SyncService, {
  run: pushViaKernel,
})

// Back-compat shims: kept as no-op layers so existing call sites that compose
// `R2SyncLive.pipe(Layer.provide(R2SyncConfigFromEnv))` keep type-checking.
// All configuration now lives in the kernel — the app passes none.
export const R2SyncConfigFromEnv = Layer.empty
