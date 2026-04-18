import { describe, it, expect } from "vitest"
import { Effect, Either } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { KernelError } from "../src/errors"
import { SearchResponse } from "../src/commands/search"
import { createMockKernelClient } from "./helpers/mock-kernel"

const braveWebResult = {
  query: "cloudflare browser rendering",
  kind: "web",
  results: [
    {
      title: "Browser Rendering · Cloudflare docs",
      url: "https://developers.cloudflare.com/browser-rendering/",
      description: "Programmatically load and fully render dynamic webpages.",
      age: "1 week ago",
    },
    {
      title: "Get started · Browser Rendering",
      url: "https://developers.cloudflare.com/browser-rendering/get-started/",
      description: "Cloudflare Browser Rendering lets you control a headless browser.",
    },
  ],
}

const HealthyLayer = createMockKernelClient(
  {},
  {
    "/api/search/web": braveWebResult,
    "/api/search/news": { ...braveWebResult, kind: "news" },
    "/api/search/images": { ...braveWebResult, kind: "images" },
  }
)

describe("gctrl search (via kernel /api/search/*)", () => {
  it("decodes web search response", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/search/web", { q: "x" }, SearchResponse)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(HealthyLayer)))
    expect(result.kind).toBe("web")
    expect(result.results.length).toBe(2)
    expect(result.results[0].age).toBe("1 week ago")
    expect(result.results[1].age).toBeUndefined()
  })

  it("decodes news search response", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/search/news", { q: "x" }, SearchResponse)
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(HealthyLayer)))
    expect(result.kind).toBe("news")
  })

  it("surfaces KernelError when kernel reports missing API key", async () => {
    const Unavailable = createMockKernelClient({})
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/search/web", { q: "x" }, SearchResponse)
    })
    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(Unavailable)))
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(KernelError)
    }
  })
})
