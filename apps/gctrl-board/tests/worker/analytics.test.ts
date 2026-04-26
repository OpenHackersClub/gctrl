/**
 * Analytics tests — D1-backed read handlers + kernel→D1 sync.
 *
 * Read tests seed analytics_* tables directly (the prod sync path is exercised
 * separately in the sync tests below) and verify the Worker returns the shapes
 * the frontend expects.
 *
 * Sync tests pass a stub KernelClient into syncFromKernel so we don't need a
 * live kernel in the test isolate.
 */
import { HttpClient } from "@effect/platform"
import { env } from "cloudflare:test"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { syncFromKernel, type KernelClient } from "../../src/analytics"
import { HOST, runTest } from "./fixtures/http"

const clearAnalytics = async (): Promise<void> => {
  const tables = [
    "analytics_sessions",
    "analytics_daily",
    "analytics_cost_by_model",
    "analytics_cost_by_agent",
    "analytics_span_distribution",
    "analytics_scores",
    "analytics_alerts",
    "analytics_sync_state",
  ]
  for (const t of tables) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
}

afterEach(async () => {
  await clearAnalytics()
})

describe("Analytics D1 reads", () => {
  it("GET /api/analytics returns overview shape from rollup tables", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO analytics_sessions (id, workspace_id, device_id, agent_name, started_at, status, total_cost_usd, total_input_tokens, total_output_tokens, created_by)
         VALUES ('s1','w','d','agent-a','2026-04-26T00:00:00Z','completed',1.5,1000,500,'scheduler')`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_sessions (id, workspace_id, device_id, agent_name, started_at, status, total_cost_usd, total_input_tokens, total_output_tokens, created_by)
         VALUES ('s2','w','d','agent-b','2026-04-26T01:00:00Z','active',2.0,2000,800,'otel_ingest')`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_cost_by_model (model, cost, calls) VALUES ('gpt-4o', 3.5, 12)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_cost_by_agent (agent, cost, sessions) VALUES ('agent-a', 1.5, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_span_distribution (span_type, count, percentage) VALUES ('generation', 10, 50.0)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_span_distribution (span_type, count, percentage) VALUES ('span', 10, 50.0)`,
      ),
    ])

    const data = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics`)
        expect(res.status).toBe(200)
        return (yield* res.json) as Record<string, unknown>
      }),
    )

    expect(data.total_sessions).toBe(2)
    expect(data.total_spans).toBe(20)
    expect(data.total_cost_usd).toBeCloseTo(3.5)
    expect(data.total_input_tokens).toBe(3000)
    expect(data.total_output_tokens).toBe(1300)
    expect(Array.isArray(data.by_agent)).toBe(true)
    expect(Array.isArray(data.by_model)).toBe(true)
  })

  it("GET /api/analytics/cost returns by_model and by_agent rollups", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO analytics_cost_by_model (model, cost, calls) VALUES ('gpt-4o', 5.0, 20)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_cost_by_model (model, cost, calls) VALUES ('claude-opus', 3.0, 10)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_cost_by_agent (agent, cost, sessions) VALUES ('agent-a', 4.0, 2)`,
      ),
    ])

    const data = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics/cost`)
        expect(res.status).toBe(200)
        return (yield* res.json) as { by_model: unknown[]; by_agent: unknown[] }
      }),
    )

    expect(data.by_model).toHaveLength(2)
    expect(data.by_agent).toHaveLength(1)
    // Ordered by cost DESC
    expect((data.by_model[0] as { model: string }).model).toBe("gpt-4o")
  })

  it("GET /api/analytics/daily pivots long-form rows into DailyEntry shape", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO analytics_daily (date, metric, dimension, value) VALUES ('2026-04-25', 'sessions', 'total', 5)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_daily (date, metric, dimension, value) VALUES ('2026-04-25', 'spans', 'total', 50)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_daily (date, metric, dimension, value) VALUES ('2026-04-25', 'cost', 'total', 1.25)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_daily (date, metric, dimension, value) VALUES ('2026-04-25', 'tokens', 'total', 1500)`,
      ),
    ])

    const data = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics/daily?days=7`)
        expect(res.status).toBe(200)
        return (yield* res.json) as Array<Record<string, unknown>>
      }),
    )

    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      date: "2026-04-25",
      sessions: 5,
      spans: 50,
      cost_usd: 1.25,
    })
  })

  it("GET /api/analytics/alerts returns enabled alerts as JSON booleans", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO analytics_alerts (id, name, condition_type, threshold, action, enabled)
         VALUES ('a1', 'high-cost', 'cost_per_session_gt', 5.0, 'warn', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_alerts (id, name, condition_type, threshold, action, enabled)
         VALUES ('a2', 'disabled-rule', 'foo', 1.0, 'warn', 0)`,
      ),
    ])

    const data = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics/alerts`)
        return (yield* res.json) as Array<Record<string, unknown>>
      }),
    )

    expect(data).toHaveLength(1)
    expect(data[0].name).toBe("high-cost")
    expect(data[0].enabled).toBe(true)
  })

  it("GET /api/analytics/scores requires name and returns zeros when missing", async () => {
    const data400 = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics/scores`)
        expect(res.status).toBe(400)
        return (yield* res.json) as { error: string }
      }),
    )
    expect(data400.error).toMatch(/name/)

    const data200 = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics/scores?name=nonexistent`)
        expect(res.status).toBe(200)
        return (yield* res.json) as Record<string, unknown>
      }),
    )
    expect(data200.total).toBe(0)
    expect(data200.pass_rate).toBe(0)
  })

  it("GET /api/sessions filters by kind=internal/external", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO analytics_sessions (id, workspace_id, device_id, agent_name, started_at, status, total_cost_usd, total_input_tokens, total_output_tokens, created_by)
         VALUES ('s-int','w','d','sched','2026-04-26T00:00:00Z','completed',0,0,0,'scheduler')`,
      ),
      env.DB.prepare(
        `INSERT INTO analytics_sessions (id, workspace_id, device_id, agent_name, started_at, status, total_cost_usd, total_input_tokens, total_output_tokens, created_by)
         VALUES ('s-ext','w','d','ext','2026-04-26T01:00:00Z','completed',0,0,0,'otel_ingest')`,
      ),
    ])

    const internal = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/sessions?kind=internal`)
        return (yield* res.json) as Array<{ id: string }>
      }),
    )
    expect(internal.map((s) => s.id)).toEqual(["s-int"])

    const external = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/sessions?kind=external`)
        return (yield* res.json) as Array<{ id: string }>
      }),
    )
    expect(external.map((s) => s.id)).toEqual(["s-ext"])
  })
})

describe("syncFromKernel", () => {
  const fixedKernel = (): KernelClient => ({
    fetchJson: async <T>(path: string): Promise<T> => {
      if (path === "/api/sessions?limit=500") {
        return [
          {
            id: "s1",
            workspace_id: "w",
            device_id: "d",
            agent_name: "agent-a",
            started_at: "2026-04-26T00:00:00Z",
            ended_at: null,
            status: "active",
            total_cost_usd: 1.0,
            total_input_tokens: 100,
            total_output_tokens: 50,
            created_by: "scheduler",
          },
        ] as T
      }
      if (path === "/api/analytics") {
        return { by_agent: [], by_model: [] } as T
      }
      if (path === "/api/analytics/cost") {
        return {
          by_model: [{ model: "gpt-4o", cost: 1.0, calls: 5 }],
          by_agent: [{ agent: "agent-a", cost: 1.0, sessions: 1 }],
        } as T
      }
      if (path === "/api/analytics/spans") {
        return {
          distribution: [
            { type: "generation", count: 5, percentage: 100.0 },
          ],
        } as T
      }
      if (path === "/api/analytics/daily?days=30") {
        return [
          { date: "2026-04-26", metric: "sessions", dimension: "total", value: 1 },
          { date: "2026-04-26", metric: "spans", dimension: "total", value: 5 },
          { date: "2026-04-26", metric: "cost", dimension: "total", value: 1.0 },
          { date: "2026-04-26", metric: "tokens", dimension: "total", value: 150 },
        ] as T
      }
      if (path === "/api/analytics/alerts") {
        return [] as T
      }
      throw new Error(`unexpected path: ${path}`)
    },
  })

  it("populates all analytics tables from kernel responses", async () => {
    await syncFromKernel(env.DB, fixedKernel())

    const sessions = await env.DB.prepare(`SELECT id, agent_name FROM analytics_sessions`).all()
    expect(sessions.results).toHaveLength(1)

    const cost = await env.DB.prepare(`SELECT model FROM analytics_cost_by_model`).all()
    expect(cost.results).toHaveLength(1)

    const dist = await env.DB.prepare(`SELECT span_type FROM analytics_span_distribution`).all()
    expect(dist.results).toHaveLength(1)

    const daily = await env.DB.prepare(`SELECT date, metric FROM analytics_daily`).all()
    expect(daily.results).toHaveLength(4)
  })

  it("records ok status in sync_state for every resource", async () => {
    await syncFromKernel(env.DB, fixedKernel())

    const states = await env.DB
      .prepare(`SELECT resource, last_status FROM analytics_sync_state ORDER BY resource`)
      .all<{ resource: string; last_status: string }>()
    const map = new Map((states.results ?? []).map((r) => [r.resource, r.last_status]))
    expect(map.get("sessions")).toBe("ok")
    expect(map.get("overview")).toBe("ok")
    expect(map.get("cost")).toBe("ok")
    expect(map.get("spans")).toBe("ok")
    expect(map.get("daily")).toBe("ok")
    expect(map.get("alerts")).toBe("ok")
  })

  it("isolates failures — one resource failing doesn't block others", async () => {
    const flaky: KernelClient = {
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path === "/api/analytics/cost") throw new Error("kernel cost endpoint down")
        return fixedKernel().fetchJson<T>(path)
      },
    }
    await syncFromKernel(env.DB, flaky)

    const states = await env.DB
      .prepare(`SELECT resource, last_status, last_error FROM analytics_sync_state`)
      .all<{ resource: string; last_status: string; last_error: string | null }>()
    const map = new Map((states.results ?? []).map((r) => [r.resource, r]))
    expect(map.get("cost")?.last_status).toBe("error")
    expect(map.get("cost")?.last_error).toMatch(/kernel cost endpoint down/)
    // Others still succeeded
    expect(map.get("sessions")?.last_status).toBe("ok")
    expect(map.get("daily")?.last_status).toBe("ok")
  })

  it("GET /api/analytics/sync-status returns kernel_url_configured + sync rows", async () => {
    await env.DB
      .prepare(
        `INSERT INTO analytics_sync_state (resource, last_synced_at, last_status, last_error)
         VALUES ('sessions', '2026-04-26T00:00:00Z', 'ok', NULL)`,
      )
      .run()

    const data = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/analytics/sync-status`)
        expect(res.status).toBe(200)
        return (yield* res.json) as { kernel_url_configured: boolean; resources: Array<{ resource: string }> }
      }),
    )

    // KERNEL_URL is unset in the test environment
    expect(data.kernel_url_configured).toBe(false)
    expect(data.resources).toHaveLength(1)
    expect(data.resources[0].resource).toBe("sessions")
  })

  it("POST /api/analytics/sync returns 503 when KERNEL_URL is unset", async () => {
    const data = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/analytics/sync`)
        expect(res.status).toBe(503)
        return (yield* res.json) as { error: string }
      }),
    )
    expect(data.error).toMatch(/KERNEL_URL/)
  })

  it("upserts on resync — re-running with new data updates existing rows", async () => {
    await syncFromKernel(env.DB, fixedKernel())

    const updated: KernelClient = {
      fetchJson: async <T>(path: string): Promise<T> => {
        if (path === "/api/sessions?limit=500") {
          return [
            {
              id: "s1",
              workspace_id: "w",
              device_id: "d",
              agent_name: "agent-a",
              started_at: "2026-04-26T00:00:00Z",
              ended_at: "2026-04-26T01:00:00Z",
              status: "completed",
              total_cost_usd: 2.5,
              total_input_tokens: 200,
              total_output_tokens: 100,
              created_by: "scheduler",
            },
          ] as T
        }
        return fixedKernel().fetchJson<T>(path)
      },
    }
    await syncFromKernel(env.DB, updated)

    const row = await env.DB
      .prepare(`SELECT status, total_cost_usd, ended_at FROM analytics_sessions WHERE id = 's1'`)
      .first<{ status: string; total_cost_usd: number; ended_at: string }>()
    expect(row?.status).toBe("completed")
    expect(row?.total_cost_usd).toBe(2.5)
    expect(row?.ended_at).toBe("2026-04-26T01:00:00Z")
  })
})
