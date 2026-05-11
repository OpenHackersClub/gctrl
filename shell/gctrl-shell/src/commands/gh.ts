/**
 * gctrl gh — GitHub integration via kernel driver-github.
 *
 * All GitHub operations route through the kernel HTTP API (/api/github/*),
 * which delegates to driver-github (a kernel LKM using native gh CLI).
 * The shell has no direct knowledge of the GitHub API or gh CLI.
 *
 * Common pitfalls:
 * - @effect/cli requires options to precede positional args.
 *   Use `gctrl gh prs view --repo owner/repo 13`, not
 *   `gctrl gh prs view 13 --repo owner/repo`.
 * - `--repo` (or `-r`) is required on every typed subcommand — none of
 *   them infer the repo from the current working directory.
 * - The typed subcommands wrap a curated subset of `gh`. Flags such as
 *   `--json`, `--web`, and other gh-only options are NOT exposed here.
 *   For full gh CLI access (including `gh api`, `gh pr merge`, JSON output,
 *   etc.) use the passthrough: `gctrl gh exec -- <gh args>`.
 */
import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"
import { makeExecCommand } from "./cli-exec"

// --- Schemas for kernel GitHub API responses ---

export const GhIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Schema.String),
  createdAt: Schema.String,
  url: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
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

const GhIssueList = Schema.Array(GhIssue)
const GhPRList = Schema.Array(GhPR)
const GhRunList = Schema.Array(GhRun)

const repo = Options.text("repo").pipe(
  Options.withAlias("r"),
  Options.withDescription("GitHub repo (owner/repo)")
)
const limit = Options.integer("limit").pipe(Options.withDefault(10))

// --- issues ---

const issuesListCommand = Command.make(
  "list",
  { repo, limit },
  ({ repo, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const issues = yield* kernel.get(
        `/api/github/issues?repo=${encodeURIComponent(repo)}&limit=${limit}`,
        GhIssueList
      )

      if (issues.length === 0) {
        yield* Console.log("No issues found.")
        return
      }

      yield* Console.log(`${"#".padEnd(6)} ${"Title".padEnd(50)} ${"State".padEnd(8)} Author`)
      yield* Console.log("-".repeat(80))
      for (const issue of issues) {
        yield* Console.log(
          `${String(issue.number).padEnd(6)} ${issue.title.slice(0, 48).padEnd(50)} ${issue.state.padEnd(8)} ${issue.author}`
        )
      }
    })
).pipe(
  Command.withDescription(
    "List GitHub issues for a repo.\nExample: gctrl gh issues list --repo OpenHackersClub/gctrl --limit 20"
  )
)

const issueNumber = Args.integer({ name: "number" })

const issuesViewCommand = Command.make(
  "view",
  { repo, number: issueNumber },
  ({ repo, number }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const issue = yield* kernel.get(
        `/api/github/issues/${number}?repo=${encodeURIComponent(repo)}`,
        GhIssue
      )

      yield* Console.log(`#${issue.number} ${issue.title}`)
      yield* Console.log(`State:   ${issue.state}`)
      yield* Console.log(`Author:  ${issue.author}`)
      yield* Console.log(`Labels:  ${issue.labels.join(", ") || "(none)"}`)
      yield* Console.log(`Created: ${issue.createdAt}`)
      yield* Console.log(`URL:     ${issue.url}`)
    })
).pipe(
  Command.withDescription(
    "View a GitHub issue by number.\nExample: gctrl gh issues view --repo OpenHackersClub/gctrl 42\nFor flags this typed command does not expose (e.g. --json, --web), use:\n  gctrl gh exec -- issue view 42 --repo OpenHackersClub/gctrl --json title,body"
  )
)

const issueTitle = Options.text("title").pipe(
  Options.withDescription("Issue title")
)
const issueBody = Options.text("body").pipe(
  Options.optional,
  Options.withDescription("Issue body")
)
const issueLabels = Options.text("label").pipe(
  Options.repeated,
  Options.withDescription("Label (repeatable)")
)

