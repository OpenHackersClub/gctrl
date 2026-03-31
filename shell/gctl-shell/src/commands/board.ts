import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Schema } from "effect"
import { KernelClient } from "../services/KernelClient.js"

// --- schemas ---

const BoardProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  counter: Schema.Number,
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
      if (project._tag === "Some") params.set("project_id", project.value)
      if (status._tag === "Some") params.set("status", status.value)
      if (assignee._tag === "Some") params.set("assignee_id", assignee.value)
      if (label._tag === "Some") params.set("label", label.value)

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
        created_by_name: "gctl-shell",
        created_by_type: "human",
      }
      if (description._tag === "Some") body.description = description.value

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
        { status, actor_id: "shell", actor_name: "gctl-shell", actor_type: "human" },
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
        { author_id: "shell", author_name: "gctl-shell", author_type: "human", body },
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

// --- board (parent) ---

export const boardCommand = Command.make("board").pipe(
  Command.withSubcommands([projectsCommand, issuesParent])
)
