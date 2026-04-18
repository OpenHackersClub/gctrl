/**
 * Kernel Test Client — direct HTTP access to the gctrl kernel for test seeding
 * and verification. Bypasses the web UI entirely, talking to /api/board/* and
 * /v1/traces endpoints on the kernel daemon.
 *
 * Used by acceptance test fixtures to:
 *  - Seed projects, issues, comments before UI tests
 *  - Verify server-side state after UI interactions
 *  - Ingest OTel traces to simulate agent sessions
 *  - Query analytics to validate telemetry pipeline
 */

const DEFAULT_KERNEL_URL = `http://localhost:${process.env.GCTRL_KERNEL_PORT ?? 14318}`

// ── Response types ──

export interface TestProject {
  id: string
  name: string
  key: string
  counter: number
  github_repo?: string
}

export interface TestIssue {
  id: string
  project_id: string
  title: string
  description?: string
  status: string
  priority: string
  assignee_id?: string
  assignee_name?: string
  assignee_type?: string
  labels: string[]
  parent_id?: string
  created_at: string
  updated_at: string
  created_by_id: string
  created_by_name: string
  created_by_type: string
  session_ids: string[]
  total_cost_usd: number
  total_tokens: number
  pr_numbers: number[]
  blocked_by: string[]
  blocking: string[]
  acceptance_criteria: string[]
}

export interface TestComment {
  id: string
  issue_id: string
  author_id: string
  author_name: string
  author_type: string
  body: string
  created_at: string
}

export interface TestEvent {
  id: string
  issue_id: string
  event_type: string
  actor_id: string
  actor_name: string
  actor_type: string
  timestamp: string
  data: unknown
}

// ── Client ──