const issuesCreateCommand = Command.make(
  "create",
  { repo, title: issueTitle, body: issueBody, labels: issueLabels },
  ({ repo, title, body, labels }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const issue = yield* kernel.post(
        `/api/github/issues?repo=${encodeURIComponent(repo)}`,
        {
          title,
          body: Option.getOrUndefined(body),
          labels: labels.length > 0 ? [...labels] : undefined,
        },
        GhIssue
      )
      yield* Console.log(`Created issue #${issue.number}: ${issue.title}`)
      yield* Console.log(`URL: ${issue.url}`)
    })
).pipe(
  Command.withDescription(
    "Create a GitHub issue.\nExample: gctrl gh issues create --repo OpenHackersClub/gctrl --title \"Bug: ...\" --body \"...\" --label bug"
  )
)

const issuesCommand = Command.make("issues").pipe(
  Command.withSubcommands([issuesListCommand, issuesViewCommand, issuesCreateCommand]),
  Command.withDescription(
    "GitHub issues — list, view, create. Subcommands: list, view, create.\nRequired on every subcommand: --repo <owner>/<name> (no auto-detect from cwd).\nOptions must precede positional args: `gctrl gh issues view --repo owner/repo 42`, NOT `... 42 --repo owner/repo`."
  )
)

// --- prs ---

const prsListCommand = Command.make(
  "list",
  { repo, limit },
  ({ repo, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const prs = yield* kernel.get(
        `/api/github/prs?repo=${encodeURIComponent(repo)}&limit=${limit}`,
        GhPRList
      )

      if (prs.length === 0) {
        yield* Console.log("No pull requests found.")
        return
      }

      yield* Console.log(`${"#".padEnd(6)} ${"Title".padEnd(50)} ${"State".padEnd(8)} Branch`)
      yield* Console.log("-".repeat(80))
      for (const pr of prs) {
        yield* Console.log(
          `${String(pr.number).padEnd(6)} ${pr.title.slice(0, 48).padEnd(50)} ${pr.state.padEnd(8)} ${pr.branch}`
        )
      }
    })
).pipe(
  Command.withDescription(
    "List GitHub pull requests for a repo.\nExample: gctrl gh prs list --repo OpenHackersClub/gctrl --limit 20"
  )
)

const prNumber = Args.integer({ name: "number" })

const prsViewCommand = Command.make(
  "view",
  { repo, number: prNumber },
  ({ repo, number }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const pr = yield* kernel.get(
        `/api/github/prs/${number}?repo=${encodeURIComponent(repo)}`,
        GhPR
      )

      yield* Console.log(`#${pr.number} ${pr.title}`)
      yield* Console.log(`State:  ${pr.state}`)
      yield* Console.log(`Author: ${pr.author}`)
      yield* Console.log(`Branch: ${pr.branch}`)
      yield* Console.log(`URL:    ${pr.url}`)
    })
).pipe(
  Command.withDescription(
    "View a pull request by number.\nExample: gctrl gh prs view --repo OpenHackersClub/gctrl 13\nFor flags this typed command does not expose (e.g. --json, --web), use:\n  gctrl gh exec -- pr view 13 --repo OpenHackersClub/gctrl --json title,body,isDraft"
  )
)

const prsCommand = Command.make("prs").pipe(
  Command.withSubcommands([prsListCommand, prsViewCommand]),
  Command.withDescription(
    "GitHub pull requests — list, view. Subcommands: list, view.\nRequired on every subcommand: --repo <owner>/<name> (no auto-detect from cwd).\nOptions must precede positional args: `gctrl gh prs view --repo owner/repo 32`, NOT `... 32 --repo owner/repo`.\nFor cwd-based repo detection or unsupported flags, use the passthrough: `gctrl gh exec -- pr view 32`."
  )
)

// --- runs ---

