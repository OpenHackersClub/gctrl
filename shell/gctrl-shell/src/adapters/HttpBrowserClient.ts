/**
 * HttpBrowserClient — KernelClient-backed adapter for `BrowserClient`.
 *
 * Translates the typed BrowserClient port into kernel HTTP calls
 * against `/api/browser/*`. Schemas live in the port file; this adapter
 * just wires routes.
 */
import { Effect, Layer } from "effect"
import { KernelClient } from "../services/KernelClient"
import {
  BrowserClient,
  CapturedRequest,
  ConsoleEntry,
  HealthInfo,
  MetricSample,
  ObservabilityReport,
  SessionInfo,
  SessionList,
  type SessionOptions,
} from "../services/BrowserClient"
import { Schema } from "effect"

const CapturedRequestList = Schema.Array(CapturedRequest)
const ConsoleEntryList = Schema.Array(ConsoleEntry)
const MetricSampleList = Schema.Array(MetricSample)

export const HttpBrowserClientLive = Layer.effect(
  BrowserClient,
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    return BrowserClient.of({
      health: () => kernel.get("/api/browser/health", HealthInfo),
      acquire: (opts?: SessionOptions) =>
        kernel.post("/api/browser/sessions", opts ?? {}, SessionInfo),
      list: () => kernel.get("/api/browser/sessions", SessionList),
      get: (id) =>
        kernel.get(`/api/browser/sessions/${encodeURIComponent(id)}`, SessionInfo),
      release: (id) =>
        kernel.delete(`/api/browser/sessions/${encodeURIComponent(id)}`),
      network: (id) =>
        kernel.get(
          `/api/browser/sessions/${encodeURIComponent(id)}/network`,
          CapturedRequestList
        ),
      console: (id) =>
        kernel.get(
          `/api/browser/sessions/${encodeURIComponent(id)}/console`,
          ConsoleEntryList
        ),
      metrics: (id) =>
        kernel.get(
          `/api/browser/sessions/${encodeURIComponent(id)}/metrics`,
          MetricSampleList
        ),
      report: (id) =>
        kernel.get(
          `/api/browser/sessions/${encodeURIComponent(id)}/report`,
          ObservabilityReport
        ),
    })
  })
)