export class KernelTestClient {
  constructor(private readonly baseUrl = DEFAULT_KERNEL_URL) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(
        `Kernel ${res.status}: ${text} (${init?.method ?? "GET"} ${path})`
      )
    }
    if (res.status === 204) return null as T
    const text = await res.text()
    if (!text) return null as T
    return JSON.parse(text)
  }

  /** Wait for the kernel health endpoint to respond. */
  async waitForReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.request("/health")
        return
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    throw new Error(`Kernel not ready after ${timeoutMs}ms`)
  }

  async health(): Promise<{ version: string; uptime_seconds: number }> {
    return this.request("/health")
  }

  // ── Board: Projects ──

  async createProject(name: string, key: string): Promise<TestProject> {
    return this.request("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ name, key }),
    })
  }

  async listProjects(): Promise<TestProject[]> {
    return this.request("/api/board/projects")
  }

  // ── Board: Issues ──

  async createIssue(input: {
    project_id: string
    title: string
    description?: string
    priority?: string
    labels?: string[]
    created_by_id?: string
    created_by_name?: string
    created_by_type?: string
  }): Promise<TestIssue> {
    return this.request("/api/board/issues", {
      method: "POST",
      body: JSON.stringify({
        created_by_id: "test-harness",
        created_by_name: "Test Harness",
        created_by_type: "human",
        priority: "none",
        labels: [],
        ...input,
      }),
    })
  }

  async getIssue(id: string): Promise<TestIssue> {
    return this.request(`/api/board/issues/${id}`)
  }

  async listIssues(params?: {
    project_id?: string
    status?: string
  }): Promise<TestIssue[]> {
    const qs = new URLSearchParams()
    if (params?.project_id) qs.set("project_id", params.project_id)
    if (params?.status) qs.set("status", params.status)
    const q = qs.toString()
    return this.request(`/api/board/issues${q ? `?${q}` : ""}`)
  }

  async moveIssue(id: string, status: string): Promise<TestIssue> {
    return this.request(`/api/board/issues/${id}/move`, {
      method: "POST",
      body: JSON.stringify({
        status,
        actor_id: "test-harness",
        actor_name: "Test Harness",
        actor_type: "human",
      }),
    })
  }

  async assignIssue(
    id: string,
    assignee: {
      assignee_id: string
      assignee_name: string
      assignee_type: string
    }
  ): Promise<TestIssue> {
    return this.request(`/api/board/issues/${id}/assign`, {
      method: "POST",
      body: JSON.stringify(assignee),
    })
  }

  async addComment(
    id: string,
    body: string,
    author?: {
      author_id: string
      author_name: string
      author_type: string
    }
  ): Promise<void> {
    return this.request(`/api/board/issues/${id}/comment`, {
      method: "POST",
      body: JSON.stringify({
        author_id: "test-harness",
        author_name: "Test Harness",
        author_type: "human",
        body,
        ...author,
      }),
    })
  }

  async linkSession(
    issueId: string,
    sessionId: string,
    costUsd: number,
    tokens: number
  ): Promise<void> {
    return this.request(`/api/board/issues/${issueId}/link-session`, {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        cost_usd: costUsd,
        tokens,
      }),
    })
  }

  async getEvents(issueId: string): Promise<TestEvent[]> {
    return this.request(`/api/board/issues/${issueId}/events`)
  }

  async getComments(issueId: string): Promise<TestComment[]> {
    return this.request(`/api/board/issues/${issueId}/comments`)
  }

  // ── Board: Markdown Import/Export ──

  async importMarkdown(
    path: string
  ): Promise<{ imported: number; skipped: number; total: number }> {
    return this.request("/api/board/import", {
      method: "POST",
      body: JSON.stringify({ path }),
    })
  }

  async exportMarkdown(
    path: string,
    projectId?: string
  ): Promise<{ exported: number; files: string[] }> {
    const body: Record<string, unknown> = { path }
    if (projectId) body.project_id = projectId
    return this.request("/api/board/export", {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  // ── Telemetry: OTel Trace Ingestion ──

  /**
   * Ingest an OTLP trace into the kernel telemetry pipeline.
   * Simulates an agent session for end-to-end testing.
   */
  async ingestTrace(params: {
    traceId: string
    spanId: string
    sessionId: string
    agentName: string
    spanName?: string
    costUsd?: number
    durationMs?: number
  }): Promise<void> {
    const now = Date.now() * 1_000_000
    const duration = (params.durationMs ?? 1000) * 1_000_000

    const attributes = [
      {
        key: "session.id",
        value: { stringValue: params.sessionId },
      },
    ]
    if (params.costUsd != null) {
      attributes.push({
        key: "gctrl.cost.usd",
        value: { doubleValue: params.costUsd } as any,
      })
    }

    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: params.agentName },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: params.traceId,
                  spanId: params.spanId,
                  name: params.spanName ?? "agent-work",
                  kind: 1,
                  startTimeUnixNano: now - duration,
                  endTimeUnixNano: now,
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    }

    await this.request("/v1/traces", {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  // ── Telemetry: Sessions & Analytics ──

  async getSessions(params?: {
    limit?: number
    agent?: string
  }): Promise<any[]> {
    const qs = new URLSearchParams()
    if (params?.limit) qs.set("limit", String(params.limit))
    if (params?.agent) qs.set("agent", params.agent)
    const q = qs.toString()
    return this.request(`/api/sessions${q ? `?${q}` : ""}`)
  }

  async getAnalytics(): Promise<any> {
    return this.request("/api/analytics")
  }

  // ── Sync ──

  async getSyncStatus(): Promise<{
    pending: {
      projects: number
      issues: number
      comments: number
      issue_events: number
    }
    devices: Array<{ device_id: string; last_pull_at: string }>
  }> {
    return this.request("/api/sync/status")
  }
}

// ── Helpers ──

/** Generate a unique project key for test isolation (e.g. T1A2B3). */
export function uniqueProjectKey(): string {
  return `T${Date.now().toString(36).slice(-5).toUpperCase()}`
}

/** Generate a hex string of given length for trace/span IDs. */
export function hexId(length: number): string {
  const chars = "0123456789abcdef"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)]
  }
  return result
}
