import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"
import { GhIssue } from "./gh"

// --- schemas ---

const BoardProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  counter: Schema.Number,
  github_repo: Schema.optional(Schema.String),
})
const BoardProjectList = Schema.Array(BoardProject)

const BoardIssue = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.String,
  priority: Schema.String,
  assignee_id: Schema.optional(Schema.String),
  assignee_name: Schema.optional(Schema.String),
  labels: Schema.Array(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  created_by_id: Schema.optional(Schema.String),
  created_by_name: Schema.optional(Schema.String),
  created_by_type: Schema.optional(Schema.String),
  github_issue_number: Schema.optional(Schema.Number),
  github_url: Schema.optional(Schema.String),
})
const BoardIssueList = Schema.Array(BoardIssue)

const BoardComment = Schema.Struct({
  id: Schema.String,
  issue_id: Schema.String,
  author_id: Schema.String,
  author_name: Schema.String,
  author_type: Schema.String,
  body: Schema.String,
  created_at: Schema.String,
})
const BoardCommentList = Schema.Array(BoardComment)

const BoardEvent = Schema.Struct({
  id: Schema.String,
  issue_id: Schema.String,
  event_type: Schema.String,
  actor_name: Schema.String,
  actor_type: Schema.String,
  timestamp: Schema.String,
})
const BoardEventList = Schema.Array(BoardEvent)

const VoidResponse = Schema.Struct({})

const ImportResult = Schema.Struct({
  imported: Schema.Number,
  skipped: Schema.Number,
  total: Schema.Number,
})

const ExportResult = Schema.Struct({
  exported: Schema.Number,
  files: Schema.Array(Schema.String),
})

// --- shared options ---

const issueId = Args.text({ name: "id" })

// --- project subcommands ---

const listProjectsCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const projects = yield* kernel.get("/api/board/projects", BoardProjectList)

    if (projects.length === 0) {
      yield* Console.log("No projects found.")
      return
    }

    yield* Console.log(`${"Key".padEnd(10)} ${"Name".padEnd(30)} Issues`)
    yield* Console.log("-".repeat(50))
    for (const p of projects) {
      yield* Console.log(`${p.key.padEnd(10)} ${p.name.padEnd(30)} ${p.counter}`)
    }
  })
)

const projectName = Options.text("name").pipe(Options.withDescription("Project name"))
const projectKey = Options.text("key").pipe(Options.withDescription("Project key (e.g. PROJ)"))

const createProjectCommand = Command.make(
  "create",
  { name: projectName, key: projectKey },
  ({ name, key }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const project = yield* kernel.post(
        "/api/board/projects",
        { name, key },
        BoardProject
      )
      yield* Console.log(`Project created: ${project.key} — ${project.name}`)
    })
)

const projectsCommand = Command.make("projects").pipe(
  Command.withSubcommands([listProjectsCommand, createProjectCommand])
)

// --- issue subcommands ---

const projectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Filter by project ID")
)
const statusFilter = Options.text("status").pipe(
  Options.optional,
  Options.withDescription("Filter by status")
)
const assigneeFilter = Options.text("assignee").pipe(
  Options.optional,
  Options.withDescription("Filter by assignee ID")
)
const labelFilter = Options.text("label").pipe(
  Options.optional,
  Options.withDescription("Filter by label")
)
const limit = Options.integer("limit").pipe(Options.withDefault(50))

const listIssuesCommand = Command.make(
  "list",
  { project: projectId, status: statusFilter, assignee: assigneeFilter, label: labelFilter, limit },
  ({ project, status, assignee, label, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("limit", String(limit))
      if (Option.isSome(project)) params.set("project_id", project.value)
      if (Option.isSome(status)) params.set("status", status.value)
      if (Option.isSome(assignee)) params.set("assignee_id", assignee.value)
      if (Option.isSome(label)) params.set("label", label.value)

      const issues = yield* kernel.get(`/api/board/issues?${params.toString()}`, BoardIssueList)

      if (issues.length === 0) {
        yield* Console.log("No issues found.")
        return
      }

      yield* Console.log(`${"ID".padEnd(10)} ${"Status".padEnd(14)} ${"Priority".padEnd(10)} Title`)
      yield* Console.log("-".repeat(70))
      for (const i of issues) {
        yield* Console.log(
          `${i.id.slice(0, 8).padEnd(10)} ${i.status.padEnd(14)} ${i.priority.padEnd(10)} ${i.title.slice(0, 40)}`
        )
      }
    })
)

