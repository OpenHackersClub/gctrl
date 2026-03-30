/**
 * CcliGitHubClient — concrete adapter that wraps `ccli gh` commands.
 *
 * Shells out to ccli for GitHub operations. All external tool access
 * goes through ccli so traffic is tracked and cached.
 */
import { Effect, Layer } from "effect"
import { GitHubClient } from "../services/GitHubClient.js"
import type { GhIssue, GhPR, GhRun } from "../services/GitHubClient.js"
import { GitHubError } from "../errors.js"

const exec = (args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["ccli", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const code = await proc.exited
      if (code !== 0) {
        throw new Error(stderr || `ccli exited with code ${code}`)
      }
      return stdout.trim()
    },
    catch: (e) => new GitHubError({ message: String(e) }),
  })

/**
 * Parse ccli gh issue list output into typed GhIssue objects.
 * ccli outputs tab-separated: number, title, state, labels, author, created_at, url
 */
const parseIssues = (stdout: string): ReadonlyArray<GhIssue> => {
  if (!stdout) return []
  return stdout.split("\n").map((line) => {
    const parts = line.split("\t")
    return {
      number: parseInt(parts[0] ?? "0", 10),
      title: parts[1] ?? "",
      state: parts[2] ?? "open",
      author: parts[4] ?? "",
      labels: (parts[3] ?? "").split(",").filter(Boolean),
      createdAt: parts[5] ?? "",
      url: parts[6] ?? "",
    }
  })
}

const parsePRs = (stdout: string): ReadonlyArray<GhPR> => {
  if (!stdout) return []
  return stdout.split("\n").map((line) => {
    const parts = line.split("\t")
    return {
      number: parseInt(parts[0] ?? "0", 10),
      title: parts[1] ?? "",
      state: parts[2] ?? "open",
      author: parts[3] ?? "",
      branch: parts[4] ?? "",
      url: parts[5] ?? "",
    }
  })
}

const parseRuns = (stdout: string): ReadonlyArray<GhRun> => {
  if (!stdout) return []
  return stdout.split("\n").map((line) => {
    const parts = line.split("\t")
    return {
      id: parseInt(parts[0] ?? "0", 10),
      name: parts[1] ?? "",
      status: parts[2] ?? "",
      conclusion: parts[3] || null,
      branch: parts[4] ?? "",
      url: parts[5] ?? "",
    }
  })
}

export const CcliGitHubClientLive = Layer.succeed(GitHubClient, {
  listIssues: (repo, options) =>
    Effect.gen(function* () {
      const args = ["gh", "issue", "list", "--repo", repo]
      if (options?.state) args.push("--state", options.state)
      if (options?.label) args.push("--label", options.label)
      if (options?.limit) args.push("--limit", String(options.limit))
      const stdout = yield* exec(args)
      return parseIssues(stdout)
    }),

  listPRs: (repo, options) =>
    Effect.gen(function* () {
      const args = ["gh", "pr", "list", "--repo", repo]
      if (options?.limit) args.push("--limit", String(options.limit))
      const stdout = yield* exec(args)
      return parsePRs(stdout)
    }),

  listRuns: (repo, options) =>
    Effect.gen(function* () {
      const args = ["gh", "run", "list", "--repo", repo]
      if (options?.branch) args.push("--branch", options.branch)
      if (options?.limit) args.push("--limit", String(options.limit))
      const stdout = yield* exec(args)
      return parseRuns(stdout)
    }),
})
