/**
 * gctrl-board Cloudflare Worker entry point.
 *
 * Routes:
 *   /api/board/*  → D1-backed board API (Effect-TS handlers)
 *   /api/inbox/*  → stub returning empty stats
 *   everything else → static assets (SPA with fallback routing)
 *
 * Each API handler is an Effect program using D1Client, with tagged errors
 * caught and mapped to HTTP responses at the boundary.
 */
import { Effect } from "effect"
import { D1Client, D1Error, makeD1Client } from "./d1.js"

interface Env {
  ASSETS: Fetcher
  DB: D1Database
}

// ── HTTP helpers ──

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })

const errorResponse = (message: string, status = 400) =>
  jsonResponse({ error: message }, status)

const noContent = () =>
  new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  })

// ── Row parsing (JSON array columns stored as TEXT in D1) ──

const JSON_COLS = [
  "labels", "session_ids", "pr_numbers",
  "blocked_by", "blocking", "acceptance_criteria",
] as const

const parseRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...row }
  for (const col of JSON_COLS) {
    if (typeof out[col] === "string") {
      try { out[col] = JSON.parse(out[col] as string) } catch { out[col] = [] }
    }
  }
  if (typeof out.data === "string") {
    try { out.data = JSON.parse(out.data as string) } catch { out.data = {} }
  }
  return out
}

// ── Route matching ──

type RouteParams = Record<string, string>
type ApiHandler = (
  request: Request,
  params: RouteParams
) => Effect.Effect<Response, D1Error, D1Client>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: ApiHandler
}

const defineRoute = (method: string, path: string, handler: ApiHandler): Route => {
  const paramNames: string[] = []
  const pattern = new RegExp(
    "^" + path.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name)
      return "([^/]+)"
    }) + "$"
  )
  return { method, pattern, paramNames, handler }
}

// ── API Handlers (Effect programs using D1Client) ──

// Projects

const listProjects: ApiHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const rows = yield* db.query("SELECT * FROM projects ORDER BY created_at")
    return jsonResponse(rows)
  })

const createProject: ApiHandler = (req) =>
  Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => req.json(),
      catch: () => new D1Error({ message: "Invalid JSON" }),
    })) as { name?: string; key?: string; github_repo?: string }

    if (!body.name || !body.key) return errorResponse("name and key required")

    const db = yield* D1Client
    const id = crypto.randomUUID()
    const ts = new Date().toISOString()
    const key = body.key.toUpperCase()

    yield* db.run(
      "INSERT INTO projects (id, name, key, counter, github_repo, created_at) VALUES (?, ?, ?, 0, ?, ?)",
      id, body.name, key, body.github_repo ?? null, ts,
    )

    return jsonResponse(
      { id, name: body.name, key, counter: 0, github_repo: body.github_repo ?? null },
      201,
    )
  })

// Issues

const listIssues: ApiHandler = (req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const projectId = url.searchParams.get("project_id")
    const status = url.searchParams.get("status")
    const assigneeId = url.searchParams.get("assignee_id")
    const label = url.searchParams.get("label")

    let sql = "SELECT * FROM issues WHERE 1=1"
    const binds: unknown[] = []

    if (projectId) { sql += " AND project_id = ?"; binds.push(projectId) }
    if (status) { sql += " AND status = ?"; binds.push(status) }
    if (assigneeId) { sql += " AND assignee_id = ?"; binds.push(assigneeId) }
    if (label) { sql += " AND labels LIKE ?"; binds.push(`%"${label}"%`) }
    sql += " ORDER BY created_at DESC"

    const db = yield* D1Client
    const rows = yield* db.query(sql, ...binds)
    return jsonResponse(rows.map(parseRow))
  })

const getIssue: ApiHandler = (_req, params) =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const row = yield* db.first("SELECT * FROM issues WHERE id = ?", params.id)
    if (!row) return errorResponse("Issue not found", 404)
    return jsonResponse(parseRow(row as Record<string, unknown>))
  })

const createIssue: ApiHandler = (req) =>
  Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => req.json(),
      catch: () => new D1Error({ message: "Invalid JSON" }),
    })) as {
      project_id?: string; title?: string; description?: string
      priority?: string; labels?: string[]
      created_by_id?: string; created_by_name?: string; created_by_type?: string
    }

    if (!body.project_id || !body.title) return errorResponse("project_id and title required")

    const db = yield* D1Client
    const project = yield* db.first<{ key: string; counter: number }>(
      "SELECT key, counter FROM projects WHERE id = ?", body.project_id,
    )
    if (!project) return errorResponse("Project not found", 404)

    const newCounter = project.counter + 1
    const issueId = `${project.key}-${newCounter}`
    const ts = new Date().toISOString()

    yield* db.batch([
      {
        sql: "UPDATE projects SET counter = ? WHERE id = ?",
        binds: [newCounter, body.project_id],
      },
      {
        sql: `INSERT INTO issues (
          id, project_id, title, description, status, priority,
          labels, created_at, updated_at,
          created_by_id, created_by_name, created_by_type,
          session_ids, total_cost_usd, total_tokens, pr_numbers,
          blocked_by, blocking, acceptance_criteria
        ) VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, '[]', '[]', '[]', '[]')`,
        binds: [
          issueId, body.project_id, body.title, body.description ?? null,
          body.priority ?? "none", JSON.stringify(body.labels ?? []),
          ts, ts,
          body.created_by_id ?? "unknown", body.created_by_name ?? "Unknown",
          body.created_by_type ?? "human",
        ],
      },
      {
        sql: "INSERT INTO issue_events (id, issue_id, event_type, actor_id, actor_name, actor_type, timestamp, data) VALUES (?, ?, 'created', ?, ?, ?, ?, '{}')",
        binds: [
          crypto.randomUUID(), issueId,
          body.created_by_id ?? "unknown", body.created_by_name ?? "Unknown",
          body.created_by_type ?? "human", ts,
        ],
      },
    ])

    const row = yield* db.first("SELECT * FROM issues WHERE id = ?", issueId)
    return jsonResponse(parseRow(row as Record<string, unknown>), 201)
  })

