import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { BrowserClient } from "../src/services/BrowserClient"
import { HttpBrowserClientLive } from "../src/adapters/HttpBrowserClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

const mockHealth = {
  chromiumVersion: "Chrome/124.0.6367.78",
  activeSessions: 0,
  chromiumCount: 1,
  poolMax: 4,
  contextsPerChromiumMax: 8,
  recycleIdleSeconds: 1800,
  recycleMaxAgeSeconds: 28800,
}

const mockSession = {
  id: "01HV-fake",
  createdAt: "2026-05-02T10:00:00Z",
  expiresAt: "2026-05-02T10:10:00Z",
  browserVersion: "Chrome/124.0.6367.78",
  status: "active" as const,
  recording: {
    network: true,
    console: true,
    performance: true,
    screenshots: false,
    full: false,
    maxBytes: 52428800,
  },
  cdpEndpoint:
    "ws://127.0.0.1:4318/api/browser/sessions/01HV-fake/cdp?token=t",
  token: "t",
  droppedFrames: 0,
}

const mockReport = {
  sessionId: "01HV-fake",
  requests: [
    {
      requestId: "r1",
      url: "https://example.com",
      method: "GET",
      status: 200,
      startedAt: "2026-05-02T10:00:01Z",
      finishedAt: "2026-05-02T10:00:02Z",
      failed: false,
    },
  ],
  console: [],
  metrics: [],
  stats: {
    recordedBytes: 4096,
    droppedFrames: 0,
    requestCount: 1,
    consoleCount: 0,
    metricCount: 0,
    errorConsoleCount: 0,
    failedRequestCount: 0,
  },
}

const TestLayer = HttpBrowserClientLive.pipe(
  Layer.provide(
    createMockKernelClient(
      {
        "/api/browser/health": mockHealth,
        "/api/browser/sessions/01HV-fake/report": mockReport,
        "/api/browser/sessions/01HV-fake": mockSession,
        "/api/browser/sessions": [mockSession],
      },
      {
        "/api/browser/sessions": mockSession,
      }
    )
  )
)

describe("BrowserClient", () => {
  it("health() returns parsed pool info", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* BrowserClient
        return yield* browser.health()
      }).pipe(Effect.provide(TestLayer))
    )
    expect(result.poolMax).toBe(4)
    expect(result.chromiumVersion).toBe("Chrome/124.0.6367.78")
    expect(result.activeSessions).toBe(0)
  })

  it("acquire() returns the new session info", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* BrowserClient
        return yield* browser.acquire({ ttlSeconds: 600 })
      }).pipe(Effect.provide(TestLayer))
    )
    expect(result.id).toBe("01HV-fake")
    expect(result.cdpEndpoint).toContain("token=")
    expect(result.status).toBe("active")
  })

  it("list() returns the session array", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* BrowserClient
        return yield* browser.list()
      }).pipe(Effect.provide(TestLayer))
    )
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("01HV-fake")
  })

  it("get() fetches a single session", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* BrowserClient
        return yield* browser.get("01HV-fake")
      }).pipe(Effect.provide(TestLayer))
    )
    expect(result.token).toBe("t")
  })

  it("report() returns the structured ObservabilityReport", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* BrowserClient
        return yield* browser.report("01HV-fake")
      }).pipe(Effect.provide(TestLayer))
    )
    expect(result.sessionId).toBe("01HV-fake")
    expect(result.requests.length).toBe(1)
    expect(result.requests[0].status).toBe(200)
    expect(result.stats.requestCount).toBe(1)
  })
})
