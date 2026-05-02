// DirectDeliverer — talks to Telegram Bot API and Discord webhooks directly,
// bypassing the gctrl kernel. Used in `--mode=local-direct` and the future
// cloud-only Worker target.
//
// Telegram needs `TELEGRAM_BOT_TOKEN` from SecretsService at request time.
// Discord webhooks are unauthenticated — the URL itself is the credential, so
// resolveRef returns the webhook URL and we POST to it directly.

import { Effect, Layer, Match, Option } from "effect"
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

const TELEGRAM_BOT_TOKEN_KEY = "TELEGRAM_BOT_TOKEN"

const telegramApiBase = (): string =>
  (process.env.UBER_TELEGRAM_API_URL ?? "https://api.telegram.org").replace(/\/+$/, "")

// Discord webhooks live on `discord.com/api/webhooks/...`. The webhook URL is
// resolved per-channel via target_ref, but we let tests rebase it via env so
// fixtures can serve a mock without a real webhook.
const discordRebasedUrl = (resolvedUrl: string): string => {
  const override = process.env.UBER_DISCORD_API_URL
  if (!override) return resolvedUrl
  // Rebase only the host, preserve path. If the original URL is malformed,
  // return as-is — DirectDeliverer's fetch will surface the error.
  try {
    const parsed = new URL(resolvedUrl)
    return new URL(parsed.pathname + parsed.search, override).toString()
  } catch {
    return resolvedUrl
  }
}

const postJson = (
  url: string,
  body: unknown,
  channel: string,
  driver: string,
): Effect.Effect<{ readonly status: number; readonly text: string }, DeliveryError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      catch: (e) => unreachableErr(url, channel, driver, `fetch failed: ${String(e)}`),
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) => unreachableErr(url, channel, driver, `body read failed: ${String(e)}`),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new DeliveryError({
          message: `${url} HTTP ${response.status}: ${text.slice(0, 500)}`,
          channel,
          driver,
          kind: classifyHttpStatus(response.status),
          status: response.status,
        }),
      )
    }
    return { status: response.status, text }
  })

const requireBotToken = (
  secrets: SecretsServiceImpl,
  channel: string,
): Effect.Effect<string, DeliveryError> =>
  secrets.get(TELEGRAM_BOT_TOKEN_KEY).pipe(
    Effect.catchTag("SecretsError", (e) =>
      Effect.fail(
        configErr(
          channel,
          "telegram",
          `secret lookup failed for ${TELEGRAM_BOT_TOKEN_KEY}: ${e.message}`,
        ),
      ),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            configErr(
              channel,
              "telegram",
              `${TELEGRAM_BOT_TOKEN_KEY} not provisioned — set the secret via your ` +
                `SecretsService backend (env: export ${TELEGRAM_BOT_TOKEN_KEY}=…) or run ` +
                `uebermensch in --mode=local-kernel.`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )

const sendTelegramDirect = (
  secrets: SecretsServiceImpl,
  input: DeliverInput,
): Effect.Effect<DeliveryResult, DeliveryError> =>
  Effect.gen(function* () {
    const [chatId, botToken] = yield* Effect.all([
      resolveRef(secrets, input.targetRef, "tg:chat:", input.channel, input.driver),
      requireBotToken(secrets, input.channel),
    ])
    const url = `${telegramApiBase()}/bot${botToken}/sendMessage`
    const chunks = splitBrief(input.content, TG_MAX)
    const responses = yield* Effect.forEach(chunks, (chunk, i) =>
      postJson(
        url,
        {
          chat_id: chatId,
          text: `${chunkPrefix(i, chunks.length)}${chunk}`,
          disable_notification: input.silent,
        },
        input.channel,
        input.driver,
      ).pipe(
        Effect.flatMap(({ text }) =>
          Effect.try({
            try: () =>
              JSON.parse(text) as {
                readonly result?: { readonly message_id?: number | null }
              },
            catch: (e) =>
              new DeliveryError({
                message: `telegram response JSON parse failed: ${String(e)}`,
                channel: input.channel,
                driver: input.driver,
                kind: "invalid",
              }),
          }),
        ),
      ),
    )
    const externalIds = responses
      .map((r) => r.result?.message_id)
      .filter((id): id is number => typeof id === "number")
      .map(String)
    return {
      channel: input.channel,
      driver: input.driver,
      externalIds,
      parts: chunks.length,
    }
  })

const sendDiscordDirect = (
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
    const url = discordRebasedUrl(webhook)
    const chunks = splitBrief(input.content, DC_MAX)
    yield* Effect.forEach(chunks, (chunk, i) => {
      const prefix = chunkPrefix(i, chunks.length)
      const content = input.silent ? `@silent ${prefix}${chunk}` : `${prefix}${chunk}`
      return postJson(url, { content }, input.channel, input.driver)
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

// DirectDelivererLive — same DelivererService surface as HttpDelivererLive,
// but no kernel hop. Mode wiring (PR-B slice 4) picks this Layer for
// `--mode=local-direct`.
export const DirectDelivererLive = Layer.effect(
  DelivererService,
  Effect.gen(function* () {
    const secrets = yield* SecretsService
    return {
      send: (input: DeliverInput): Effect.Effect<DeliveryResult, DeliveryError> =>
        Match.value(input.driver).pipe(
          Match.when("telegram", () => sendTelegramDirect(secrets, input)),
          Match.when("discord", () => sendDiscordDirect(secrets, input)),
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