const moveIssue: ApiHandler = (req, params) =>
  Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => req.json(),
      catch: () => new D1Error({ message: "Invalid JSON" }),
    })) as { status?: string; actor_id?: string; actor_name?: string; actor_type?: string }

    if (!body.status) return errorResponse("status required")

    const db = yield* D1Client
    const existing = yield* db.first<{ status: string }>(
      "SELECT status FROM issues WHERE id = ?", params.id,
    )
    if (!existing) return errorResponse("Issue not found", 404)

    const ts = new Date().toISOString()
    yield* db.batch([
      {
        sql: "UPDATE issues SET status = ?, updated_at = ? WHERE id = ?",
        binds: [body.status, ts, params.id],
      },
      {
        sql: "INSERT INTO issue_events (id, issue_id, event_type, actor_id, actor_name, actor_type, timestamp, data) VALUES (?, ?, 'status_changed', ?, ?, ?, ?, ?)",
        binds: [
          crypto.randomUUID(), params.id,
          body.actor_id ?? "unknown", body.actor_name ?? "Unknown",
          body.actor_type ?? "human", ts,
          JSON.stringify({ from: existing.status, to: body.status }),
        ],
      },
    ])

    const row = yield* db.first("SELECT * FROM issues WHERE id = ?", params.id)
    return jsonResponse(parseRow(row as Record<string, unknown>))
  })

const assignIssue: ApiHandler = (req, params) =>
  Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => req.json(),
      catch: () => new D1Error({ message: "Invalid JSON" }),
    })) as { assignee_id?: string; assignee_name?: string; assignee_type?: string }

    if (!body.assignee_id) return errorResponse("assignee_id required")

    const db = yield* D1Client
    const ts = new Date().toISOString()

    yield* db.batch([
      {
        sql: "UPDATE issues SET assignee_id = ?, assignee_name = ?, assignee_type = ?, updated_at = ? WHERE id = ?",
        binds: [body.assignee_id, body.assignee_name ?? "", body.assignee_type ?? "human", ts, params.id],
      },
      {
        sql: "INSERT INTO issue_events (id, issue_id, event_type, actor_id, actor_name, actor_type, timestamp, data) VALUES (?, ?, 'assigned', ?, ?, ?, ?, ?)",
        binds: [
          crypto.randomUUID(), params.id,
          body.assignee_id, body.assignee_name ?? "",
          body.assignee_type ?? "human", ts,
          JSON.stringify({ assignee_id: body.assignee_id, assignee_name: body.assignee_name }),
        ],
      },
    ])

    const row = yield* db.first("SELECT * FROM issues WHERE id = ?", params.id)
    if (!row) return errorResponse("Issue not found", 404)
    return jsonResponse(parseRow(row as Record<string, unknown>))
  })

const addComment: ApiHandler = (req, params) =>
  Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => req.json(),
      catch: () => new D1Error({ message: "Invalid JSON" }),
    })) as { author_id?: string; author_name?: string; author_type?: string; body?: string }

    if (!body.body) return errorResponse("body required")

    const db = yield* D1Client
    const id = crypto.randomUUID()
    const ts = new Date().toISOString()

    yield* db.batch([
      {
        sql: "INSERT INTO comments (id, issue_id, author_id, author_name, author_type, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        binds: [id, params.id, body.author_id ?? "unknown", body.author_name ?? "Unknown", body.author_type ?? "human", body.body, ts],
      },
      {
        sql: "UPDATE issues SET updated_at = ? WHERE id = ?",
        binds: [ts, params.id],
      },
      {
        sql: "INSERT INTO issue_events (id, issue_id, event_type, actor_id, actor_name, actor_type, timestamp, data) VALUES (?, ?, 'comment_added', ?, ?, ?, ?, ?)",
        binds: [crypto.randomUUID(), params.id, body.author_id ?? "unknown", body.author_name ?? "Unknown", body.author_type ?? "human", ts, JSON.stringify({ comment_id: id })],
      },
    ])

    return noContent()
  })

