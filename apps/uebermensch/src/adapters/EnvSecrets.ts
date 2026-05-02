// EnvSecrets — transitional adapter that satisfies SecretsService by reading
// process.env. Ships in the ejection PR so HttpDeliverer's resolveEnvRef
// logic moves behind the port abstraction without requiring a kernel daemon or
// a keychain at startup. Future slices (KernelSecretsLive, LocalKeychainLive,
// WranglerSecretsLive) swap this adapter at composition time; HttpDeliverer
// and any other consumer that depends on SecretsService never need to change.
//
// Key convention: callers pass bare env-var names (e.g. "TELEGRAM_BOT_TOKEN").
// `get` returns Option.none for absent/empty vars — absence is not an error,
// it just means the channel is not configured yet.

import { Effect, Layer, Option } from "effect"
import { SecretsService } from "../services/SecretsService.js"

export const EnvSecretsLive = Layer.succeed(SecretsService, {
  get: (key) =>
    Effect.sync(() => {
      const val = process.env[key]
      return val !== undefined && val.length > 0 ? Option.some(val) : Option.none()
    }),
  has: (key) =>
    Effect.sync(() => {
      const val = process.env[key]
      return val !== undefined && val.length > 0
    }),
})
