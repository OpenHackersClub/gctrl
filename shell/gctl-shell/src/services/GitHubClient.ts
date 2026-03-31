/**
 * GitHubClient — port interface for GitHub operations.
 *
 * Calls GitHub REST API directly via HTTP. No ccli dependency.
 */
import { Context, type Effect, Schema } from "effect"
import type { GitHubError, GitHubAuthError } from "../errors.js"

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
    ) => Effect.Effect<ReadonlyArray<GhIssue>, GitHubError | GitHubAuthError>

    readonly viewIssue: (
      repo: string,
      number: number
    ) => Effect.Effect<GhIssue, GitHubError | GitHubAuthError>

    readonly createIssue: (
      repo: string,
      input: { title: string; body?: string; labels?: string[] }
    ) => Effect.Effect<GhIssue, GitHubError | GitHubAuthError>

    readonly listPRs: (
      repo: string,
      options?: { limit?: number }
    ) => Effect.Effect<ReadonlyArray<GhPR>, GitHubError | GitHubAuthError>

    readonly viewPR: (
      repo: string,
      number: number
    ) => Effect.Effect<GhPR, GitHubError | GitHubAuthError>

    readonly listRuns: (
      repo: string,
      options?: { branch?: string; limit?: number }
    ) => Effect.Effect<ReadonlyArray<GhRun>, GitHubError | GitHubAuthError>

    readonly viewRun: (
      repo: string,
      runId: number
    ) => Effect.Effect<GhRun, GitHubError | GitHubAuthError>
  }
>() {}
