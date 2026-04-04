import { Command, Options, Args } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

// --- schemas ---

const InboxMessage = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  source: Schema.String,
  kind: Schema.String,
  urgency: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  requires_action: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
})
const InboxMessageList = Schema.Array(InboxMessage)

const InboxThreadWithMessages = Schema.Struct({
  id: Schema.String,
  context_type: Schema.String,
  context_ref: Schema.String,
  title: Schema.String,
  project_key: Schema.optional(Schema.NullOr(Schema.String)),
  pending_count: Schema.Number,
  latest_urgency: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  messages: Schema.Array(InboxMessage),
})

const InboxAction = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  thread_id: Schema.String,
  actor_id: Schema.String,
  actor_name: Schema.String,
  action_type: Schema.String,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
})
const InboxActionList = Schema.Array(InboxAction)

const InboxStats = Schema.Struct({
  total: Schema.Number,
  pending: Schema.Number,
  by_urgency: Schema.Unknown,
  by_kind: Schema.Unknown,
})

const ActionResponse = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  action_type: Schema.String,
})

const BatchActionResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      message_id: Schema.String,
      result: Schema.String,
      skip_reason: Schema.optional(Schema.NullOr(Schema.String)),
    })
  ),
})

// --- urgency helpers ---

const URGENCY_ICON: Record<string, string> = {
  critical: "!!",
  high: "! ",
  medium: "- ",
  low: ". ",
  info: "  ",
}

function urgencyIcon(urgency: string): string {
  return URGENCY_ICON[urgency] ?? "  "
}

// --- count command ---

const countCommand = Command.make("count", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const stats = yield* kernel.get("/api/inbox/stats", InboxStats)

    const byUrgency = (stats.by_urgency ?? {}) as Record<string, number>
    const parts: string[] = []
    if (byUrgency.critical) parts.push(`${byUrgency.critical} critical`)
    if (byUrgency.high) parts.push(`${byUrgency.high} high`)

    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : ""
    yield* Console.log(`${stats.pending} pending${detail}`)
  })
)

// --- list command ---

const listUrgency = Options.text("urgency").pipe(
  Options.optional,
  Options.withDescription("Filter by urgency (critical, high, medium, low, info)")
)
const listKind = Options.text("kind").pipe(
  Options.optional,
  Options.withDescription("Filter by kind")
)
const listProject = Options.text("project").pipe(
  Options.optional,
  Options.withDescription("Filter by project key")
)
const listPending = Options.boolean("pending").pipe(
  Options.withDefault(false),
  Options.withDescription("Show only pending messages")
)
const listAll = Options.boolean("all").pipe(
  Options.withDefault(false),
  Options.withDescription("Include acted/dismissed/expired messages")
)
const listFormat = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table")
)
const listLimit = Options.integer("limit").pipe(Options.withDefault(50))

const listCommand = Command.make(
  "list",
  { urgency: listUrgency, kind: listKind, project: listProject, pending: listPending, all: listAll, format: listFormat, limit: listLimit },
  ({ urgency, kind, project, pending, all, format, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("limit", String(limit))
      if (Option.isSome(urgency)) params.set("urgency", urgency.value)
      if (Option.isSome(kind)) params.set("kind", kind.value)
      if (Option.isSome(project)) params.set("project", project.value)
      if (pending) params.set("status", "pending")
      if (!all && !pending) params.set("status", "pending")

      const messages = yield* kernel.get(`/api/inbox/messages?${params.toString()}`, InboxMessageList)

      if (messages.length === 0) {
        yield* Console.log("No messages found.")
        return
      }

      if (format === "json") {
        yield* Console.log(JSON.stringify(messages, null, 2))
        return
      }

      yield* Console.log(
        `${"".padEnd(3)} ${"ID".padEnd(10)} ${"Urgency".padEnd(10)} ${"Kind".padEnd(22)} ${"Status".padEnd(10)} Title`
      )
      yield* Console.log("-".repeat(90))
      for (const m of messages) {
        yield* Console.log(
          `${urgencyIcon(m.urgency)} ${m.id.slice(0, 8).padEnd(10)} ${m.urgency.padEnd(10)} ${m.kind.padEnd(22)} ${m.status.padEnd(10)} ${m.title.slice(0, 35)}`
        )
      }
    })
)

// --- view command ---

const messageId = Args.text({ name: "id" })

