import { Effect, Layer, Match, Option } from "effect"
import { DeliveryError } from "../errors.js"
import {
  DelivererService,
  type DeliverInput,
  type DeliveryResult,
} from "../services/DelivererService.js"
import { SecretsService, type SecretsServiceImpl } from "../services/SecretsService.js"

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
// `<prefix><value>`. Pure parser — never touches `process.env`; that read is
// the exclusive responsibility of the `SecretsService` adapter.
const resolveEnvRef = (
  targetRef: string,
  prefix: string,
): { kind: "env"; key: string } | { kind: "literal"; value: string } | null => {
  if (!targetRef.startsWith(prefix)) return null
  const rest = targetRef.slice(prefix.length)
  if (rest.startsWith("env:")) return { kind: "env", key: rest.slice(4) }
  return { kind: "literal", value: rest }
}

const configErr = (channel: string, driver: string, message: string): DeliveryError =>
  new DeliveryError({ message, channel, driver, kind: "config" })

// Resolve a prefixed target ref to its concrete string value. Literal refs
// are returned synchronously; env-backed refs (`env:<KEY>`) are resolved via
// `SecretsService.get` so the actual `process.env` read is isolated to the
// EnvSecretsLive adapter — future adapters (kernel secrets, keychain) swap in
// without touching this file. `secrets` is captured at Layer-build time, not
// requested as a Service requirement, so the returned Effect's R channel is
// `never`.
const resolveRef = (
  secrets: SecretsServiceImpl,
  targetRef: string,
  prefix: string,
  channel: string,
  driver: string,
): Effect.Effect<string, DeliveryError> =>
  Effect.gen(function* () {
    const parsed = resolveEnvRef(targetRef, prefix)
    if (parsed === null) {
      return yield* Effect.fail(
        configErr(channel, driver, `unresolved target_ref for ${driver}: ${targetRef}`),
      )
    }
    if (parsed.kind === "literal") return parsed.value
    const val = yield* secrets.get(parsed.key).pipe(
      Effect.catchTag("SecretsError", (e) =>
        Effect.fail(
          configErr(
            channel,
            driver,
            `secret lookup failed for ${driver} (key=${parsed.key}): ${e.message}`,
          ),
        ),
      ),
    )
    return yield* Option.match(val, {
      onNone: () =>
        Effect.fail(
          configErr(channel, driver, `unresolved target_ref for ${driver}: ${targetRef}`),
        ),
      onSome: Effect.succeed,
    })
  })

// 503 means the kernel is up but its driver is misconfigured (e.g. no bot
// token). Other 5xx are network/health failures — caller should retry.
const classifyKernelStatus = (
  status: number,
): "config" | "unreachable" | "rate_limited" | "invalid" | "io_failure" => {
  if (status === 429) return "rate_limited"
  if (status === 503) return "unreachable"
  if (status === 502 || status === 504) return "unreachable"
  if (status >= 500) return "unreachable"
  if (status === 400 || status === 401 || status === 403 || status === 404) return "invalid"
  return "io_failure"
}

const kernelBase = () =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

const unreachableErr = (
  path: string,
  channel: string,
  driver: string,
  reason: string,
): DeliveryError =>
  new DeliveryError({
    message: `kernel ${path} ${reason}`,
    channel,
    driver,
    kind: "unreachable",
  })

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
      catch: (e) => unreachableErr(path, channel, driver, `fetch failed: ${String(e)}`),
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) => unreachableErr(path, channel, driver, `body read failed: ${String(e)}`),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new DeliveryError({
          message: `kernel ${path} HTTP ${response.status}: ${text.slice(0, 500)}`,
          channel,
          driver,
          kind: classifyKernelStatus(response.status),
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

const chunkPrefix = (i: number, total: number): string =>
  total > 1 ? `(${i + 1}/${total})\n` : ""

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

export const _internal = {
  splitChunks,
  splitBrief,
  stripFrontmatter,
  resolveEnvRef,
  kernelBase,
  resolveRef,
  classifyKernelStatus,
}
