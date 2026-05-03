/**
 * Analytics — D1-backed read handlers + kernel→D1 sync.
 *
 * Read endpoints (/api/analytics, /api/analytics/cost, /daily, etc.) serve
 * from the analytics_* tables so the dashboard works even when the kernel is
 * unreachable. The scheduled handler in worker.ts pulls from
 * KERNEL_URL/api/analytics/* every cron tick and upserts here.
 *
 * Latency percentiles stay on the kernel (D1 lacks PERCENTILE_CONT) — that
 * route is handled by the kernel proxy fallback in worker.ts.
 */
import { Context, Effect, Schema } from "effect"
import { D1Client, D1Error } from "./d1.js"

// ── Kernel fetch error — tagged so failures stay shaped, not stringified ──

export class KernelFetchError extends Schema.TaggedError<KernelFetchError>()(
  "KernelFetchError",
  { path: Schema.String, message: Schema.String },
) {}

// ── HTTP helpers (kept local so this module has no dep on worker.ts) ──

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })

// ── Kernel config — runtime view of env.KERNEL_URL ──

export interface KernelConfigShape {
  readonly kernelUrl: string | undefined
}
export class KernelConfig extends Context.Tag("KernelConfig")<KernelConfig, KernelConfigShape>() {}

// ── Handler signature shared with worker.ts ──

type RouteParams = Record<string, string>
export type AnalyticsHandler = (
  request: Request,
  params: RouteParams,
) => Effect.Effect<Response, D1Error, D1Client | KernelConfig>

// ── Read handlers ──

export const getOverview: AnalyticsHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client

    const totals = yield* db.first<{
      total_sessions: number
      total_cost_usd: number
      total_input_tokens: number
      total_output_tokens: number
    }>(
      `SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(total_input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(total_output_tokens), 0) AS total_output_tokens
      FROM analytics_sessions`,
    )

    const spanCount = yield* db.first<{ total_spans: number }>(
      `SELECT COALESCE(SUM(count), 0) AS total_spans FROM analytics_span_distribution`,
    )

    const byAgent = yield* db.query(
      `SELECT agent AS agent_name, sessions AS session_count, cost AS total_cost_usd
       FROM analytics_cost_by_agent ORDER BY cost DESC`,
    )

    const byModel = yield* db.query(
      `SELECT model, calls AS span_count, cost AS total_cost_usd,
              0 AS total_input_tokens, 0 AS total_output_tokens
       FROM analytics_cost_by_model ORDER BY cost DESC`,
    )

    return jsonResponse({
      total_sessions: totals?.total_sessions ?? 0,
      total_spans: spanCount?.total_spans ?? 0,
      total_cost_usd: totals?.total_cost_usd ?? 0,
      total_input_tokens: totals?.total_input_tokens ?? 0,
      total_output_tokens: totals?.total_output_tokens ?? 0,
      by_agent: byAgent,
      by_model: byModel,
    })
  })

export const getCost: AnalyticsHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const byModel = yield* db.query(
      `SELECT model, cost, calls FROM analytics_cost_by_model ORDER BY cost DESC`,
    )
    const byAgent = yield* db.query(
      `SELECT agent, cost, sessions FROM analytics_cost_by_agent ORDER BY cost DESC`,
    )
    return jsonResponse({ by_model: byModel, by_agent: byAgent })
  })

export const getSpanDistribution: AnalyticsHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const distribution = yield* db.query(
      `SELECT span_type AS type, count, percentage
       FROM analytics_span_distribution ORDER BY count DESC`,
    )
    return jsonResponse({ distribution })
  })

export const getDaily: AnalyticsHandler = (req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? "7")))

    const db = yield* D1Client
    const rows = yield* db.query(
      `SELECT date, metric, dimension, value
       FROM analytics_daily
       WHERE dimension = 'total'
       ORDER BY date DESC
       LIMIT ?`,
      days * 4 + 4,
    )

    // Pivot long-form (date, metric, value) → DailyEntry shape the frontend expects.
    const byDate = new Map<string, { date: string; sessions: number; spans: number; cost_usd: number; tokens: number }>()
    for (const r of rows as Array<{ date: string; metric: string; value: number }>) {
      const entry = byDate.get(r.date) ?? { date: r.date, sessions: 0, spans: 0, cost_usd: 0, tokens: 0 }
      if (r.metric === "sessions") entry.sessions = r.value
      else if (r.metric === "spans") entry.spans = r.value
      else if (r.metric === "cost") entry.cost_usd = r.value
      else if (r.metric === "tokens") entry.tokens = r.value
      byDate.set(r.date, entry)
    }
    const out = Array.from(byDate.values())
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, days)
    return jsonResponse(out)
  })