const viewCommand = Command.make(
  "view",
  { id: messageId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const m = yield* kernel.get(`/api/inbox/messages/${id}`, InboxMessage)

      yield* Console.log(`${m.id}: ${m.title}`)
      yield* Console.log("-".repeat(60))
      yield* Console.log(`Status:          ${m.status}`)
      yield* Console.log(`Urgency:         ${m.urgency}`)
      yield* Console.log(`Kind:            ${m.kind}`)
      yield* Console.log(`Source:          ${m.source}`)
      yield* Console.log(`Requires action: ${m.requires_action ? "yes" : "no"}`)
      yield* Console.log(`Thread:          ${m.thread_id}`)
      if (m.body) {
        yield* Console.log("")
        yield* Console.log(m.body)
      }
      yield* Console.log("")
      yield* Console.log(`Created: ${m.created_at}`)
      yield* Console.log(`Updated: ${m.updated_at}`)
    })
)

// --- thread command ---

const threadId = Args.text({ name: "id" })

const threadCommand = Command.make(
  "thread",
  { id: threadId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const thread = yield* kernel.get(`/api/inbox/threads/${id}`, InboxThreadWithMessages)

      yield* Console.log(`Thread: ${thread.title}`)
      yield* Console.log("-".repeat(60))
      yield* Console.log(`ID:            ${thread.id}`)
      yield* Console.log(`Context:       ${thread.context_type}:${thread.context_ref}`)
      if (thread.project_key) yield* Console.log(`Project:       ${thread.project_key}`)
      yield* Console.log(`Pending:       ${thread.pending_count}`)
      yield* Console.log(`Latest urgency: ${thread.latest_urgency}`)
      yield* Console.log("")

      if (thread.messages.length === 0) {
        yield* Console.log("No messages in thread.")
        return
      }

      yield* Console.log(`Messages (${thread.messages.length}):`)
      yield* Console.log("")
      for (const m of thread.messages) {
        yield* Console.log(`  ${urgencyIcon(m.urgency)} [${m.status}] ${m.id.slice(0, 8)} — ${m.title}`)
        yield* Console.log(`     ${m.kind} | ${m.source} | ${m.created_at}`)
        if (m.body) yield* Console.log(`     ${m.body.slice(0, 80)}`)
        yield* Console.log("")
      }
    })
)

// --- approve command ---

const approveReason = Options.text("reason").pipe(
  Options.optional,
  Options.withDescription("Reason for approval")
)

const approveCommand = Command.make(
  "approve",
  { id: messageId, reason: approveReason },
  ({ id, reason }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const body: Record<string, unknown> = {
        message_id: id,
        action_type: "approve",
        actor_id: "shell",
        actor_name: "gctl-shell",
      }
      if (Option.isSome(reason)) body.reason = reason.value

      const result = yield* kernel.post("/api/inbox/actions", body, ActionResponse)
      yield* Console.log(`Approved: ${result.message_id} (action ${result.id})`)
    })
)

// --- deny command ---

const denyReason = Options.text("reason").pipe(
  Options.withDescription("Reason for denial (required)")
)

const denyCommand = Command.make(
  "deny",
  { id: messageId, reason: denyReason },
  ({ id, reason }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        "/api/inbox/actions",
        {
          message_id: id,
          action_type: "deny",
          reason,
          actor_id: "shell",
          actor_name: "gctl-shell",
        },
        ActionResponse
      )
      yield* Console.log(`Denied: ${result.message_id} (action ${result.id})`)
    })
)

// --- acknowledge command ---

const acknowledgeCommand = Command.make(
  "acknowledge",
  { id: messageId },
  ({ id }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        "/api/inbox/actions",
        {
          message_id: id,
          action_type: "acknowledge",
          actor_id: "shell",
          actor_name: "gctl-shell",
        },
        ActionResponse
      )
      yield* Console.log(`Acknowledged: ${result.message_id} (action ${result.id})`)
    })
)

// --- defer command ---

const deferUntil = Options.text("until").pipe(
  Options.withDescription("Snooze duration (e.g. 2h) or ISO timestamp")
)

const deferCommand = Command.make(
  "defer",
  { id: messageId, until: deferUntil },
  ({ id, until }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        "/api/inbox/actions",
        {
          message_id: id,
          action_type: "defer",
          actor_id: "shell",
          actor_name: "gctl-shell",
          metadata: { snooze_until: until },
        },
        ActionResponse
      )
      yield* Console.log(`Deferred: ${result.message_id} until ${until} (action ${result.id})`)
    })
)

// --- batch-approve command ---

