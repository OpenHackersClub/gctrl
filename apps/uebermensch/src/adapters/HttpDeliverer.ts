import { Effect, Layer, Option } from "effect"
import { DeliveryError, SecretsError } from "../errors.js"
import {
  DelivererService,
  type DeliverInput,
  type DeliveryResult,
} from "../services/DelivererService.js"
import { SecretsService } from "../services/SecretsService.js"

const TG_MAX = 3800
const DC_MAX = 1900

const splitChunks = (content: string, max: number): ReadonlyArray<string> => {
  if (content.length <= max) return [content]
  const chunks: Array<string> = []
  const lines = content.split("\n")
  let buf = ""
  for (const line of lines) {
    const next = buf.length === 0 ? line : `${buf}\n${line}`
    if (next.length > max && buf.length > 0) {
      chunks.push(buf)
      buf = line
    } else if (next.length > max) {
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
      buf = ""
    } else {
      buf = next
    }
  }
  if (buf.length > 0) chunks.push(buf)
  return chunks
}

const stripFrontmatter = (md: string): string => {
  if (!md.startsWith("---\n")) return md
  const end = md.indexOf("\n---\n", 4)
  if (end === -1) return md
  return md.slice(end + 5).replace(/^\n+/, "")
}

const ITEM_HEADING = /^## \d+\. /m

const splitBrief = (content: string, max: number): ReadonlyArray<string> => {
  const body = stripFrontmatter(content)
  if (!ITEM_HEADING.test(body)) return splitChunks(body, max)
  const withoutH1 = body.replace(/^#\s+[^\n]*\n+/, "")
  const parts = withoutH1
    .split(/(?=^## \d+\. )/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const out: Array<string> = []
  for (const p of parts) {
    if (p.length <= max) out.push(p)
    else for (const c of splitChunks(p, max)) out.push(c)
  }
  return out
}

// Parse a `prefix`-scoped target ref into either a literal value or an env
// key name. Returns `null` when the prefix does not match. Env-backed refs
// have the form `<prefix>env:<ENV_VAR_NAME>`; literal refs are
// `<prefix><value>` — the value is returned as-is without any env lookup.
// `resolveEnvRef` itself never touches `process.env`; that read is the
// exclusive responsibility of the `SecretsService` adapter (EnvSecretsLive).
const resolveEnvRef = (
  targetRef: string,
  prefix: string,
): { kind: "env"; key: string } | { kind: "literal"; value: string } | null => {
  if (!targetRef.startsWith(prefix)) return null
  const rest = targetRef.slice(prefix.length)
  if (rest.startsWith("env:")) return { kind: "env", key: rest.slice(4) }
  return { kind: "literal", value: rest }
}

// Resolve a prefixed target ref to its concrete string value. Literal refs
// are returned synchronously; env-backed refs (`env:<KEY>`) are resolved via
// `SecretsService.get` so the actual `process.env` read is isolated to the
// `EnvSecretsLive` adapter — future adapters (kernel secrets, keychain) can
// swap in without touching this file.
const resolveRef = (
  targetRef: string,
  prefix: string,
  channel: string,
  driver: string,
): Effect.Effect<string, DeliveryError, SecretsService> =>
  Effect.gen(function* () {
    const parsed = resolveEnvRef(targetRef, prefix)
    if (parsed === null) {
      return yield* Effect.fail(
        new DeliveryError({
          message: `unresolved target_ref for ${driver}: ${targetRef}`,
          channel,
          driver,
          kind: "config",
        }),
      )
    }
    if (parsed.kind === "literal") return parsed.value
    const secrets = yield* SecretsService
    const val = yield* secrets.get(parsed.key).pipe(
      Effect.catchAll((e: SecretsError) =>
        Effect.fail(
          new DeliveryError({
            message: `secret lookup failed for ${driver} (key=${parsed.key}): ${e.message}`,
            channel,
            driver,
            kind: "config",
          }),
        ),
      ),
    )
    if (Option.isNone(val)) {
      return yield* Effect.fail(
        new DeliveryError({
          message: `unresolved target_ref for ${driver}: ${targetRef}`,
          channel,
          driver,
          kind: "config",
        }),
      )
    }
    return val.value
  })

const classifyKernelStatus = (
  status: number,
): "config" | "unreachable" | "rate_limited" | "invalid" | "io_failure" => {
  if (status === 503) return "config"
  if (status === 429) return "rate_limited"
  if (status === 502 || status === 504) return "unreachable"
  if (status >= 500) return "unreachable"
  if (status === 400 || status === 401 || status === 403 || status === 404) return "invalid"
  return "io_failure"
}

const kernelBase = () =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

const postToKernel = (
  path: string,
  body: unknown,
  channel: string,
  driver: string,
): Effect.Effect<unknown, DeliveryError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${kernelBase()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) {
        const err: DeliveryError = new DeliveryError({
          message: `kernel ${path} HTTP ${res.status}: ${text.slice(0, 500)}`,
          channel,
          driver,
          kind: classifyKernelStatus(res.status),
          status: res.status,
        })
        throw err
      }
      return text.length > 0 ? JSON.parse(text) : {}
    },
    catch: (e) =>
      e instanceof DeliveryError
        ? e
        : new DeliveryError({
            message: `kernel ${path} fetch failed: ${String(e)}`,
            channel,
            driver,
            kind: "unreachable",
          }),
  })

const sendTelegram = (input: DeliverInput): Effect.Effect<DeliveryResult, DeliveryError, SecretsService> =>
  Effect.gen(function* () {
    const chatId = yield* resolveRef(input.targetRef, "tg:chat:", input.channel, input.driver)
    const chunks = splitBrief(input.content, TG_MAX)
    const externalIds: Array<string> = []
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : ""
      const json = (yield* postToKernel(
        "/api/telegram/send",
        {
          chat_id: chatId,
          text: `${prefix}${chunks[i]}`,
          disable_notification: input.silent,
        },
        input.channel,
        input.driver,
      )) as { message_id?: number | null }
      if (typeof json.message_id === "number") externalIds.push(String(json.message_id))
    }
    return {
      channel: input.channel,
      driver: input.driver,
      externalIds,
      parts: chunks.length,
    }
  })

const sendDiscord = (input: DeliverInput): Effect.Effect<DeliveryResult, DeliveryError, SecretsService> =>
  Effect.gen(function* () {
    const webhook = yield* resolveRef(input.targetRef, "dc:webhook:", input.channel, input.driver)
    const chunks = splitBrief(input.content, DC_MAX)
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : ""
      const content = input.silent ? `@silent ${prefix}${chunks[i]}` : `${prefix}${chunks[i]}`
      yield* postToKernel(
        "/api/discord/send",
        { webhook_url: webhook, content },
        input.channel,
        input.driver,
      )
    }
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
export const HttpDelivererLive = Layer.effect(
  DelivererService,
  Effect.gen(function* () {
    const secrets = yield* SecretsService
    return {
      send: (input: DeliverInput): Effect.Effect<DeliveryResult, DeliveryError> => {
        switch (input.driver) {
          case "telegram":
            return sendTelegram(input).pipe(Effect.provideService(SecretsService, secrets))
          case "discord":
            return sendDiscord(input).pipe(Effect.provideService(SecretsService, secrets))
          case "app":
            return sendApp(input)
          default:
            return Effect.fail(
              new DeliveryError({
                message: `unknown driver: ${input.driver}`,
                channel: input.channel,
                driver: input.driver,
                kind: "config",
              }),
            )
        }
      },
    }
  }),
)

export const _internal = { splitChunks, splitBrief, stripFrontmatter, resolveEnvRef, kernelBase, resolveRef }
