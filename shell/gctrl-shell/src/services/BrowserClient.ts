/**
 * BrowserClient — port for driving the kernel's `driver-browser` (CDP
 * attach layer + recorder) over its HTTP API.
 *
 * Apps and acceptance tests acquire a session here, then connect their
 * own Playwright / Puppeteer / chromiumoxide client to `cdpEndpoint`
 * over WebSocket. After the scenario finishes, `report(id)` returns the
 * structured `ObservabilityReport` derived from the CDP frame stream.
 *
 * Spec: `vault/specs/implementation/kernel/driver-browser.md`.
 */
import { Context, type Effect, Schema } from "effect"
import type { KernelError, KernelUnavailableError } from "../errors"

// --- schemas ---

export const RecordingOptions = Schema.Struct({
  network: Schema.optional(Schema.Boolean),
  console: Schema.optional(Schema.Boolean),
  performance: Schema.optional(Schema.Boolean),
  screenshots: Schema.optional(Schema.Boolean),
  full: Schema.optional(Schema.Boolean),
  maxBytes: Schema.optional(Schema.Number),
})
export type RecordingOptions = Schema.Schema.Type<typeof RecordingOptions>

export const Viewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
})
export type Viewport = Schema.Schema.Type<typeof Viewport>

export const SessionOptions = Schema.Struct({
  viewport: Schema.optional(Viewport),
  headed: Schema.optional(Schema.Boolean),
  recording: Schema.optional(RecordingOptions),
  ttlSeconds: Schema.optional(Schema.Number),
})
export type SessionOptions = Schema.Schema.Type<typeof SessionOptions>

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  browserVersion: Schema.String,
  status: Schema.Literal("active", "releasing", "expired"),
  recording: Schema.Struct({
    network: Schema.Boolean,
    console: Schema.Boolean,
    performance: Schema.Boolean,
    screenshots: Schema.Boolean,
    full: Schema.Boolean,
    maxBytes: Schema.Number,
  }),
  cdpEndpoint: Schema.String,
  token: Schema.String,
  droppedFrames: Schema.optional(Schema.Number),
})
export type SessionInfo = Schema.Schema.Type<typeof SessionInfo>

export const SessionList = Schema.Array(SessionInfo)

export const HealthInfo = Schema.Struct({
  chromiumVersion: Schema.NullOr(Schema.String),
  activeSessions: Schema.Number,
  chromiumCount: Schema.optional(Schema.Number),
  poolMax: Schema.Number,
  contextsPerChromiumMax: Schema.Number,
  recycleIdleSeconds: Schema.Number,
  recycleMaxAgeSeconds: Schema.Number,
})
export type HealthInfo = Schema.Schema.Type<typeof HealthInfo>

export const CapturedRequest = Schema.Struct({
  requestId: Schema.String,
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  failed: Schema.Boolean,
})
export type CapturedRequest = Schema.Schema.Type<typeof CapturedRequest>

export const ConsoleEntry = Schema.Struct({
  seq: Schema.Number,
  level: Schema.Literal("log", "info", "warn", "error", "debug", "exception"),
  kind: Schema.String,
  text: Schema.String,
  ts: Schema.String,
})
export type ConsoleEntry = Schema.Schema.Type<typeof ConsoleEntry>

export const MetricSample = Schema.Struct({
  name: Schema.String,
  value: Schema.Number,
  ts: Schema.String,
})
export type MetricSample = Schema.Schema.Type<typeof MetricSample>

export const ObservabilityReport = Schema.Struct({
  sessionId: Schema.String,
  requests: Schema.Array(CapturedRequest),
  console: Schema.Array(ConsoleEntry),
  metrics: Schema.Array(MetricSample),
  stats: Schema.Struct({
    recordedBytes: Schema.Number,
    droppedFrames: Schema.Number,
    requestCount: Schema.Number,
    consoleCount: Schema.Number,
    metricCount: Schema.Number,
    errorConsoleCount: Schema.Number,
    failedRequestCount: Schema.Number,
  }),
})
export type ObservabilityReport = Schema.Schema.Type<typeof ObservabilityReport>

// --- service tag ---

export class BrowserClient extends Context.Tag("BrowserClient")<
  BrowserClient,
  {
    readonly health: () => Effect.Effect<
      HealthInfo,
      KernelError | KernelUnavailableError
    >
    readonly acquire: (
      opts?: SessionOptions
    ) => Effect.Effect<SessionInfo, KernelError | KernelUnavailableError>
    readonly list: () => Effect.Effect<
      ReadonlyArray<SessionInfo>,
      KernelError | KernelUnavailableError
    >
    readonly get: (
      id: string
    ) => Effect.Effect<SessionInfo, KernelError | KernelUnavailableError>
    readonly release: (
      id: string
    ) => Effect.Effect<void, KernelError | KernelUnavailableError>
    readonly network: (
      id: string
    ) => Effect.Effect<
      ReadonlyArray<CapturedRequest>,
      KernelError | KernelUnavailableError
    >
    readonly console: (
      id: string
    ) => Effect.Effect<
      ReadonlyArray<ConsoleEntry>,
      KernelError | KernelUnavailableError
    >
    readonly metrics: (
      id: string
    ) => Effect.Effect<
      ReadonlyArray<MetricSample>,
      KernelError | KernelUnavailableError
    >
    readonly report: (
      id: string
    ) => Effect.Effect<
      ObservabilityReport,
      KernelError | KernelUnavailableError
    >
  }
>() {}