const branch = Options.text("branch").pipe(
  Options.withAlias("b"),
  Options.optional,
  Options.withDescription("Filter by branch")
)

const runsListCommand = Command.make(
  "list",
  { repo, limit, branch },
  ({ repo, limit, branch }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const branchParam = Option.getOrUndefined(branch)
      let path = `/api/github/runs?repo=${encodeURIComponent(repo)}&limit=${limit}`
      if (branchParam) path += `&branch=${encodeURIComponent(branchParam)}`
      const runs = yield* kernel.get(path, GhRunList)

      if (runs.length === 0) {
        yield* Console.log("No workflow runs found.")
        return
      }

      yield* Console.log(`${"ID".padEnd(12)} ${"Name".padEnd(30)} ${"Status".padEnd(12)} Conclusion`)
      yield* Console.log("-".repeat(70))
      for (const run of runs) {
        yield* Console.log(
          `${String(run.id).padEnd(12)} ${run.name.slice(0, 28).padEnd(30)} ${run.status.padEnd(12)} ${run.conclusion ?? "-"}`
        )
      }
    })
).pipe(
  Command.withDescription(
    "List GitHub Actions workflow runs.\nExample: gctrl gh runs list --repo OpenHackersClub/gctrl --branch main --limit 20"
  )
)

const runId = Args.integer({ name: "run-id" })

const runsViewCommand = Command.make(
  "view",
  { repo, runId },
  ({ repo, runId }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const run = yield* kernel.get(
        `/api/github/runs/${runId}?repo=${encodeURIComponent(repo)}`,
        GhRun
      )

      yield* Console.log(`Run #${run.id}: ${run.name}`)
      yield* Console.log(`Status:     ${run.status}`)
      yield* Console.log(`Conclusion: ${run.conclusion ?? "-"}`)
      yield* Console.log(`Branch:     ${run.branch}`)
      yield* Console.log(`URL:        ${run.url}`)
    })
).pipe(
  Command.withDescription(
    "View a GitHub Actions workflow run by id.\nExample: gctrl gh runs view --repo OpenHackersClub/gctrl 22549748112\nFor flags this typed command does not expose (e.g. --log, --web), use:\n  gctrl gh exec -- run view 22549748112 --repo OpenHackersClub/gctrl --log"
  )
)

const runsCommand = Command.make("runs").pipe(
  Command.withSubcommands([runsListCommand, runsViewCommand]),
  Command.withDescription(
    "GitHub Actions runs — list, view. Subcommands: list, view.\nRequired on every subcommand: --repo <owner>/<name> (no auto-detect from cwd).\nOptions must precede positional args: `gctrl gh runs view --repo owner/repo 22549748112`, NOT `... 22549748112 --repo owner/repo`."
  )
)

// --- exec (passthrough) ---

const execCommand = makeExecCommand("/api/github/exec")
const execCommandWithDesc = execCommand.pipe(
  Command.withDescription(
    "Passthrough to native gh CLI via kernel (auth handled by driver-github). Example: gctrl gh exec -- pr view 13 --repo OpenHackersClub/gctrl --json title,body"
  )
)

// --- gh (parent) ---

export const ghCommand = Command.make("gh").pipe(
  Command.withSubcommands([issuesCommand, prsCommand, runsCommand, execCommandWithDesc]),
  Command.withDescription(
    "GitHub operations via kernel driver-github.\nTyped subcommands: issues, prs, runs. Passthrough: exec.\n\nGotchas for typed subcommands (issues/prs/runs):\n  1. --repo <owner>/<name> is REQUIRED — no auto-detect from cwd.\n  2. Options must precede positional args (e.g. `gctrl gh prs view --repo owner/repo 32`, NOT `... 32 --repo owner/repo`).\nIf you need cwd-based repo detection or flags not exposed here (--json, --web, gh api, gh pr merge), use `gctrl gh exec -- <gh args>`."
  )
)
