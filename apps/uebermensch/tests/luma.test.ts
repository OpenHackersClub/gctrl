import { Effect, Either, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { fetchLumaEvents, lumaCityUrl, parseLumaPage } from "../src/lib/luma.js"

const lumaCityHtml = (events: ReadonlyArray<Record<string, unknown>>): string => {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: events.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: { "@context": "https://schema.org", "@type": "Event", ...e },
    })),
  }
  return `<!doctype html><html><head><title>lu.ma/hong-kong</title>
  <script type="application/ld+json">${JSON.stringify(itemList)}</script>
  </head><body>luma</body></html>`
}

describe("luma — parseLumaPage", () => {
  it("extracts JSON-LD Event entries with name, startDate, url", () => {
    const html = lumaCityHtml([
      {
        name: "AI Infrastructure Meetup",
        startDate: "2026-05-12T19:00:00+08:00",
        endDate: "2026-05-12T21:30:00+08:00",
        url: "https://lu.ma/abc123",
        description: "Discussion on inference + capex",
        location: { "@type": "Place", name: "WeWork Causeway Bay" },
      },
      {
        name: "Pottery basics",
        startDate: "2026-05-15T18:00:00+08:00",
        url: "https://lu.ma/def456",
      },
    ])
    const events = parseLumaPage(html)
    expect(events).toHaveLength(2)
    expect(events[0]?.title).toBe("AI Infrastructure Meetup")
    expect(events[0]?.startsAt).toBe("2026-05-12T19:00:00+08:00")
    expect(events[0]?.endsAt).toBe("2026-05-12T21:30:00+08:00")
    expect(events[0]?.url).toBe("https://lu.ma/abc123")
    expect(events[0]?.location).toContain("WeWork")
    expect(events[0]?.externalId).toBe("luma:abc123")
    expect(events[0]?.tz).toBe("UTC+08:00")
  })

  it("dedupes by externalId across overlapping JSON-LD blocks", () => {
    const ev = {
      name: "Same event",
      startDate: "2026-05-20T19:00:00Z",
      url: "https://lu.ma/dup",
    }
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({ "@type": "Event", ...ev })}</script>
      <script type="application/ld+json">${JSON.stringify({
        "@graph": [{ "@type": "Event", ...ev }],
      })}</script>
      </head></html>`
    const events = parseLumaPage(html)
    expect(events).toHaveLength(1)
  })

  it("ignores non-Event JSON-LD blocks", () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "WebSite",
        url: "https://lu.ma",
      })}</script>
      </head></html>`
    expect(parseLumaPage(html)).toHaveLength(0)
  })

  it("handles malformed JSON without throwing", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ this is not json }</script>
      </head></html>`
    expect(parseLumaPage(html)).toEqual([])
  })

  it("extracts Place address as location", () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Event",
        name: "x",
        startDate: "2026-05-01T10:00:00Z",
        location: {
          "@type": "Place",
          name: "Some venue",
          address: {
            "@type": "PostalAddress",
            streetAddress: "1 Main St",
            addressLocality: "Hong Kong",
          },
        },
      })}</script>
      </head></html>`
    const e = parseLumaPage(html)[0]
    expect(e?.location).toBe("Some venue — 1 Main St, Hong Kong")
  })
})

describe("luma — lumaCityUrl + fetch wrapper", () => {
  it("builds URL from city slug", async () => {
    expect(await Effect.runPromise(lumaCityUrl("hong-kong"))).toBe(
      "https://lu.ma/hong-kong",
    )
    expect(await Effect.runPromise(lumaCityUrl("Tokyo  "))).toBe("https://lu.ma/tokyo")
  })

  it("rejects empty city with a tagged LumaError", async () => {
    const result = await Effect.runPromise(Effect.either(lumaCityUrl("")))
    Either.match(result, {
      onLeft: (e) => expect(e.kind).toBe("invalid_input"),
      onRight: () => expect.fail("expected Left"),
    })
  })

  it("uses the injected fetch impl (no network)", async () => {
    const html = lumaCityHtml([
      { name: "Test", startDate: "2026-05-01T10:00:00Z", url: "https://lu.ma/zzz" },
    ])
    let called = ""
    const fakeFetch = async (url: string) => {
      called = url
      return { ok: true, status: 200, text: async () => html }
    }
    const events = await Effect.runPromise(
      fetchLumaEvents("https://lu.ma/test", { fetch: fakeFetch }),
    )
    expect(called).toBe("https://lu.ma/test")
    expect(events[0]?.title).toBe("Test")
  })

  it("fails with http_error on non-OK response", async () => {
    const fakeFetch = async () => ({ ok: false, status: 404, text: async () => "" })
    const exit = await Effect.runPromiseExit(
      fetchLumaEvents("https://lu.ma/missing", { fetch: fakeFetch }),
    )
    Exit.match(exit, {
      onSuccess: () => expect.fail("expected failure"),
      onFailure: (cause) => {
        const msg = JSON.stringify(cause)
        expect(msg).toMatch(/404/)
        expect(msg).toMatch(/http_error/)
      },
    })
  })
})
