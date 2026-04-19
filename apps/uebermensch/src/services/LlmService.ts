import { Context, type Effect } from "effect"
import type { LlmError } from "../errors.js"
import type { WikiPage } from "./VaultService.js"

export type BriefItem = {
  readonly heading: string
  readonly body: string
  readonly citations: ReadonlyArray<string>
}

export type BriefRequest = {
  readonly date: string
  readonly profileName: string
  readonly pages: ReadonlyArray<WikiPage>
  readonly topics: ReadonlyArray<string>
}

export type BriefResponse = {
  readonly items: ReadonlyArray<BriefItem>
  readonly topicsCovered: ReadonlyArray<string>
}

export interface LlmServiceShape {
  readonly name: () => string
  readonly generateBrief: (req: BriefRequest) => Effect.Effect<BriefResponse, LlmError>
}

export class LlmService extends Context.Tag("uebermensch/LlmService")<
  LlmService,
  LlmServiceShape
>() {}
