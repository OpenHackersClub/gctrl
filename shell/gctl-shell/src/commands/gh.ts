import { Command, Options, Args } from "@effect/cli"
import { Console, Effect } from "effect"
import { GitHubClient } from "../services/GitHubClient.js"

const repo = Options.text("repo").pipe(
  Options.withAlias("r"),
  Options.withDescription("GitHub repo (owner/repo)")
)
const limit = Options.integer("limit").pipe(Options.withDefault(10))

const issuesCommand = Command.make(
  "issues",
  { repo, limit },
  ({ repo, limit }) =>
    Effect.gen(function* () {
      const gh = yield* GitHubClient
      const issues = yield* gh.listIssues(repo, { limit })

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
)

const prsCommand = Command.make(
  "prs",
  { repo, limit },
  ({ repo, limit }) =>
    Effect.gen(function* () {
      const gh = yield* GitHubClient
      const prs = yield* gh.listPRs(repo, { limit })

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
)

const branch = Options.text("branch").pipe(
  Options.withAlias("b"),
  Options.optional,
  Options.withDescription("Filter by branch")
)

const runsCommand = Command.make(
  "runs",
  { repo, limit, branch },
  ({ repo, limit, branch }) =>
    Effect.gen(function* () {
      const gh = yield* GitHubClient
      const runs = yield* gh.listRuns(repo, {
        limit,
        branch: branch._tag === "Some" ? branch.value : undefined,
      })

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
)

export const ghCommand = Command.make("gh").pipe(
  Command.withSubcommands([issuesCommand, prsCommand, runsCommand])
)