export const getAlerts: AnalyticsHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const rows = yield* db.query(
      `SELECT id, name, condition_type, threshold, action,
              CASE enabled WHEN 1 THEN 1 ELSE 0 END AS enabled
       FROM analytics_alerts WHERE enabled = 1 ORDER BY name`,
    )
    return jsonResponse(rows.map((r) => ({ ...r, enabled: r.enabled === 1 })))
  })

export const getScoreSummary: AnalyticsHandler = (req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const name = url.searchParams.get("name")
    if (!name) {
      return new Response(JSON.stringify({ error: "name query param required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      })
    }
    const db = yield* D1Client
    const row = yield* db.first<{
      name: string
      pass: number
      fail: number
      total: number
      pass_rate: number
      avg_value: number
    }>(
      `SELECT name, pass, fail, total, pass_rate, avg_value
       FROM analytics_scores WHERE name = ?`,
      name,
    )
    if (!row) {
      return jsonResponse({ name, pass: 0, fail: 0, total: 0, pass_rate: 0, avg_value: 0 })
    }
    return jsonResponse(row)
  })

export const listSessions: AnalyticsHandler = (req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "50")))
    const agent = url.searchParams.get("agent")
    const status = url.searchParams.get("status")
    const kind = url.searchParams.get("kind") // 'internal' | 'external' | 'all' | null

    let sql = `SELECT * FROM analytics_sessions WHERE 1=1`
    const binds: unknown[] = []
    if (agent) { sql += " AND agent_name = ?"; binds.push(agent) }
    if (status) { sql += " AND status = ?"; binds.push(status) }
    if (kind === "internal") sql += " AND created_by IN ('scheduler', 'api')"
    else if (kind === "external") sql += " AND created_by = 'otel_ingest'"
    sql += " ORDER BY started_at DESC LIMIT ?"
    binds.push(limit)

    const db = yield* D1Client
    const rows = yield* db.query(sql, ...binds)
    // Strip sync metadata from response
    return jsonResponse(rows.map((r) => {
      const { synced_at, ...rest } = r as Record<string, unknown>
      void synced_at
      return rest
    }))
  })

export const getSession: AnalyticsHandler = (_req, params) =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const row = yield* db.first<Record<string, unknown>>(
      `SELECT * FROM analytics_sessions WHERE id = ?`,
      params.id,
    )
    if (!row) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      })
    }
    const { synced_at, ...rest } = row
    void synced_at
    return jsonResponse(rest)
  })

// ── Sync state types ──

export interface SyncState {
  resource: string
  last_synced_at: string
  last_status: "ok" | "error"
  last_error: string | null
}

// GET /api/analytics/sync-status — surfaces sync_state rows + whether KERNEL_URL is set.
// Frontend uses this to render "last synced 2m ago" / "kernel not configured" / etc.
export const getSyncStatus: AnalyticsHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const cfg = yield* KernelConfig
    const rows = (yield* db.query(
      `SELECT resource, last_synced_at, last_status, last_error
       FROM analytics_sync_state ORDER BY resource`,
    )) as unknown as SyncState[]
    return jsonResponse({
      kernel_url_configured: Boolean(cfg.kernelUrl),
      resources: rows,
    })
  })

