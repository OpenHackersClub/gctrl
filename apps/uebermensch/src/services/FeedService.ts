import { Context, type Effect } from "effect"
import type { IngestError } from "../errors.js"
import type { FeedItem } from "../lib/rss.js"

export type FetchedFeed = {
  readonly url: string
  readonly format: "rss2" | "atom" | "unknown"
  readonly title: string
  readonly items: ReadonlyArray<FeedItem>
}

export interface FeedServiceShape {
  readonly fetchFeed: (url: string) => Effect.Effect<FetchedFeed, IngestError>
}

export class FeedService extends Context.Tag("uebermensch/FeedService")<
  FeedService,
  FeedServiceShape
>() {}
