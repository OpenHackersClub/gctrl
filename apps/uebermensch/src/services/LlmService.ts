import { Context, type Effect } from "effect"
import type { LlmError } from "../errors.js"
import type { CandidateRef } from "../lib/candidates.js"
import type { CuratedItem } from "./RendererService.js"

export type BriefRequest = {
  readonly date: string
  readonly profileName: string
  readonly topics: ReadonlyArray<string>
  readonly thesesSlugs: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<CandidateRef>
  readonly maxItems: number
}

export type BriefResponse = {
  readonly items: ReadonlyArray<CuratedItem>
  readonly topicsCovered: ReadonlyArray<string>
  readonly thesesCovered: ReadonlyArray<string>
  readonly promptHash: string
  readonly costUsd: number
  readonly model: string
}

export interface LlmServiceShape {
  readonly name: () => string
  readonly generateBrief: (req: BriefRequest) => Effect.Effect<BriefResponse, LlmError>
}

export class LlmService extends Context.Tag("uebermensch/LlmService")<
  LlmService,
  LlmServiceShape
>() {}
