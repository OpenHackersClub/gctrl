/**
 * GitHubClient — port interface for GitHub operations.
 *
 * Wraps `ccli gh` as a subprocess adapter. The shell communicates with
 * external tools via ccli — never from the kernel.
 */
import { Context, Effect, Schema } from "effect"
import type { GitHubError } from "../errors.js"

export const GhIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Schema.String),
  createdAt: Schema.String,
  url: Schema.String,
})
export type GhIssue = typeof GhIssue.Type

export const GhPR = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  branch: Schema.String,
  url: Schema.String,
})
export type GhPR = typeof GhPR.Type

export const GhRun = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  branch: Schema.String,
  url: Schema.String,
})
export type GhRun = typeof GhRun.Type

export class GitHubClient extends Context.Tag("GitHubClient")<
  GitHubClient,
  {
    readonly listIssues: (
      repo: string,
      options?: { state?: string; label?: string; limit?: number }
    ) => Effect.Effect<ReadonlyArray<GhIssue>, GitHubError>

    readonly listPRs: (
      repo: string,
      options?: { limit?: number }
    ) => Effect.Effect<ReadonlyArray<GhPR>, GitHubError>

    readonly listRuns: (
      repo: string,
      options?: { branch?: string; limit?: number }
    ) => Effect.Effect<ReadonlyArray<GhRun>, GitHubError>
  }
>() {}
