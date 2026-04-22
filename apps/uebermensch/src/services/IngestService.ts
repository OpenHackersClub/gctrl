import { Context, type Effect } from "effect"
import type { IngestError } from "../errors.js"

export type IngestUrlRequest = {
  readonly url: string
  readonly date: string
  readonly topicSlugs: ReadonlyArray<string>
  readonly minWordCount: number
  readonly overwrite: boolean
  // Topics this source CAN cover (from sources.md). Used as a ceiling — the final
  // set is (forceTopics ∩ classified). Pass undefined to skip the intersection and
  // use classifier results alone (e.g. from manual `uber ingest url`).
  readonly forceTopics?: ReadonlyArray<string>
  // Per-topic watchlist terms from topics.md. Expanded during classification so
  // a page matches `japan-macro` when its text mentions "boj", "yen", "jgb" etc.
  readonly topicWatchlists?: Readonly<Record<string, ReadonlyArray<string>>>
  // Free description/summary from the feed item (RSS <description> / Atom <summary>).
  // Used as body when the fetched article turns out to be paywalled.
  readonly descriptionFromFeed?: string
}

export type IngestedSource = {
  readonly slug: string
  readonly relPath: string
  readonly absPath: string
  readonly title: string
  readonly domain: string
  readonly wordCount: number
  readonly topicsMatched: ReadonlyArray<string>
  readonly contentHash: string
  readonly paywalled: boolean
  readonly bodySource: "extracted" | "rss_description"
}

export interface IngestServiceShape {
  readonly ingestUrl: (
    req: IngestUrlRequest,
  ) => Effect.Effect<IngestedSource, IngestError>
}

export class IngestService extends Context.Tag("uebermensch/IngestService")<
  IngestService,
  IngestServiceShape
>() {}