// POST /api/analytics/sync — kicks off syncFromKernel synchronously and returns
// the resulting state. Useful for `wrangler dev` (where cron requires
// --test-scheduled) and for ops "force refresh" actions.
export const triggerSync: AnalyticsHandler = () =>
  Effect.gen(function* () {
    const cfg = yield* KernelConfig
    if (!cfg.kernelUrl) {
      return new Response(
        JSON.stringify({ error: "KERNEL_URL not configured" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      )
    }
    const db = yield* D1Client
    yield* Effect.tryPromise({
      try: () => syncFromKernel(db.raw, makeKernelClient(cfg.kernelUrl!)),
      catch: (e) => new D1Error({ message: String(e) }),
    })
    const rows = (yield* db.query(
      `SELECT resource, last_synced_at, last_status, last_error
       FROM analytics_sync_state ORDER BY resource`,
    )) as unknown as SyncState[]
    return jsonResponse({ kernel_url_configured: true, resources: rows })
  })

// ── Kernel→D1 sync (called from scheduled handler) ──

export interface KernelClient {
  fetchJson: <A, I>(path: string, schema: Schema.Schema<A, I, never>) => Promise<A>
}

export const makeKernelClient = (kernelUrl: string): KernelClient => ({
  fetchJson: async <A, I>(
    path: string,
    schema: Schema.Schema<A, I, never>,
  ): Promise<A> => {
    const res = await fetch(new URL(path, kernelUrl).toString())
    if (!res.ok) {
      throw new KernelFetchError({ path, message: `HTTP ${res.status}` })
    }
    const raw = (await res.json()) as unknown
    return await Effect.runPromise(
      Schema.decodeUnknown(schema)(raw).pipe(
        Effect.mapError(
          (e) => new KernelFetchError({ path, message: `decode failed: ${String(e)}` }),
        ),
      ),
    )
  },
})

const recordSync = async (
  db: D1Database,
  resource: string,
  status: "ok" | "error",
  error: string | null,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO analytics_sync_state (resource, last_synced_at, last_status, last_error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(resource) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         last_status = excluded.last_status,
         last_error = excluded.last_error`,
    )
    .bind(resource, new Date().toISOString(), status, error)
    .run()
}

const syncResource = async (
  db: D1Database,
  resource: string,
  fn: () => Promise<void>,
): Promise<void> => {
  try {
    await fn()
    await recordSync(db, resource, "ok", null)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await recordSync(db, resource, "error", msg)
  }
}

const KernelSession = Schema.Struct({
  id: Schema.String,
  workspace_id: Schema.String,
  device_id: Schema.String,
  agent_name: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  status: Schema.String,
  total_cost_usd: Schema.Number,
  total_input_tokens: Schema.Number,
  total_output_tokens: Schema.Number,
  created_by: Schema.String,
})
type KernelSession = typeof KernelSession.Type
const KernelSessionArray = Schema.Array(KernelSession)

const KernelOverview = Schema.Struct({
  by_agent: Schema.Array(
    Schema.Struct({
      agent_name: Schema.String,
      session_count: Schema.Number,
      total_cost_usd: Schema.Number,
    }),
  ),
  by_model: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      span_count: Schema.Number,
      total_cost_usd: Schema.Number,
    }),
  ),
})

const KernelCost = Schema.Struct({
  by_model: Schema.Array(
    Schema.Struct({ model: Schema.String, cost: Schema.Number, calls: Schema.Number }),
  ),
  by_agent: Schema.Array(
    Schema.Struct({ agent: Schema.String, cost: Schema.Number, sessions: Schema.Number }),
  ),
})
type KernelCost = typeof KernelCost.Type

const KernelSpanDist = Schema.Struct({
  distribution: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      count: Schema.Number,
      percentage: Schema.Number,
    }),
  ),
})
type KernelSpanDist = typeof KernelSpanDist.Type

const KernelDailyRow = Schema.Struct({
  date: Schema.String,
  metric: Schema.String,
  dimension: Schema.String,
  value: Schema.Number,
})
type KernelDailyRow = typeof KernelDailyRow.Type
const KernelDailyRowArray = Schema.Array(KernelDailyRow)

const KernelAlert = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  condition_type: Schema.String,
  threshold: Schema.Number,
  action: Schema.String,
  enabled: Schema.Boolean,
})
type KernelAlert = typeof KernelAlert.Type
const KernelAlertArray = Schema.Array(KernelAlert)

const upsertSessions = async (db: D1Database, sessions: ReadonlyArray<KernelSession>): Promise<void> => {
  if (sessions.length === 0) return
  const now = new Date().toISOString()
  const stmts = sessions.map((s) =>
    db
      .prepare(
        `INSERT INTO analytics_sessions
          (id, workspace_id, device_id, agent_name, started_at, ended_at, status,
           total_cost_usd, total_input_tokens, total_output_tokens, created_by, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           status = excluded.status,
           total_cost_usd = excluded.total_cost_usd,
           total_input_tokens = excluded.total_input_tokens,
           total_output_tokens = excluded.total_output_tokens,
           created_by = excluded.created_by,
           synced_at = excluded.synced_at`,
      )
      .bind(
        s.id, s.workspace_id, s.device_id, s.agent_name, s.started_at,
        s.ended_at, s.status, s.total_cost_usd, s.total_input_tokens,
        s.total_output_tokens, s.created_by, now,
      ),
  )
  await db.batch(stmts)
}

const replaceCostByModel = async (db: D1Database, rows: KernelCost["by_model"]): Promise<void> => {
  const now = new Date().toISOString()
  const stmts = [
    db.prepare(`DELETE FROM analytics_cost_by_model`),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO analytics_cost_by_model (model, cost, calls, synced_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(r.model, r.cost, r.calls, now),
    ),
  ]
  await db.batch(stmts)
}

const replaceCostByAgent = async (db: D1Database, rows: KernelCost["by_agent"]): Promise<void> => {
  const now = new Date().toISOString()
  const stmts = [
    db.prepare(`DELETE FROM analytics_cost_by_agent`),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO analytics_cost_by_agent (agent, cost, sessions, synced_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(r.agent, r.cost, r.sessions, now),
    ),
  ]
  await db.batch(stmts)
}

const replaceSpanDistribution = async (
  db: D1Database,
  rows: KernelSpanDist["distribution"],
): Promise<void> => {
  const now = new Date().toISOString()
  const stmts = [
    db.prepare(`DELETE FROM analytics_span_distribution`),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO analytics_span_distribution (span_type, count, percentage, synced_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(r.type, r.count, r.percentage, now),
    ),
  ]
  await db.batch(stmts)
}

const upsertDaily = async (db: D1Database, rows: ReadonlyArray<KernelDailyRow>): Promise<void> => {
  if (rows.length === 0) return
  const now = new Date().toISOString()
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO analytics_daily (date, metric, dimension, value, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, metric, dimension) DO UPDATE SET
           value = excluded.value, synced_at = excluded.synced_at`,
      )
      .bind(r.date, r.metric, r.dimension, r.value, now),
  )
  await db.batch(stmts)
}

const replaceAlerts = async (db: D1Database, rows: ReadonlyArray<KernelAlert>): Promise<void> => {
  const now = new Date().toISOString()
  const stmts = [
    db.prepare(`DELETE FROM analytics_alerts`),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO analytics_alerts (id, name, condition_type, threshold, action, enabled, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(r.id, r.name, r.condition_type, r.threshold, r.action, r.enabled ? 1 : 0, now),
    ),
  ]
  await db.batch(stmts)
}

/**
 * Pull all analytics resources from the kernel and upsert into D1.
 * Each resource is synced independently — a failure in one doesn't block the others.
 */
export const syncFromKernel = async (
  db: D1Database,
  kernel: KernelClient,
): Promise<void> => {
  await Promise.all([
    syncResource(db, "sessions", async () => {
      const sessions = await kernel.fetchJson("/api/sessions?limit=500", KernelSessionArray)
      await upsertSessions(db, sessions)
    }),
    syncResource(db, "overview", async () => {
      // Overview's by_agent/by_model are subsumed by the cost rollups; nothing
      // extra to store here. Keep the resource entry so the sync table shows it.
      await kernel.fetchJson("/api/analytics", KernelOverview)
    }),
    syncResource(db, "cost", async () => {
      const cost = await kernel.fetchJson("/api/analytics/cost", KernelCost)
      await replaceCostByModel(db, cost.by_model)
      await replaceCostByAgent(db, cost.by_agent)
    }),
    syncResource(db, "spans", async () => {
      const dist = await kernel.fetchJson("/api/analytics/spans", KernelSpanDist)
      await replaceSpanDistribution(db, dist.distribution)
    }),
    syncResource(db, "daily", async () => {
      const rows = await kernel.fetchJson("/api/analytics/daily?days=30", KernelDailyRowArray)
      await upsertDaily(db, rows)
    }),
    syncResource(db, "alerts", async () => {
      const alerts = await kernel.fetchJson("/api/analytics/alerts", KernelAlertArray)
      await replaceAlerts(db, alerts)
    }),
  ])
}

// Keep KernelClient as a Tag in case the worker wants to inject it later.
export class KernelClientTag extends Context.Tag("KernelClient")<KernelClientTag, KernelClient>() {}
