import { Command, Options } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

// --- schemas ---

const AnalyticsOverview = Schema.Struct({
  total_sessions: Schema.Number,
  active_sessions: Schema.Number,
  total_spans: Schema.Number,
  total_cost_usd: Schema.Number,
})

const CostByModel = Schema.Struct({
  model: Schema.String,
  cost: Schema.Number,
  calls: Schema.Number,
})
const CostByAgent = Schema.Struct({
  agent: Schema.String,
  cost: Schema.Number,
  sessions: Schema.Number,
})
const CostByProject = Schema.Struct({
  project: Schema.String,
  cost: Schema.Number,
  sessions: Schema.Number,
})
const CostByAgentProject = Schema.Struct({
  agent: Schema.String,
  project: Schema.String,
  cost: Schema.Number,
  sessions: Schema.Number,
})
// `by_project` / `by_agent_project` are optional so the shell stays
// compatible with older kernels that don't emit them.
const CostAnalytics = Schema.Struct({
  by_model: Schema.Array(CostByModel),
  by_agent: Schema.Array(CostByAgent),
  by_project: Schema.optional(Schema.Array(CostByProject)),
  by_agent_project: Schema.optional(Schema.Array(CostByAgentProject)),
})

const LatencyByModel = Schema.Struct({
  model: Schema.String,
  p50_ms: Schema.Number,
  p95_ms: Schema.Number,
  p99_ms: Schema.Number,
})
const LatencyAnalytics = Schema.Struct({
  by_model: Schema.Array(LatencyByModel),
})

const SpanDist = Schema.Struct({
  type: Schema.optional(Schema.String),
  span_type: Schema.optional(Schema.String),
  count: Schema.Number,
  percentage: Schema.Number,
})
const SpanAnalytics = Schema.Struct({
  distribution: Schema.Array(SpanDist),
})

const ScoreAnalytics = Schema.Struct({
  name: Schema.String,
  pass: Schema.Number,
  fail: Schema.Number,
  total: Schema.Number,
  pass_rate: Schema.Number,
  avg_value: Schema.Number,
})

const DailyEntry = Schema.Struct({
  date: Schema.String,
  sessions: Schema.Number,
  spans: Schema.Number,
  cost_usd: Schema.Number,
})
const DailyAnalytics = Schema.Array(DailyEntry)

const ScoreCreated = Schema.Struct({ id: Schema.String })
const TagCreated = Schema.Struct({ id: Schema.String })

const AlertRule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  condition_type: Schema.String,
  threshold: Schema.Number,
  action: Schema.String,
  enabled: Schema.Boolean,
})
const AlertList = Schema.Array(AlertRule)

// --- subcommands ---

const overviewCommand = Command.make("overview", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const a = yield* kernel.get("/api/analytics", AnalyticsOverview)
    yield* Console.log("Analytics Overview")
    yield* Console.log("-".repeat(40))
    yield* Console.log(`Sessions:  ${a.total_sessions} total, ${a.active_sessions} active`)
    yield* Console.log(`Spans:     ${a.total_spans}`)
    yield* Console.log(`Cost:      $${a.total_cost_usd.toFixed(4)}`)
  })
)

// `--by` selects which dimension(s) to render. Default `model,agent`
// preserves prior CLI output. `project` and `agent,project` add the
// new slices powered by the kernel's project_id column.
const costBy = Options.text("by").pipe(
  Options.withDefault("model,agent"),
  Options.withDescription(
    "Comma-separated dimensions to show: model, agent, project, agent,project (default: model,agent)"
  )
)

