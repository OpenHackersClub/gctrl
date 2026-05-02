// Transitional SecretsService backed by process.env. Future kernel /
// keychain / wrangler-secrets adapters swap in without touching consumers.

import { Effect, Layer, Option } from "effect"
import { SecretsService } from "../services/SecretsService.js"

const get = (key: string) =>
  Effect.sync(() =>
    Option.fromNullable(process.env[key]).pipe(Option.filter((s) => s.length > 0)),
  )

export const EnvSecretsLive = Layer.succeed(SecretsService, {
  get,
  has: (key) => get(key).pipe(Effect.map(Option.isSome)),
})