const issueTitle = Options.text("title").pipe(Options.withDescription("Issue title"))
const issueProject = Options.text("project").pipe(Options.withDescription("Project ID"))
const issueDesc = Options.text("description").pipe(
  Options.optional,
  Options.withDescription("Issue description")
)
const issuePriority = Options.text("priority").pipe(
  Options.withDefault("none"),
  Options.withDescription("Priority (none, low, medium, high, urgent)")
)

const createIssueCommand = Command.make(
  "create",
  { project: issueProject, title: issueTitle, description: issueDesc, priority: issuePriority },
  ({ project, title, description, priority }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const body: Record<string, unknown> = {
        project_id: project,
        title,
        priority,
        created_by_id: "shell",
        created_by_name: "gctrl-shell",
        created_by_type: "human",
      }
      if (Option.isSome(description)) body.description = description.value

      const issue = yield* kernel.post("/api/board/issues", body, BoardIssue)
      yield* Console.log(`Issue created: ${issue.id} — ${issue.title}`)
    })
)

const viewIssueCommand = Command.make(
  "view",
  { id: issueId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const i = yield* kernel.get(`/api/board/issues/${id}`, BoardIssue)

      yield* Console.log(`${i.id}: ${i.title}`)
      yield* Console.log("-".repeat(60))
      yield* Console.log(`Status:   ${i.status}`)
      yield* Console.log(`Priority: ${i.priority}`)
      yield* Console.log(`Assignee: ${i.assignee_name ?? "(unassigned)"}`)
      yield* Console.log(`Labels:   ${i.labels.join(", ") || "(none)"}`)
      if (i.description) yield* Console.log(`\n${i.description}`)
      yield* Console.log(`\nCreated: ${i.created_at}`)
      yield* Console.log(`Updated: ${i.updated_at}`)
    })
)

const moveStatus = Options.text("status").pipe(
  Options.withDescription("New status (backlog, todo, in_progress, in_review, done)")
)

const moveIssueCommand = Command.make(
  "move",
  { id: issueId, status: moveStatus },
  ({ id, status }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const issue = yield* kernel.post(
        `/api/board/issues/${id}/move`,
        { status, actor_id: "shell", actor_name: "gctrl-shell", actor_type: "human" },
        BoardIssue
      )
      yield* Console.log(`Issue ${issue.id} moved to ${issue.status}`)
    })
)

const assigneeId = Options.text("assignee-id").pipe(Options.withDescription("Assignee ID"))
const assigneeName = Options.text("assignee-name").pipe(Options.withDescription("Assignee name"))

const assignIssueCommand = Command.make(
  "assign",
  { id: issueId, assigneeId, assigneeName },
  ({ id, assigneeId, assigneeName }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const issue = yield* kernel.post(
        `/api/board/issues/${id}/assign`,
        { assignee_id: assigneeId, assignee_name: assigneeName, assignee_type: "human" },
        BoardIssue
      )
      yield* Console.log(`Issue ${issue.id} assigned to ${issue.assignee_name}`)
    })
)

const commentBody = Options.text("body").pipe(Options.withDescription("Comment text"))

const commentIssueCommand = Command.make(
  "comment",
  { id: issueId, body: commentBody },
  ({ id, body }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const comment = yield* kernel.post(
        `/api/board/issues/${id}/comment`,
        { author_id: "shell", author_name: "gctrl-shell", author_type: "human", body },
        BoardComment
      )
      yield* Console.log(`Comment added: ${comment.id}`)
    })
)

