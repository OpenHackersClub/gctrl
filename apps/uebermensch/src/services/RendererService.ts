import { Context, type Effect } from "effect"
import type { CitationError } from "../errors.js"
import type { CandidateRef } from "../lib/candidates.ts"

export type CuratedItem = {
  readonly kind: "news" | "update" | "action" | "alert"
  readonly title: string
  readonly summary_md: string
  readonly topic: string | null
  readonly thesis: string | null
  readonly source_candidate_ids: ReadonlyArray<string>
  readonly suggested_action: string | null
}

export type RenderInput = {
  readonly date: string
  readonly generator: string
  readonly model: string
  readonly promptHash: string
  readonly costUsd: number
  readonly profileName: string
  readonly topicsCovered: ReadonlyArray<string>
  readonly thesesCovered: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<CandidateRef>
  readonly items: ReadonlyArray<CuratedItem>
  readonly vaultSlugs: ReadonlySet<string>
}

export type RenderResult = {
  readonly markdown: string
  readonly itemCount: number
  readonly citedClaims: number
  readonly totalClaims: number
}

export interface RendererServiceShape {
  readonly render: (input: RenderInput) => Effect.Effect<RenderResult, CitationError>
}

export class RendererService extends Context.Tag("uebermensch/RendererService")<
  RendererService,
  RendererServiceShape
>() {}
