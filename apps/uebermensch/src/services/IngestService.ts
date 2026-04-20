import { Context, type Effect } from "effect"
import type { IngestError, VaultError } from "../errors.js"

export type IngestUrlRequest = {
  readonly url: string
  readonly date: string
  readonly topicSlugs: ReadonlyArray<string>
  readonly minWordCount: number
  readonly overwrite: boolean
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
}

export interface IngestServiceShape {
  readonly ingestUrl: (
    req: IngestUrlRequest,
  ) => Effect.Effect<IngestedSource, IngestError | VaultError>
}

export class IngestService extends Context.Tag("uebermensch/IngestService")<
  IngestService,
  IngestServiceShape
>() {}