const costCommand = Command.make("cost", { by: costBy }, ({ by }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const c = yield* kernel.get("/api/analytics/cost", CostAnalytics)

    // Parse --by into a set of canonical dimension names. The string
    // "agent,project" (the matrix) is matched as a whole token, not
    // split into "agent" + "project". Keep parsing tolerant: drop
    // empties, keep order of first appearance.
    const want = new Set<string>()
    let raw = by.trim()
    if (raw.includes("agent,project")) {
      want.add("agent_project")
      raw = raw.replaceAll("agent,project", "")
    }
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (part === "model" || part === "agent" || part === "project") want.add(part)
    }
    if (want.size === 0) {
      want.add("model")
      want.add("agent")
    }

    if (want.has("model")) {
      yield* Console.log("Cost by Model")
      yield* Console.log(`${"Model".padEnd(30)} ${"Cost".padEnd(12)} Calls`)
      yield* Console.log("-".repeat(55))
      for (const m of c.by_model) {
        yield* Console.log(`${m.model.padEnd(30)} $${m.cost.toFixed(4).padEnd(11)} ${m.calls}`)
      }
    }

    if (want.has("agent")) {
      yield* Console.log("\nCost by Agent")
      yield* Console.log(`${"Agent".padEnd(30)} ${"Cost".padEnd(12)} Sessions`)
      yield* Console.log("-".repeat(55))
      for (const a of c.by_agent) {
        yield* Console.log(`${a.agent.padEnd(30)} $${a.cost.toFixed(4).padEnd(11)} ${a.sessions}`)
      }
    }

    if (want.has("project")) {
      const rows = c.by_project ?? []
      yield* Console.log("\nCost by Project")
      yield* Console.log(`${"Project".padEnd(30)} ${"Cost".padEnd(12)} Sessions`)
      yield* Console.log("-".repeat(55))
      if (rows.length === 0) {
        yield* Console.log("(no data — kernel may predate project_id, or no sessions are project-attributed)")
      } else {
        for (const p of rows) {
          yield* Console.log(`${p.project.padEnd(30)} $${p.cost.toFixed(4).padEnd(11)} ${p.sessions}`)
        }
      }
    }

    if (want.has("agent_project")) {
      const rows = c.by_agent_project ?? []
      yield* Console.log("\nCost by Agent x Project")
      yield* Console.log(
        `${"Agent".padEnd(22)} ${"Project".padEnd(22)} ${"Cost".padEnd(12)} Sessions`
      )
      yield* Console.log("-".repeat(70))
      if (rows.length === 0) {
        yield* Console.log("(no data — kernel may predate project_id, or no sessions are project-attributed)")
      } else {
        for (const r of rows) {
          yield* Console.log(
            `${r.agent.padEnd(22)} ${r.project.padEnd(22)} $${r.cost.toFixed(4).padEnd(11)} ${r.sessions}`
          )
        }
      }
    }
  })
)

const latencyCommand = Command.make("latency", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const l = yield* kernel.get("/api/analytics/latency", LatencyAnalytics)

    yield* Console.log("Latency by Model")
    yield* Console.log(`${"Model".padEnd(30)} ${"p50".padEnd(10)} ${"p95".padEnd(10)} p99`)
    yield* Console.log("-".repeat(65))
    for (const m of l.by_model) {
      yield* Console.log(
        `${m.model.padEnd(30)} ${String(m.p50_ms).padEnd(10)} ${String(m.p95_ms).padEnd(10)} ${m.p99_ms}`
      )
    }
  })
)

const spansCommand = Command.make("spans", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const s = yield* kernel.get("/api/analytics/spans", SpanAnalytics)

    yield* Console.log("Span Distribution")
    yield* Console.log(`${"Type".padEnd(20)} ${"Count".padEnd(10)} Percentage`)
    yield* Console.log("-".repeat(45))
    for (const d of s.distribution) {
      const typeName = d.span_type ?? d.type ?? "unknown"
      yield* Console.log(
        `${typeName.padEnd(20)} ${String(d.count).padEnd(10)} ${d.percentage.toFixed(1)}%`
      )
    }
  })
)

const scoreName = Options.text("name").pipe(
  Options.withDescription("Score name to query")
)

