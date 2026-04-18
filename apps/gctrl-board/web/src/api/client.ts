import type {
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
} from "../types"

const BASE = "/api/board"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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

    linkSession: (
      id: string,
      session: { session_id: string; cost_usd: number; tokens: number }
    ) =>
      request<void>(`${BASE}/issues/${id}/link-session`, {
        method: "POST",
        body: JSON.stringify(session),
      }),
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
}
