import { Effect, Layer, Match } from "effect"
import { DeliveryError } from "../errors.js"
import {
  chunkPrefix,
  classifyHttpStatus,
  configErr,
  DC_MAX,
  resolveEnvRef,
  resolveRef,
  splitBrief,
  splitChunks,
  stripFrontmatter,
  TG_MAX,
  unreachableErr,
} from "../lib/deliverer-shared.js"
import {
  DelivererService,
  type DeliverInput,
  type DeliveryResult,
} from "../services/DelivererService.js"
import { SecretsService, type SecretsServiceImpl } from "../services/SecretsService.js"

const kernelBase = () =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

const postToKernel = (
  path: string,
  body: unknown,
  channel: string,
  driver: string,
): Effect.Effect<unknown, DeliveryError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${kernelBase()}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      catch: (e) =>
        unreachableErr(`kernel ${path}`, channel, driver, `fetch failed: ${String(e)}`),
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) =>
        unreachableErr(`kernel ${path}`, channel, driver, `body read failed: ${String(e)}`),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new DeliveryError({
          message: `kernel ${path} HTTP ${response.status}: ${text.slice(0, 500)}`,
          channel,
          driver,
          kind: classifyHttpStatus(response.status),
          status: response.status,
        }),
      )
    }
    if (text.length === 0) return {}
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) =>
        new DeliveryError({
          message: `kernel ${path} JSON parse failed: ${String(e)}`,
          channel,
          driver,
          kind: "invalid",
        }),
    })
  })

const sendTelegram = (
  secrets: SecretsServiceImpl,
  input: DeliverInput,
): Effect.Effect<DeliveryResult, DeliveryError> =>
  Effect.gen(function* () {
    const chatId = yield* resolveRef(
      secrets,
      input.targetRef,
      "tg:chat:",
      input.channel,
      input.driver,
    )
    const chunks = splitBrief(input.content, TG_MAX)
    const responses = yield* Effect.forEach(chunks, (chunk, i) =>
      postToKernel(
        "/api/telegram/send",
        {
          chat_id: chatId,
          text: `${chunkPrefix(i, chunks.length)}${chunk}`,
          disable_notification: input.silent,
        },
        input.channel,
        input.driver,
      ).pipe(Effect.map((json) => json as { message_id?: number | null })),
    )
    const externalIds = responses
      .map((r) => r.message_id)
      .filter((id): id is number => typeof id === "number")
      .map(String)
    return {
      channel: input.channel,
      driver: input.driver,
      externalIds,
      parts: chunks.length,
    }
  })

const sendDiscord = (
  secrets: SecretsServiceImpl,
  input: DeliverInput,
): Effect.Effect<DeliveryResult, DeliveryError> =>
  Effect.gen(function* () {
    const webhook = yield* resolveRef(
      secrets,
      input.targetRef,
      "dc:webhook:",
      input.channel,
      input.driver,
    )
    const chunks = splitBrief(input.content, DC_MAX)
    yield* Effect.forEach(chunks, (chunk, i) => {
      const prefix = chunkPrefix(i, chunks.length)
      const content = input.silent ? `@silent ${prefix}${chunk}` : `${prefix}${chunk}`
      return postToKernel(
        "/api/discord/send",
        { webhook_url: webhook, content },
        input.channel,
        input.driver,
      )
    })
    return {
      channel: input.channel,
      driver: input.driver,
      externalIds: [],
      parts: chunks.length,
    }
  })

const sendApp = (input: DeliverInput): Effect.Effect<DeliveryResult, DeliveryError> =>
  Effect.succeed({
    channel: input.channel,
    driver: input.driver,
    externalIds: [],
    parts: 1,
  })

// HttpDelivererLive requires SecretsService to resolve env-backed target refs
// (e.g. `tg:chat:env:TELEGRAM_CHAT_ID`). Callers compose with EnvSecretsLive
// (transitional) or a future KernelSecretsLive/LocalKeychainLive adapter.
// Secrets are captured once at Layer-build time and closed over — keeps the
// per-call Effects free of `SecretsService` in their R channel.
export const HttpDelivererLive = Layer.effect(
  DelivererService,
  Effect.gen(function* () {
    const secrets = yield* SecretsService
    return {
      send: (input: DeliverInput): Effect.Effect<DeliveryResult, DeliveryError> =>
        Match.value(input.driver).pipe(
          Match.when("telegram", () => sendTelegram(secrets, input)),
          Match.when("discord", () => sendDiscord(secrets, input)),
          Match.when("app", () => sendApp(input)),
          Match.orElse(() =>
            Effect.fail(
              configErr(input.channel, input.driver, `unknown driver: ${input.driver}`),
            ),
          ),
        ),
    }
  }),
)

// Kept for back-compat with existing tests that destructure `_internal`.
// New code should import directly from `lib/deliverer-shared.ts`.
export const _internal = {
  splitChunks,
  splitBrief,
  stripFrontmatter,
  resolveEnvRef,
  kernelBase,
  resolveRef,
  classifyKernelStatus: classifyHttpStatus,
}
