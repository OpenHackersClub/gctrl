import { Context, type Effect } from "effect";
import type { LlmError } from "../errors.js";
import type { CandidateRef } from "../lib/candidates.js";
import type { CuratedItem } from "./RendererService.js";

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

export type ReportInterestInput = {
  readonly slug: string;
  readonly title: string;
  readonly question: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly notes: string;
  readonly candidates: ReadonlyArray<CandidateRef>;
};

export type InterestReportRequest = {
  readonly periodLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly profileName: string;
  readonly interest: ReportInterestInput;
  readonly maxItems: number;
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
  readonly insightsMd: string;
  readonly promptHash: string;
  readonly costUsd: number;
  readonly model: string;
};

export interface LlmServiceShape {
  readonly name: () => string;
  readonly generateBrief: (req: BriefRequest) => Effect.Effect<BriefResponse, LlmError>;
  readonly generateInterestReport: (
    req: InterestReportRequest,
  ) => Effect.Effect<InterestReportResponse, LlmError>;
  readonly summarizeSource: (
    req: SourceSummaryRequest,
  ) => Effect.Effect<SourceSummaryResponse, LlmError>;
}

export class LlmService extends Context.Tag("uebermensch/LlmService")<
  LlmService,
  LlmServiceShape
>() {}
