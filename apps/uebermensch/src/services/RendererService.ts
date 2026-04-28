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

export type RenderedSubtopic = {
  readonly slug: string
  readonly title: string
  readonly rationale: string
}

export type InterestReportRenderInput = {
  readonly periodLabel: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly generator: string
  readonly model: string
  readonly promptHash: string
  readonly costUsd: number
  readonly profileName: string
  readonly interestSlug: string
  readonly interestTitle: string
  readonly interestQuestion: string | null
  readonly interestTopics: ReadonlyArray<string>
  readonly fieldFamiliarity: "expert" | "novice"
  readonly subtopic: RenderedSubtopic | null
  readonly subtopicAlternatives: ReadonlyArray<RenderedSubtopic>
  readonly analysis_md: string
  readonly items: ReadonlyArray<CuratedItem>
  readonly candidates: ReadonlyArray<CandidateRef>
  readonly vaultSlugs: ReadonlySet<string>
}

export type InterestReportRenderResult = {
  readonly markdown: string
  readonly slug: string
  readonly itemCount: number
  readonly citedClaims: number
  readonly totalClaims: number
}

export type ReportIndexEntry = {
  readonly interestSlug: string
  readonly interestTitle: string
  readonly interestQuestion: string | null
  readonly subtopicTitle: string | null
  readonly reportSlug: string
  readonly publicUrl: string | null
  readonly itemCount: number
  readonly headline: string | null
}

export type ReportIndexRenderInput = {
  readonly periodLabel: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly generator: string
  readonly model: string
  readonly totalCostUsd: number
  readonly profileName: string
  readonly entries: ReadonlyArray<ReportIndexEntry>
}

export type ReportIndexRenderResult = {
  readonly markdown: string
  readonly slug: string
  readonly interestCount: number
}

export interface RendererServiceShape {
  readonly render: (input: RenderInput) => Effect.Effect<RenderResult, CitationError>
  readonly renderInterestReport: (
    input: InterestReportRenderInput,
  ) => Effect.Effect<InterestReportRenderResult, CitationError>
  readonly renderReportIndex: (
    input: ReportIndexRenderInput,
  ) => Effect.Effect<ReportIndexRenderResult, CitationError>
}

export class RendererService extends Context.Tag("uebermensch/RendererService")<
  RendererService,
  RendererServiceShape
>() {}