const eventsCommand = Command.make(
  "events",
  { id: issueId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const events = yield* kernel.get(`/api/board/issues/${id}/events`, BoardEventList)

      if (events.length === 0) {
        yield* Console.log("No events.")
        return
      }

      yield* Console.log(`${"Timestamp".padEnd(22)} ${"Type".padEnd(18)} Actor`)
      yield* Console.log("-".repeat(55))
      for (const e of events) {
        yield* Console.log(`${e.timestamp.padEnd(22)} ${e.event_type.padEnd(18)} ${e.actor_name}`)
      }
    })
)

const commentsListCommand = Command.make(
  "comments",
  { id: issueId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const comments = yield* kernel.get(`/api/board/issues/${id}/comments`, BoardCommentList)

      if (comments.length === 0) {
        yield* Console.log("No comments.")
        return
      }

      for (const c of comments) {
        yield* Console.log(`--- ${c.author_name} (${c.created_at}) ---`)
        yield* Console.log(c.body)
        yield* Console.log("")
      }
    })
)

const sessionId = Options.text("session").pipe(Options.withDescription("Session ID to link"))

const linkSessionCommand = Command.make(
  "link",
  { id: issueId, session: sessionId },
  ({ id, session }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.post(
        `/api/board/issues/${id}/link-session`,
        { session_id: session },
        VoidResponse
      )
      yield* Console.log(`Session ${session} linked to issue ${id}`)
    })
)

const issuesParent = Command.make("issues").pipe(
  Command.withSubcommands([
    listIssuesCommand,
    createIssueCommand,
    viewIssueCommand,
    moveIssueCommand,
    assignIssueCommand,
    commentIssueCommand,
    eventsCommand,
    commentsListCommand,
    linkSessionCommand,
  ])
)

// --- import / export ---

const importPath = Args.text({ name: "path" }).pipe(
  Args.withDescription("Directory containing .md issue files")
)

const importCommand = Command.make(
  "import",
  { path: importPath },
  ({ path }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        "/api/board/import",
        { path },
        ImportResult
      )
      yield* Console.log(
        `Imported ${result.imported}, skipped ${result.skipped} (${result.total} total)`
      )
    })
)

const exportPath = Args.text({ name: "path" }).pipe(
  Args.withDescription("Directory to write .md issue files")
)
const exportProjectId = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Export only issues from this project ID")
)

const exportCommand = Command.make(
  "export",
  { path: exportPath, projectId: exportProjectId },
  ({ path, projectId }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const body: Record<string, unknown> = { path }
      if (Option.isSome(projectId)) {
        body.project_id = projectId.value
      }
      const result = yield* kernel.post(
        "/api/board/export",
        body,
        ExportResult
      )
      yield* Console.log(`Exported ${result.exported} issues:`)
      for (const f of result.files) {
        yield* Console.log(`  ${f}`)
      }
    })
)

// --- link-github ---

const linkGhRepo = Options.text("repo").pipe(
  Options.withDescription("GitHub repo (owner/repo)")
)
const linkGhProjectId = Args.text({ name: "project-id" }).pipe(
  Args.withDescription("Board project ID")
)

const linkGithubCommand = Command.make(
  "link-github",
  { projectId: linkGhProjectId, repo: linkGhRepo },
  ({ projectId, repo }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const project = yield* kernel.post(
        `/api/board/projects/${projectId}/github`,
        { github_repo: repo },
        BoardProject
      )
      yield* Console.log(`Linked project ${project.key} → ${repo}`)
    })
)

// --- sync helpers ---

const GhIssueList = Schema.Array(GhIssue)

/** Resolve a project by key and verify it has a linked GitHub repo. */
const resolveLinkedProject = (projectKey: string) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const projects = yield* kernel.get("/api/board/projects", BoardProjectList)
    const proj = projects.find((p) => p.key === projectKey)
    if (!proj) return yield* Effect.fail({ _tag: "NotFound" as const, message: `Project "${projectKey}" not found.` })
    if (!proj.github_repo) return yield* Effect.fail({ _tag: "NotLinked" as const, message: `Project "${projectKey}" has no linked GitHub repo. Use: gctrl board link-github <project-id> --repo owner/repo` })
    return { ...proj, github_repo: proj.github_repo }
  })

const syncProject = Options.text("project").pipe(
  Options.withDescription("Project key (e.g. GCTL)")
)

