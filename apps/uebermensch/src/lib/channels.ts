import { Effect, Schema } from "effect"
import { DeliveryError } from "../errors.js"
import { Channel } from "../schemas.js"
import { DIRECTIVES_PROFILE_FILE } from "./vault-paths.js"

export type ResolvedChannel = {
  readonly name: string
  readonly driver: string
  readonly targetRef: string
  readonly silent: boolean
}

// Chat channels (telegram, discord, future email) deliver to external surfaces
// where the rendered markdown is a poor preview — they MUST link back to a
// hosted Cloudflare Pages URL. The `app` driver renders the brief inside the
// uebermensch app itself and is exempt. See specs/delivery.md § Hosted-Pages
// requirement.
export const isChatChannel = (ch: ResolvedChannel): boolean =>
  ch.driver !== "app"

export const resolveChannels = (
  channelsRaw: Record<string, unknown>,
  only: string | null,
): Effect.Effect<ReadonlyArray<ResolvedChannel>, DeliveryError> =>
  Effect.gen(function* () {
    const resolved: Array<ResolvedChannel> = []
    for (const [name, raw] of Object.entries(channelsRaw)) {
      if (only !== null && name !== only) continue
      const decoded = yield* Schema.decodeUnknown(Channel)(raw).pipe(
        Effect.mapError(
          (e) =>
            new DeliveryError({
              message: `channel ${name} invalid: ${String(e)}`,
              channel: name,
              kind: "config",
            }),
        ),
      )
      if (!decoded.enabled && only === null) continue
      resolved.push({
        name,
        driver: decoded.driver,
        targetRef: decoded.target_ref,
        silent: decoded.silent ?? false,
      })
    }
    if (only !== null && resolved.length === 0) {
      return yield* Effect.fail(
        new DeliveryError({
          message: `no channel named "${only}" in ${DIRECTIVES_PROFILE_FILE}`,
          channel: only,
          kind: "config",
        }),
      )
    }
    return resolved
  })
