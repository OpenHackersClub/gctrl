/**
 * HttpGitHubClient — concrete adapter that calls GitHub REST API directly.
 *
 * Replaces CcliGitHubClient. Uses fetch to call api.github.com.
 * Reads GITHUB_TOKEN from environment for authenticated requests.
 */
import { Effect, Layer } from "effect"
import { GitHubClient } from "../services/GitHubClient.js"
import type { GhIssue, GhPR, GhRun } from "../services/GitHubClient.js"
import { GitHubError, GitHubAuthError } from "../errors.js"

const BASE_URL = "https://api.github.com"

type GitHubJson = Record<string, unknown>

const getToken = () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

const ghFetch = (path: string, options?: RequestInit) =>
  Effect.gen(function* () {
    const token = getToken()
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${BASE_URL}${path}`, {
          ...options,
          headers: { ...headers, ...options?.headers },
        }),
      catch: (e) => new GitHubError({ message: `GitHub API request failed: ${e}` }),
    })

    if (res.status === 401 || res.status === 403) {
      const text = yield* Effect.promise(() => res.text())
      return yield* Effect.fail(
        new GitHubAuthError({
          message: `GitHub auth failed (${res.status}): ${text}. Set GITHUB_TOKEN env var.`,
        })
      )
    }

    if (!res.ok) {
      const text = yield* Effect.promise(() => res.text())
      return yield* Effect.fail(
        new GitHubError({ message: `GitHub API ${res.status}: ${text}` })
      )
    }

    return yield* Effect.promise(() => res.json() as Promise<unknown>)
  })

const mapIssue = (raw: GitHubJson): GhIssue => ({
  number: raw.number as number,
  title: raw.title as string,
  state: raw.state as string,
  author: ((raw.user as GitHubJson)?.login as string) ?? "",
  labels: ((raw.labels as unknown[]) ?? []).map((l: unknown) =>
    typeof l === "string" ? l : (l as GitHubJson).name as string
  ),
  createdAt: (raw.created_at as string) ?? "",
  url: (raw.html_url as string) ?? "",
})

const mapPR = (raw: GitHubJson): GhPR => ({
  number: raw.number as number,
  title: raw.title as string,
  state: raw.state as string,
  author: ((raw.user as GitHubJson)?.login as string) ?? "",
  branch: ((raw.head as GitHubJson)?.ref as string) ?? "",
  url: (raw.html_url as string) ?? "",
})

const mapRun = (raw: GitHubJson): GhRun => ({
  id: raw.id as number,
  name: (raw.name as string) ?? "",
  status: (raw.status as string) ?? "",
  conclusion: (raw.conclusion as string) ?? null,
  branch: (raw.head_branch as string) ?? "",
  url: (raw.html_url as string) ?? "",
})

export const HttpGitHubClientLive = Layer.succeed(GitHubClient, {
  listIssues: (repo, options) =>
    Effect.gen(function* () {
      const params = new URLSearchParams()
      if (options?.state) params.set("state", options.state)
      if (options?.label) params.set("labels", options.label)
      if (options?.limit) params.set("per_page", String(options.limit))
      params.set("direction", "desc")
      const qs = params.toString()
      const json = yield* ghFetch(`/repos/${repo}/issues?${qs}`)
      // GitHub issues API returns PRs too — filter them out
      const items = json as unknown[]
      const issues = items.filter((i) => !(i as GitHubJson).pull_request)
      return issues.map((i) => mapIssue(i as GitHubJson))
    }),

  viewIssue: (repo, number) =>
    Effect.gen(function* () {
      const json = yield* ghFetch(`/repos/${repo}/issues/${number}`)
      return mapIssue(json as GitHubJson)
    }),

  createIssue: (repo, input) =>
    Effect.gen(function* () {
      const json = yield* ghFetch(`/repos/${repo}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          labels: input.labels,
        }),
      })
      return mapIssue(json as GitHubJson)
    }),

  listPRs: (repo, options) =>
    Effect.gen(function* () {
      const params = new URLSearchParams()
      if (options?.limit) params.set("per_page", String(options.limit))
      params.set("state", "open")
      params.set("direction", "desc")
      const qs = params.toString()
      const json = yield* ghFetch(`/repos/${repo}/pulls?${qs}`)
      return (json as unknown[]).map((p) => mapPR(p as GitHubJson))
    }),

  viewPR: (repo, number) =>
    Effect.gen(function* () {
      const json = yield* ghFetch(`/repos/${repo}/pulls/${number}`)
      return mapPR(json as GitHubJson)
    }),

  listRuns: (repo, options) =>
    Effect.gen(function* () {
      const params = new URLSearchParams()
      if (options?.branch) params.set("branch", options.branch)
      if (options?.limit) params.set("per_page", String(options.limit))
      const qs = params.toString()
      const json = yield* ghFetch(`/repos/${repo}/actions/runs?${qs}`)
      const runs = (json as GitHubJson).workflow_runs as unknown[] ?? []
      return runs.map((r) => mapRun(r as GitHubJson))
    }),

  viewRun: (repo, runId) =>
    Effect.gen(function* () {
      const json = yield* ghFetch(`/repos/${repo}/actions/runs/${runId}`)
      return mapRun(json as GitHubJson)
    }),
})
