import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { Effect } from "effect"
import { VaultError } from "../errors.js"

export const resolveVaultDir = () =>
  Effect.gen(function* () {
    const env = process.env.UBER_VAULT_DIR
    if (!env || env.trim() === "") {
      return yield* Effect.fail(
        new VaultError({
          message:
            "UBER_VAULT_DIR is not set. Run `uber vault init <path>` then `export UBER_VAULT_DIR=<path>`.",
        }),
      )
    }
    const abs = resolve(env)
    yield* Effect.tryPromise({
      try: () => access(abs),
      catch: () =>
        new VaultError({
          message: `UBER_VAULT_DIR does not exist: ${abs}`,
          path: abs,
        }),
    })
    return abs
  })