const listComments: ApiHandler = (_req, params) =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const rows = yield* db.query(
      "SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at", params.id,
    )
    return jsonResponse(rows)
  })

const listEvents: ApiHandler = (_req, params) =>
  Effect.gen(function* () {
    const db = yield* D1Client
    const rows = yield* db.query(
      "SELECT * FROM issue_events WHERE issue_id = ? ORDER BY timestamp", params.id,
    )
    return jsonResponse(rows.map(parseRow))
  })

const linkSession: ApiHandler = (req, params) =>
  Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => req.json(),
      catch: () => new D1Error({ message: "Invalid JSON" }),
    })) as { session_id?: string; cost_usd?: number; tokens?: number }

    if (!body.session_id) return errorResponse("session_id required")

    const db = yield* D1Client
    const row = yield* db.first<{ session_ids: string; total_cost_usd: number; total_tokens: number }>(
      "SELECT session_ids, total_cost_usd, total_tokens FROM issues WHERE id = ?", params.id,
    )
    if (!row) return errorResponse("Issue not found", 404)

    const sessionIds: string[] = JSON.parse(row.session_ids)
    if (!sessionIds.includes(body.session_id)) sessionIds.push(body.session_id)

    const ts = new Date().toISOString()
    yield* db.run(
      "UPDATE issues SET session_ids = ?, total_cost_usd = ?, total_tokens = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(sessionIds),
      row.total_cost_usd + (body.cost_usd ?? 0),
      row.total_tokens + (body.tokens ?? 0),
      ts, params.id,
    )

    return noContent()
  })

// Inbox stub

const inboxStats: ApiHandler = () =>
  Effect.succeed(
    jsonResponse({ total: 0, unread: 0, requires_action: 0, by_urgency: {}, by_kind: {} }),
  )

// Sync status — per-table unsynced row counts and device watermarks.
// Used by the Rust sync engine and acceptance tests to verify D1 schema health.

const syncStatus: ApiHandler = () =>
  Effect.gen(function* () {
    const db = yield* D1Client

    const [projects, issues, comments, events, manifest] = yield* Effect.all([
      db.first<{ count: number }>("SELECT COUNT(*) AS count FROM projects WHERE synced = 0"),
      db.first<{ count: number }>("SELECT COUNT(*) AS count FROM issues WHERE synced = 0"),
      db.first<{ count: number }>("SELECT COUNT(*) AS count FROM comments WHERE synced = 0"),
      db.first<{ count: number }>("SELECT COUNT(*) AS count FROM issue_events WHERE synced = 0"),
      db.query("SELECT device_id, last_pull_at FROM sync_manifest ORDER BY last_pull_at DESC"),
    ])

    return jsonResponse({
      pending: {
        projects: projects?.count ?? 0,
        issues: issues?.count ?? 0,
        comments: comments?.count ?? 0,
        issue_events: events?.count ?? 0,
      },
      devices: manifest,
    })
  })

// ── Route table ──

const routes: Route[] = [
  defineRoute("GET", "/api/board/projects", listProjects),
  defineRoute("POST", "/api/board/projects", createProject),
  defineRoute("GET", "/api/board/issues", listIssues),
  defineRoute("GET", "/api/board/issues/:id", getIssue),
  defineRoute("POST", "/api/board/issues", createIssue),
  defineRoute("POST", "/api/board/issues/:id/move", moveIssue),
  defineRoute("POST", "/api/board/issues/:id/assign", assignIssue),
  defineRoute("POST", "/api/board/issues/:id/comment", addComment),
  defineRoute("GET", "/api/board/issues/:id/comments", listComments),
  defineRoute("GET", "/api/board/issues/:id/events", listEvents),
  defineRoute("POST", "/api/board/issues/:id/link-session", linkSession),
  defineRoute("GET", "/api/inbox/stats", inboxStats),
  defineRoute("GET", "/api/sync/status", syncStatus),
]

// ── Route matcher → Effect<Response> ──

const matchRoute = (
  request: Request,
  pathname: string,
): Effect.Effect<Response, D1Error, D1Client> | null => {
  for (const r of routes) {
    if (request.method !== r.method) continue
    const match = pathname.match(r.pattern)
    if (!match) continue

    const params: RouteParams = {}
    r.paramNames.forEach((name, i) => { params[name] = match[i + 1] })
    return r.handler(request, params)
  }
  return null
}

// ── Main fetch handler ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // API routes
    if (url.pathname.startsWith("/api/")) {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        })
      }

      const effect = matchRoute(request, url.pathname)
      if (!effect) return errorResponse("Not found", 404)

      // Provide D1Client and run the Effect
      const d1 = makeD1Client(env.DB)
      return Effect.runPromise(
        effect.pipe(
          Effect.provideService(D1Client, d1),
          Effect.catchTag("D1Error", (e) =>
            Effect.succeed(errorResponse(e.message, 500)),
          ),
        ),
      )
    }

    // Static assets
    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404) return assetResponse

    // SPA fallback
    if (!url.pathname.startsWith("/assets/")) {
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request))
    }

    return assetResponse
  },
} satisfies ExportedHandler<Env>