// --- sync subcommands ---

const syncPullCommand = Command.make(
  "pull",
  { project: syncProject },
  ({ project }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const proj = yield* resolveLinkedProject(project)

      const [ghIssues, boardIssues] = yield* Effect.all([
        kernel.get(`/api/github/issues?repo=${encodeURIComponent(proj.github_repo)}&limit=100`, GhIssueList),
        kernel.get(`/api/board/issues?project_id=${proj.id}`, BoardIssueList),
      ])

      const existingGhNumbers = new Set(
        boardIssues
          .filter((i) => i.github_issue_number !== undefined)
          .map((i) => i.github_issue_number)
      )
      const newFromGh = ghIssues.filter((gi) => !existingGhNumbers.has(gi.number))

      yield* Effect.forEach(newFromGh, (gi) =>
        Effect.gen(function* () {
          yield* kernel.post("/api/board/issues", {
            project_id: proj.id,
            title: gi.title,
            description: gi.body ?? undefined,
            labels: gi.labels,
            github_issue_number: gi.number,
            github_url: gi.url,
            created_by_id: gi.author,
            created_by_name: gi.author,
            created_by_type: "human",
          }, BoardIssue)
          yield* Console.log(`  ← #${gi.number} ${gi.title}`)
        }), { concurrency: 1 })

      yield* Console.log(`Sync pull: ${newFromGh.length} new issue(s) from ${proj.github_repo}`)
    }).pipe(
      Effect.catchTag("NotFound", (e) => Console.log(e.message)),
      Effect.catchTag("NotLinked", (e) => Console.log(e.message)),
    )
)

const syncPushCommand = Command.make(
  "push",
  { project: syncProject },
  ({ project }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const proj = yield* resolveLinkedProject(project)

      const boardIssues = yield* kernel.get(`/api/board/issues?project_id=${proj.id}`, BoardIssueList)
      const unsynced = boardIssues.filter(
        (i) => i.github_issue_number === undefined || i.github_issue_number === null
      )

      yield* Effect.forEach(unsynced, (bi) =>
        Effect.gen(function* () {
          const created = yield* kernel.post(
            `/api/github/issues?repo=${encodeURIComponent(proj.github_repo)}`,
            { title: bi.title, body: bi.description, labels: bi.labels },
            GhIssue
          )
          yield* Console.log(`  → #${created.number} ${bi.title}`)
        }), { concurrency: 1 })

      yield* Console.log(`Sync push: ${unsynced.length} issue(s) to ${proj.github_repo}`)
    }).pipe(
      Effect.catchTag("NotFound", (e) => Console.log(e.message)),
      Effect.catchTag("NotLinked", (e) => Console.log(e.message)),
    )
)

const syncStatusCommand = Command.make(
  "status",
  { project: syncProject },
  ({ project }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const projects = yield* kernel.get("/api/board/projects", BoardProjectList)
      const proj = projects.find((p) => p.key === project)
      if (!proj) {
        yield* Console.log(`Project "${project}" not found.`)
        return
      }

      yield* Console.log(`Project: ${proj.key} — ${proj.name}`)
      yield* Console.log(`GitHub:  ${proj.github_repo ?? "(not linked)"}`)

      if (proj.github_repo) {
        const boardIssues = yield* kernel.get(`/api/board/issues?project_id=${proj.id}`, BoardIssueList)
        const synced = boardIssues.filter((i) => i.github_issue_number !== undefined)
        const unsynced = boardIssues.filter((i) => i.github_issue_number === undefined || i.github_issue_number === null)
        yield* Console.log(`Synced:   ${synced.length} issues`)
        yield* Console.log(`Unsynced: ${unsynced.length} board-only issues`)
      }
    })
)

const syncCommand = Command.make("sync").pipe(
  Command.withSubcommands([syncPullCommand, syncPushCommand, syncStatusCommand])
)

// --- board (parent) ---

export const boardCommand = Command.make("board").pipe(
  Command.withSubcommands([projectsCommand, issuesParent, importCommand, exportCommand, linkGithubCommand, syncCommand])
)
