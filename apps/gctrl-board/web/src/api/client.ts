import type {
  AcceptanceRollup,
  Issue,
  MoveIssueResult,
  Project,
  Comment,
  IssueEvent,
  TeamRecommendation,
  TeamRenderResult,
  InboxMessage,
  InboxThread,
  InboxAction,
  InboxStats,
  GanttView,
  SessionSummary,
  SessionKind,
  AnalyticsOverview,
  CostAnalytics,
  DailyEntry,
  TraceTreeResponse,
  PromptList,
  LatencyAnalytics,
  SpanAnalytics,
  ScoreSummary,
  AlertRule,
  ContributionsResponse,
  NetTrafficStats,
  NetDomainsResponse,
  NetDailyResponse,
  NetTrafficRecord,
} from "../types"

const BASE = "/api/board"

/// `?kind=` shorthand suffix for analytics rollup endpoints.
/// `all` and undefined both mean "no filter" — emit no param so the
/// kernel returns population-wide totals.
function kindQuery(kind?: SessionKind): string {
  return kind && kind !== "all" ? `?kind=${kind}` : ""
}

// In Electron the preload bridge exposes `desktop.apiBase` so the renderer
// loaded from `file://` can reach the kernel sidecar on `http://127.0.0.1:4318`.
// On the web (no bridge) requests stay relative to the document origin.
function resolveUrl(path: string): string {
  const desktop = (globalThis as { desktop?: { apiBase?: string } }).desktop
  const base = desktop?.apiBase?.replace(/\/$/, "") ?? ""
  return `${base}${path}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  if (res.status === 204) return null as T
  return res.json()
}

export const api = {
  projects: {
    list: () => request<Project[]>(`${BASE}/projects`),
    create: (name: string, key: string) =>
      request<Project>(`${BASE}/projects`, {
        method: "POST",
        body: JSON.stringify({ name, key }),
      }),
  },

  issues: {
    list: (params?: {
      project_id?: string
      status?: string
      assignee_id?: string
      label?: string
    }) => {
      const qs = new URLSearchParams()
      if (params?.project_id) qs.set("project_id", params.project_id)
      if (params?.status) qs.set("status", params.status)
      if (params?.assignee_id) qs.set("assignee_id", params.assignee_id)
      if (params?.label) qs.set("label", params.label)
      const q = qs.toString()
      return request<Issue[]>(`${BASE}/issues${q ? `?${q}` : ""}`)
    },

    get: (id: string) => request<Issue>(`${BASE}/issues/${id}`),

    create: (input: {
      project_id: string
      title: string
      description?: string
      priority?: string
      labels?: string[]
      created_by_id: string
      created_by_name: string
      created_by_type: string
    }) =>
      request<Issue>(`${BASE}/issues`, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    move: (id: string, status: string) =>
      request<MoveIssueResult>(`${BASE}/issues/${id}/move`, {
        method: "POST",
        body: JSON.stringify({
          status,
          actor_id: "web-user",
          actor_name: "Web UI",
          actor_type: "human",
        }),
      }),

    assign: (
      id: string,
      assignee: { assignee_id: string; assignee_name: string; assignee_type: string }
    ) =>
      request<Issue>(`${BASE}/issues/${id}/assign`, {
        method: "POST",
        body: JSON.stringify(assignee),
      }),

    addComment: (
      id: string,
      comment: {
        author_id: string
        author_name: string
        author_type: string
        body: string
      }
    ) =>
      request<void>(`${BASE}/issues/${id}/comment`, {
        method: "POST",
        body: JSON.stringify(comment),
      }),

    events: (id: string) => request<IssueEvent[]>(`${BASE}/issues/${id}/events`),

    comments: (id: string) => request<Comment[]>(`${BASE}/issues/${id}/comments`),

    acceptance: (id: string) => request<AcceptanceRollup>(`${BASE}/issues/${id}/acceptance`),

    linkSession: (
      id: string,
      session: { session_id: string; cost_usd: number; tokens: number }
    ) =>
      request<void>(`${BASE}/issues/${id}/link-session`, {
        method: "POST",
        body: JSON.stringify(session),
      }),

    schedule: (
      id: string,
      patch: { start_date?: string | null; due_date?: string | null }
    ) =>
      request<Issue>(`${BASE}/issues/${id}/schedule`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
  },

  gantt: {
    project: (projectId: string) =>
      request<GanttView>(`${BASE}/projects/${projectId}/gantt`),
  },

  team: {
    recommend: (labels?: string[], prType?: string) => {
      const body: Record<string, unknown> = {}
      if (labels?.length) body.labels = labels
      if (prType) body.pr_type = prType
      return request<TeamRecommendation>("/api/team/recommend", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },

    render: (personaIds: string[], issueKey?: string) => {
      const body: Record<string, unknown> = { persona_ids: personaIds }
      if (issueKey) body.context = { issue_key: issueKey }
      return request<TeamRenderResult>("/api/team/render", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
  },

  inbox: {
    messages: (params?: {
      status?: string
      urgency?: string
      kind?: string
      project?: string
      requires_action?: boolean
      limit?: number
    }) => {
      const qs = new URLSearchParams()
      if (params?.status) qs.set("status", params.status)
      if (params?.urgency) qs.set("urgency", params.urgency)
      if (params?.kind) qs.set("kind", params.kind)
      if (params?.project) qs.set("project", params.project)
      if (params?.requires_action !== undefined)
        qs.set("requires_action", String(params.requires_action))
      if (params?.limit !== undefined) qs.set("limit", String(params.limit))
      const q = qs.toString()
      return request<InboxMessage[]>(`/api/inbox/messages${q ? `?${q}` : ""}`)
    },

    getMessage: (id: string) => request<InboxMessage>(`/api/inbox/messages/${id}`),

    threads: (params?: {
      project?: string
      has_pending?: boolean
      limit?: number
    }) => {
      const qs = new URLSearchParams()
      if (params?.project) qs.set("project", params.project)
      if (params?.has_pending !== undefined)
        qs.set("has_pending", String(params.has_pending))
      if (params?.limit !== undefined) qs.set("limit", String(params.limit))
      const q = qs.toString()
      return request<InboxThread[]>(`/api/inbox/threads${q ? `?${q}` : ""}`)
    },

    getThread: (id: string) =>
      request<InboxThread & { messages: InboxMessage[] }>(`/api/inbox/threads/${id}`),

    createAction: (body: {
      message_id: string
      action_type: string
      reason?: string
    }) =>
      request<InboxAction>("/api/inbox/actions", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    batchAction: (body: {
      message_ids: string[]
      action_type: string
      reason?: string
    }) =>
      request<InboxAction[]>("/api/inbox/actions/batch", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    stats: () => request<InboxStats>("/api/inbox/stats"),
  },

  // Kernel analytics + sessions — proxied by Vite dev server to :4318.
  // In production these hit the same origin and must be routed by the Worker
  // to the kernel HTTP API (see gctrl-analytics spec §5).
  sessions: {
    list: (params?: {
      limit?: number
      agent?: string
      status?: string
      /** Derived view filter — `internal` ⇒ {scheduler, api},
       *  `external` ⇒ {otel_ingest}, `all` (or omitted) ⇒ unfiltered. */
      kind?: "all" | "internal" | "external"
    }) => {
      const qs = new URLSearchParams()
      if (params?.limit !== undefined) qs.set("limit", String(params.limit))
      if (params?.agent) qs.set("agent", params.agent)
      if (params?.status) qs.set("status", params.status)
      if (params?.kind && params.kind !== "all") qs.set("kind", params.kind)
      const q = qs.toString()
      return request<SessionSummary[]>(`/api/sessions${q ? `?${q}` : ""}`)
    },

    get: (id: string) => request<SessionSummary>(`/api/sessions/${id}`),

    tree: (id: string) =>
      request<TraceTreeResponse>(`/api/sessions/${id}/tree`),

    /** Per-turn prompt + completion bodies for one session.
     *  Returns `{ count, prompts: PromptTurn[] }`, ordered by turn_ordinal.
     *  Source: `prompt_bodies` table written by the LLM relay (or any
     *  capture path that targets it). See llm-relay spec §M1. */
    prompts: (id: string) =>
      request<PromptList>(`/api/sessions/${id}/prompts`),
  },

  analytics: {
    // `kind` threads through to /api/analytics/* per analytics spec M3
    // follow-up. `all` ⇒ no filter (population-wide totals); `internal`
    // ⇒ {scheduler, api}; `external` ⇒ {otel_ingest}. The kernel
    // accepts `kind` directly, so we only attach the param when it
    // narrows the population.
    overview: (kind?: SessionKind) =>
      request<AnalyticsOverview>(`/api/analytics${kindQuery(kind)}`),
    cost: (kind?: SessionKind) =>
      request<CostAnalytics>(`/api/analytics/cost${kindQuery(kind)}`),
    daily: (days?: number) => {
      const q = days !== undefined ? `?days=${days}` : ""
      return request<DailyEntry[]>(`/api/analytics/daily${q}`)
    },
    latency: (kind?: SessionKind) =>
      request<LatencyAnalytics>(`/api/analytics/latency${kindQuery(kind)}`),
    spans: (kind?: SessionKind) =>
      request<SpanAnalytics>(`/api/analytics/spans${kindQuery(kind)}`),
    score: (name: string) =>
      request<ScoreSummary>(
        `/api/analytics/scores?name=${encodeURIComponent(name)}`,
      ),
    alerts: () => request<AlertRule[]>("/api/analytics/alerts"),
    syncStatus: () => request<AnalyticsSyncStatus>("/api/analytics/sync-status"),
    sync: () =>
      request<AnalyticsSyncStatus>("/api/analytics/sync", { method: "POST" }),
  },

  contributions: {
    /** List PRs in `repo` with trailer-inferred session join. `kind`
     *  drops rows whose joined session falls outside the population —
     *  unattributed rows are kept iff `kind` is `all`/undefined. See
     *  analytics spec M5. */
    list: (params: {
      repo: string
      kind?: SessionKind
      limit?: number
      /** `7d` / `30d` / `90d` / `YYYY-MM-DD` — kernel resolves both shapes
       *  (see receiver.rs::resolve_since). Empty / undefined ⇒ no filter. */
      since?: string
    }) => {
      const qs = new URLSearchParams({ repo: params.repo })
      if (params.kind && params.kind !== "all") qs.set("kind", params.kind)
      if (params.limit !== undefined) qs.set("limit", String(params.limit))
      if (params.since) qs.set("since", params.since)
      return request<ContributionsResponse>(`/api/contributions?${qs.toString()}`)
    },
  },

  /// Network traffic — proxied requests recorded by `gctrl-proxy`.
  /// All calls accept the same `since` shorthand the kernel parses
  /// (`15m`, `1h`, `24h`, `7d`); omit for all-time.
  net: {
    stats: (since?: string) => {
      const q = since ? `?since=${encodeURIComponent(since)}` : ""
      return request<NetTrafficStats>(`/api/net/stats${q}`)
    },
    domains: (params?: { since?: string; top?: number }) => {
      const qs = new URLSearchParams()
      if (params?.since) qs.set("since", params.since)
      if (params?.top !== undefined) qs.set("top", String(params.top))
      const q = qs.toString()
      return request<NetDomainsResponse>(`/api/net/domains${q ? `?${q}` : ""}`)
    },
    daily: (days?: number) => {
      const q = days !== undefined ? `?days=${days}` : ""
      return request<NetDailyResponse>(`/api/net/daily${q}`)
    },
    logs: (params?: { host?: string; since?: string; limit?: number }) => {
      const qs = new URLSearchParams()
      if (params?.host) qs.set("host", params.host)
      if (params?.since) qs.set("since", params.since)
      if (params?.limit !== undefined) qs.set("limit", String(params.limit))
      const q = qs.toString()
      return request<NetTrafficRecord[]>(`/api/net/logs${q ? `?${q}` : ""}`)
    },
  },
}

export interface AnalyticsSyncResource {
  resource: string
  last_synced_at: string
  last_status: "ok" | "error"
  last_error: string | null
}

export interface AnalyticsSyncStatus {
  kernel_url_configured: boolean
  resources: AnalyticsSyncResource[]
}
