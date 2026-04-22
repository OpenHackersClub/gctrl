import { Context, Effect, Layer } from "effect"
import { IngestError } from "../errors.js"
import { parseFeed } from "../lib/rss.js"
import { FeedService } from "../services/FeedService.js"

export type HttpFeedConfig = {
  readonly fetch?: typeof fetch
  readonly userAgent?: string
}

export class HttpFeedConfigTag extends Context.Tag("uebermensch/HttpFeedConfig")<
  HttpFeedConfigTag,
  HttpFeedConfig
>() {}

// Some feeds (criticalthreats, a few Bloomberg mirrors) 403 on default UAs.
// Use a browser-like UA so we match what `uber ingest url` already does.
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) uebermensch-feed/0.1"

const ingestErr = (kind: IngestError["kind"], url: string, message: string): IngestError =>
  new IngestError({ kind, url, message })

export const HttpFeedLive = Layer.effect(
  FeedService,
  Effect.gen(function* () {
    const config = yield* HttpFeedConfigTag
    const doFetch = config.fetch ?? fetch
    const userAgent = config.userAgent ?? DEFAULT_UA

    return {
      fetchFeed: (url) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () =>
              doFetch(url, {
                headers: {
                  "user-agent": userAgent,
                  accept:
                    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1",
                },
              }),
            catch: (e) => ingestErr("fetch_failed", url, `fetch failed: ${String(e)}`),
          }).pipe(
            Effect.filterOrFail(
              (r) => r.ok,
              (r) => ingestErr("fetch_failed", url, `fetch returned ${r.status}`),
            ),
          )
          const xml = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (e) => ingestErr("fetch_failed", url, `read body failed: ${String(e)}`),
          })
          const parsed = parseFeed(xml)
          return {
            url,
            format: parsed.format,
            title: parsed.title,
            items: parsed.items,
          }
        }),
    }
  }),
)

export const HttpFeedDefaultConfig = Layer.succeed(HttpFeedConfigTag, {})
