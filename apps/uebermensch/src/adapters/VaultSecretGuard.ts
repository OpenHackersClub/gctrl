import { Effect, Layer } from "effect"
import { VaultSecretLeakError } from "../errors.js"
import { scanForSecrets } from "../lib/secret-patterns.js"
import { VaultWriterPort } from "../services/VaultWriterPort.js"

/**
 * Middleware Layer that wraps any VaultWriterPort implementation.
 *
 * On every `write` call, `scanForSecrets` is run against the content before
 * delegating to the inner adapter. If any known secret pattern is detected the
 * write is rejected immediately with `VaultSecretLeakError` — the inner
 * adapter is never called and nothing is persisted. All other methods (`read`,
 * `list`, `delete`) are forwarded to the inner adapter unchanged.
 *
 * Usage:
 *   Layer.provide(vaultSecretGuard(FsVaultWriterLive), ...)
 */
export const vaultSecretGuard = (
  inner: Layer.Layer<VaultWriterPort>,
): Layer.Layer<VaultWriterPort> =>
  Layer.effect(
    VaultWriterPort,
    Effect.gen(function* () {
      const delegate = yield* Effect.provide(VaultWriterPort, inner)
      return {
        write: (path, content) =>
          Effect.gen(function* () {
            const leaks = scanForSecrets(content)
            if (leaks.length > 0) {
              yield* Effect.fail(
                new VaultSecretLeakError({
                  message: `write blocked: ${leaks.length} secret pattern(s) detected in content for "${path}"`,
                  path,
                  leaks,
                }),
              )
            }
            return yield* delegate.write(path, content)
          }),
        read: (path) => delegate.read(path),
        list: (prefix) => delegate.list(prefix),
        delete: (path) => delegate.delete(path),
      }
    }),
  )