const scoresCommand = Command.make(
  "scores",
  { name: scoreName },
  ({ name }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const s = yield* kernel.get(`/api/analytics/scores?name=${encodeURIComponent(name)}`, ScoreAnalytics)

      yield* Console.log(`Score: ${s.name}`)
      yield* Console.log("-".repeat(40))
      yield* Console.log(`Pass: ${s.pass}  Fail: ${s.fail}  Total: ${s.total}`)
      yield* Console.log(`Pass Rate: ${(s.pass_rate * 100).toFixed(1)}%`)
      yield* Console.log(`Avg Value: ${s.avg_value.toFixed(2)}`)
    })
)

const days = Options.integer("days").pipe(Options.withDefault(7))

const dailyCommand = Command.make(
  "daily",
  { days },
  ({ days }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const entries = yield* kernel.get(`/api/analytics/daily?days=${days}`, DailyAnalytics)

      yield* Console.log(`${"Date".padEnd(12)} ${"Sessions".padEnd(10)} ${"Spans".padEnd(10)} Cost`)
      yield* Console.log("-".repeat(45))
      for (const e of entries) {
        yield* Console.log(
          `${e.date.padEnd(12)} ${String(e.sessions).padEnd(10)} ${String(e.spans).padEnd(10)} $${e.cost_usd.toFixed(4)}`
        )
      }
    })
)

// --- score (create) ---

const targetId = Options.text("target-id").pipe(
  Options.withDescription("Target session or span ID")
)
const scoreNameOpt = Options.text("name").pipe(
  Options.withDescription("Score name")
)
const scoreValue = Options.float("value").pipe(
  Options.withDescription("Score value (0-1)")
)
const scoreComment = Options.text("comment").pipe(
  Options.optional,
  Options.withDescription("Optional comment")
)

const createScoreCommand = Command.make(
  "score",
  { targetId, name: scoreNameOpt, value: scoreValue, comment: scoreComment },
  ({ targetId, name, value, comment }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const body: Record<string, unknown> = {
        target_type: "session",
        target_id: targetId,
        name,
        value,
        source: "human",
      }
      if (Option.isSome(comment)) body.comment = comment.value

      const result = yield* kernel.post("/api/analytics/score", body, ScoreCreated)
      yield* Console.log(`Score created: ${result.id}`)
    })
)

// --- tag (create) ---

const tagKey = Options.text("key").pipe(
  Options.withDescription("Tag key")
)
const tagValue = Options.text("value").pipe(
  Options.withDescription("Tag value")
)

const createTagCommand = Command.make(
  "tag",
  { targetId, key: tagKey, value: tagValue },
  ({ targetId, key, value }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const result = yield* kernel.post(
        "/api/analytics/tag",
        { target_type: "session", target_id: targetId, key, value },
        TagCreated
      )
      yield* Console.log(`Tag created: ${result.id}`)
    })
)

// --- alerts ---

const alertsCommand = Command.make("alerts", {}, () =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const alerts = yield* kernel.get("/api/analytics/alerts", AlertList)

    if (alerts.length === 0) {
      yield* Console.log("No alert rules configured.")
      return
    }

    yield* Console.log(`${"Name".padEnd(25)} ${"Type".padEnd(15)} ${"Threshold".padEnd(12)} Enabled`)
    yield* Console.log("-".repeat(60))
    for (const a of alerts) {
      yield* Console.log(
        `${a.name.padEnd(25)} ${a.condition_type.padEnd(15)} ${String(a.threshold).padEnd(12)} ${a.enabled ? "yes" : "no"}`
      )
    }
  })
)

// --- analytics (parent) ---

export const analyticsCommand = Command.make("analytics").pipe(
  Command.withSubcommands([
    overviewCommand,
    costCommand,
    latencyCommand,
    spansCommand,
    scoresCommand,
    dailyCommand,
    createScoreCommand,
    createTagCommand,
    alertsCommand,
  ])
)