const batchIds = Args.text({ name: "ids" }).pipe(Args.repeated)
const batchReason = Options.text("reason").pipe(
  Options.optional,
  Options.withDescription("Shared reason for batch approval")
)

const batchApproveCommand = Command.make(
  "batch-approve",
  { ids: batchIds, reason: batchReason },
  ({ ids, reason }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const messageIds = Array.from(ids)

      if (messageIds.length === 0) {
        yield* Console.log("No message IDs provided.")
        return
      }

      const body: Record<string, unknown> = {
        message_ids: messageIds,
        action_type: "approve",
        actor_id: "shell",
        actor_name: "gctl-shell",
      }
      if (Option.isSome(reason)) body.reason = reason.value

      const result = yield* kernel.post("/api/inbox/batch-action", body, BatchActionResponse)

      let success = 0
      let skipped = 0
      for (const r of result.results) {
        if (r.result === "success") success++
        else skipped++
      }
      yield* Console.log(`Batch approve: ${success} approved, ${skipped} skipped`)

      for (const r of result.results) {
        const icon = r.result === "success" ? "+" : "-"
        const detail = r.skip_reason ? ` (${r.skip_reason})` : ""
        yield* Console.log(`  ${icon} ${r.message_id}${detail}`)
      }
    })
)

// --- actions command ---

const actionsActor = Options.text("actor").pipe(
  Options.optional,
  Options.withDescription("Filter by actor")
)
const actionsSince = Options.text("since").pipe(
  Options.optional,
  Options.withDescription("Filter by time window (e.g. 7d, 24h)")
)
const actionsLimit = Options.integer("limit").pipe(Options.withDefault(50))

const actionsCommand = Command.make(
  "actions",
  { actor: actionsActor, since: actionsSince, limit: actionsLimit },
  ({ actor, since, limit }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      params.set("limit", String(limit))
      if (Option.isSome(actor)) params.set("actor", actor.value)
      if (Option.isSome(since)) params.set("since", since.value)

      const actions = yield* kernel.get(`/api/inbox/actions?${params.toString()}`, InboxActionList)

      if (actions.length === 0) {
        yield* Console.log("No actions found.")
        return
      }

      yield* Console.log(
        `${"ID".padEnd(10)} ${"Action".padEnd(14)} ${"Actor".padEnd(16)} ${"Message".padEnd(10)} Timestamp`
      )
      yield* Console.log("-".repeat(70))
      for (const a of actions) {
        yield* Console.log(
          `${a.id.slice(0, 8).padEnd(10)} ${a.action_type.padEnd(14)} ${a.actor_name.padEnd(16)} ${a.message_id.slice(0, 8).padEnd(10)} ${a.created_at}`
        )
      }
    })
)

// --- stats command ---

const statsSince = Options.text("since").pipe(
  Options.optional,
  Options.withDescription("Time window (e.g. 30d)")
)

const statsCommand = Command.make(
  "stats",
  { since: statsSince },
  ({ since }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const params = new URLSearchParams()
      if (Option.isSome(since)) params.set("since", since.value)

      const stats = yield* kernel.get(`/api/inbox/stats?${params.toString()}`, InboxStats)

      yield* Console.log("Inbox Statistics")
      yield* Console.log("-".repeat(40))
      yield* Console.log(`Total messages:   ${stats.total}`)
      yield* Console.log(`Pending:          ${stats.pending}`)

      const byUrgency = (stats.by_urgency ?? {}) as Record<string, number>
      if (Object.keys(byUrgency).length > 0) {
        yield* Console.log("")
        yield* Console.log("By urgency:")
        for (const [level, count] of Object.entries(byUrgency)) {
          yield* Console.log(`  ${level.padEnd(12)} ${count}`)
        }
      }

      const byKind = (stats.by_kind ?? {}) as Record<string, number>
      if (Object.keys(byKind).length > 0) {
        yield* Console.log("")
        yield* Console.log("By kind:")
        for (const [kind, count] of Object.entries(byKind)) {
          yield* Console.log(`  ${kind.padEnd(22)} ${count}`)
        }
      }
    })
)

// --- inbox (parent) ---

export const inboxCommand = Command.make("inbox").pipe(
  Command.withSubcommands([
    countCommand,
    listCommand,
    viewCommand,
    threadCommand,
    approveCommand,
    denyCommand,
    acknowledgeCommand,
    deferCommand,
    batchApproveCommand,
    actionsCommand,
    statsCommand,
  ])
)
