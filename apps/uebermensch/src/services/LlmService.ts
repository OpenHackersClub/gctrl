import { Context, type Effect } from "effect";
import type { LlmError } from "../errors.js";
import type { CandidateRef } from "../lib/candidates.js";
import type { SourceDigest } from "../lib/llm-prompts.js";
import type { CuratedItem, Reference } from "./RendererService.js";

export type { Reference };

export type BriefRequest = {
  readonly date: string;
  readonly profileName: string;
  readonly topics: ReadonlyArray<string>;
  readonly thesesSlugs: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<CandidateRef>;
  readonly maxItems: number;
};

export type BriefResponse = {
  readonly items: ReadonlyArray<CuratedItem>;
  readonly topicsCovered: ReadonlyArray<string>;
  readonly thesesCovered: ReadonlyArray<string>;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly model: string;
};

export type FieldFamiliarity = "expert" | "novice";

export type ReportInterestInput = {
  readonly slug: string;
  readonly title: string;
  readonly question: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly notes: string;
  readonly candidates: ReadonlyArray<CandidateRef>;
  readonly fieldFamiliarity: FieldFamiliarity;
};

export type SubtopicProposal = {
  readonly slug: string;
  readonly title: string;
  readonly rationale: string;
  readonly relevantCandidateIds: ReadonlyArray<string>;
};

export type SubtopicProposeRequest = {
  readonly periodLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly profileName: string;
  readonly interest: ReportInterestInput;
};

export type SubtopicProposeResponse = {
  readonly selectedSlug: string;
  readonly proposals: ReadonlyArray<SubtopicProposal>;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
};

export type ReportSubtopic = {
  readonly slug: string;
  readonly title: string;
  readonly rationale: string;
};

export type InterestReportRequest = {
  readonly periodLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly profileName: string;
  readonly interest: ReportInterestInput;
  readonly maxItems: number;
  readonly subtopic: ReportSubtopic | null;
};

export type InterestReportResponse = {
  readonly interestSlug: string;
  readonly analysis_md: string;
  readonly items: ReadonlyArray<CuratedItem>;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
};

export type SourceSummaryRequest = {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly topics: ReadonlyArray<string>;
};

export type SourceSummaryResponse = {
  readonly digest: SourceDigest;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly model: string;
};

export type ResearchQueryContextPage = {
  readonly stem: string;
  readonly title: string;
  readonly topics: ReadonlyArray<string>;
  readonly excerpt: string;
};

export type ResearchQueryRequest = {
  readonly slug: string;
  readonly title: string;
  readonly topics: ReadonlyArray<string>;
  readonly question: string;
  readonly profileName: string;
  readonly contextPages: ReadonlyArray<ResearchQueryContextPage>;
};

export type ResearchQueryResponse = {
  readonly answerMd: string;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly model: string;
};

export type ThoughtThesisRef = {
  readonly slug: string;
  readonly title: string;
  readonly topics: ReadonlyArray<string>;
  readonly excerpt: string;
};

export type ThoughtAnalysisRequest = {
  readonly slug: string;
  readonly title: string;
  readonly topics: ReadonlyArray<string>;
  readonly note: string;
  readonly profileName: string;
  readonly contextPages: ReadonlyArray<ResearchQueryContextPage>;
  readonly theses: ReadonlyArray<ThoughtThesisRef>;
};

export type ThoughtThesisUpdate = {
  readonly thesisSlug: string;
  // Single-paragraph addendum the user can paste into directives/theses/<slug>.md.
  // CoS NEVER writes to authored thesis files directly — this is a suggestion
  // surfaced in the thought report for the user to confirm in Obsidian.
  readonly addendumMd: string;
  readonly rationale: string;
};

export type ThoughtAnalysis = {
  readonly intent: string;
  readonly questions: ReadonlyArray<string>;
  // Stems of existing wiki/source pages from contextPages that bear on the thought.
  readonly relevantPageStems: ReadonlyArray<string>;
  readonly thesisUpdates: ReadonlyArray<ThoughtThesisUpdate>;
};

export type ThoughtAnalysisResponse = {
  readonly analysis: ThoughtAnalysis;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly model: string;
};

export type FreshnessProbe = {
  readonly query: string;
  readonly watchlist_entity: string;
  readonly rationale: string;
  readonly confidence: "high" | "medium" | "low";
};

export type GenerateProbesRequest = {
  readonly directiveMd: string;
  readonly candidatesSummary: ReadonlyArray<{ title: string; slug: string }>;
  readonly period: { start: string; end: string };
  readonly watchlistEntities: ReadonlyArray<string>;
};

export type GenerateProbesResponse = {
  readonly probes: ReadonlyArray<FreshnessProbe>;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly model: string;
};

export interface LlmServiceShape {
  readonly name: () => string;
  readonly generateBrief: (req: BriefRequest) => Effect.Effect<BriefResponse, LlmError>;
  readonly proposeSubtopic: (
    req: SubtopicProposeRequest,
  ) => Effect.Effect<SubtopicProposeResponse, LlmError>;
  readonly generateInterestReport: (
    req: InterestReportRequest,
  ) => Effect.Effect<InterestReportResponse, LlmError>;
  readonly summarizeSource: (
    req: SourceSummaryRequest,
  ) => Effect.Effect<SourceSummaryResponse, LlmError>;
  readonly researchQuery: (
    req: ResearchQueryRequest,
  ) => Effect.Effect<ResearchQueryResponse, LlmError>;
  readonly analyzeThought: (
    req: ThoughtAnalysisRequest,
  ) => Effect.Effect<ThoughtAnalysisResponse, LlmError>;
  readonly generateProbes: (
    req: GenerateProbesRequest,
  ) => Effect.Effect<GenerateProbesResponse, LlmError>;
}

export class LlmService extends Context.Tag("uebermensch/LlmService")<
  LlmService,
  LlmServiceShape
>() {}
