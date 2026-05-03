import { Context, type Effect } from "effect"
import type { VaultError } from "../errors.js"

export type PromptStatus = "pending" | "processed" | "failed" | "rerun"

export type PromptKind = "thought" | "query"

export type Prompt = {
  readonly slug: string
  readonly title: string
  readonly topics: ReadonlyArray<string>
  readonly kind: PromptKind
  readonly status: PromptStatus
  readonly body: string
  readonly relPath: string
  readonly absPath: string
  readonly output: string | null
  readonly processedAt: string | null
  readonly contentHash: string | null
  readonly promptHash: string | null
  readonly model: string | null
}

export type PromptStamp = {
  readonly status: "processed" | "failed"
  readonly output?: string
  readonly processedAt: string
  readonly contentHash?: string
  readonly promptHash?: string
  readonly model?: string
  readonly costUsd?: number
  readonly failedReason?: string
}

export type ArchivedPrompt = {
  readonly slug: string
  readonly fromRelPath: string
  readonly toRelPath: string
}

export interface QueryServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<Prompt>, VaultError>
  readonly get: (slug: string) => Effect.Effect<Prompt, VaultError>
  readonly stamp: (slug: string, stamp: PromptStamp) => Effect.Effect<void, VaultError>
  // Move a stamped prompt into directives/prompts/archived/<slug>.md.
  // Idempotent at the rename: if the destination exists already, fail
  // with VaultError(kind: "collision") so we never silently clobber.
  readonly archive: (slug: string) => Effect.Effect<ArchivedPrompt, VaultError>
}

export class QueryService extends Context.Tag("uebermensch/QueryService")<
  QueryService,
  QueryServiceShape
>() {}
