/**
 * Analytics — Local LLM relay end-to-end
 *
 * Drives a real prompt through the kernel's LLM relay and asserts the
 * resulting span/cost/prompt is captured AND surfaces in the analytics
 * dashboard.
 *
 * Wiring (set up by playwright.config.ts):
 *
 *     test → :RELAY_PORT/v1/chat/completions   (gctrl-proxy LlmRelay)
 *           ↓ forwards to
 *     mock LM Studio on :MOCK_LLM_PORT          (fixtures/mock-llm-server.cjs)
 *           ↓ relay captures + emits OTLP span back to
 *     kernel :KERNEL_PORT/v1/traces             (gctrl-otel receiver)
 *           ↓ persists prompt body + span row in DuckDB :memory:
 *     /api/sessions, /api/analytics, /api/sessions/{id}/prompts
 *           ↓ rendered by Worker / Vite proxy at /analytics/*
 *     dashboard
 *
 * The relay's `derive_gen_ai_system` returns "lmstudio" for upstream URLs
 * containing 127.0.0.1:1234 — our mock listens on a different port, so the
 * `gen_ai.system` attribute will be absent. That's fine: cost-by-model and
 * the sessions table key off `model` and `service.name`, both of which we
 * control via the request body / x-service-name header.
 */
import { test, expect } from "./fixtures/test"

const RELAY_PORT = Number(process.env.GCTRL_RELAY_PORT ?? 14319)
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/v1/chat/completions`
const MOCK_LLM_PORT = Number(process.env.MOCK_LLM_PORT ?? 14299)

interface RelayCallResult {
  sessionId: string
  serviceName: string
  model: string
  responseStatus: number
  responseBody: any
}

async function callRelay(opts?: {
  sessionId?: string
  serviceName?: string
  model?: string
  prompt?: string
}): Promise<RelayCallResult> {
  const stamp = Date.now().toString(36).slice(-5)
  const sessionId = opts?.sessionId ?? `relay-sess-${stamp}`
  const serviceName = opts?.serviceName ?? `relay-svc-${stamp}`
  const model = opts?.model ?? `mock-llm-model-${stamp}`
  const prompt = opts?.prompt ?? "Hello relay — please record this turn."

  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": sessionId,
      "x-service-name": serviceName,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a deterministic test stand-in." },
        { role: "user", content: prompt },
      ],
    }),
  })
  const responseBody = await res.json()
  return { sessionId, serviceName, model, responseStatus: res.status, responseBody }
}

test.describe("LLM relay → kernel → analytics dashboard", () => {
  test("relay forwards to the mock upstream and returns a 200 chat completion", async () => {
    const result = await callRelay()
    expect(result.responseStatus).toBe(200)
    expect(result.responseBody?.choices?.[0]?.message?.content).toMatch(/mock reply/)
    // Mock pins usage counts so we can verify the relay is talking to the
    // right upstream (and not a stale local LM Studio that happens to run
    // on the same machine).
    expect(result.responseBody?.usage?.prompt_tokens).toBe(42)
    expect(result.responseBody?.usage?.completion_tokens).toBe(17)
  })

  test("captured prompt + span land in kernel storage", async ({ kernel }) => {
    const result = await callRelay()
    expect(result.responseStatus).toBe(200)

    // Relay emits OTLP asynchronously after the response — poll until the
    // session row exists.
    await expect
      .poll(
        async () => {
          const sessions = await kernel.getSessions({ limit: 50 })
          return sessions.find((s: any) => s.id === result.sessionId)
        },
        { timeout: 10_000, message: "session never appeared in /api/sessions" },
      )
      .toBeTruthy()

    const sessions = await kernel.getSessions({ limit: 50 })
    const row = sessions.find((s: any) => s.id === result.sessionId)
    expect(row?.agent_name).toBe(result.serviceName)
    // Tokens come from the mock's pinned usage block.
    expect(row?.total_input_tokens + row?.total_output_tokens).toBeGreaterThanOrEqual(
      42 + 17,
    )

    const prompts = await kernel.listSessionPrompts(result.sessionId)
    expect(prompts.prompts.length).toBeGreaterThan(0)
  })

  test("/api/analytics rolls up the relay-driven generation span", async ({
    kernel,
  }) => {
    const before = await kernel.getAnalytics()
    const result = await callRelay()
    expect(result.responseStatus).toBe(200)

    await expect
      .poll(
        async () => {
          const a = await kernel.getAnalytics()
          return (
            a.total_sessions >= before.total_sessions + 1 &&
            a.total_spans >= before.total_spans + 1
          )
        },
        { timeout: 10_000 },
      )
      .toBe(true)

    // cost-by-model uses span.model. The relay emits ai.model.id from the
    // request body, so the mock's `model` field flows all the way through.
    const cost = await kernel.getCostAnalytics()
    const modelRow = cost.by_model.find((m) => m.model === result.model)
    expect(modelRow, `cost-by-model missing ${result.model}`).toBeTruthy()
    expect(modelRow!.calls).toBeGreaterThanOrEqual(1)

    const agentRow = cost.by_agent.find((a) => a.agent === result.serviceName)
    expect(agentRow, `cost-by-agent missing ${result.serviceName}`).toBeTruthy()
  })

  test("dashboard Sessions tab shows the relay row; Usage tab shows the model", async ({
    page,
    kernel,
  }) => {
    const result = await callRelay()
    expect(result.responseStatus).toBe(200)

    // Wait for the kernel to have the session before opening the page —
    // otherwise the first render would see an empty list and require us
    // to wait on the SSE stream to push it in.
    await expect
      .poll(
        async () => {
          const sessions = await kernel.getSessions({ limit: 50 })
          return sessions.some((s: any) => s.id === result.sessionId)
        },
        { timeout: 10_000 },
      )
      .toBe(true)

    await page.goto("/analytics/sessions")
    await expect(
      page.getByRole("row").filter({ hasText: result.serviceName }),
    ).toBeVisible({ timeout: 10_000 })

    await page.getByRole("tab", { name: "Usage" }).click()
    // The model appears in both cost-by-model AND latency-by-model
    // tables; either is fine for this assertion, hence `.first()`.
    await expect(
      page.getByRole("cell", { name: result.model }).first(),
    ).toBeVisible({ timeout: 10_000 })
  })

  test("dashboard Prompts tab renders captured turns for the relay session", async ({
    page,
    kernel,
  }) => {
    // Use a recognizable user prompt so we can assert it actually
    // surfaces in the UI rather than relying on token counts alone.
    const userPrompt = `dashboard-prompts-probe-${Date.now().toString(36).slice(-5)}`
    const result = await callRelay({ prompt: userPrompt })
    expect(result.responseStatus).toBe(200)

    await expect
      .poll(
        async () => {
          const list = await kernel.listSessionPrompts(result.sessionId)
          return list.prompts.length
        },
        {
          timeout: 10_000,
          message: "prompt bodies never landed in /api/sessions/{id}/prompts",
        },
      )
      .toBeGreaterThan(0)

    await page.goto(`/analytics/sessions/${result.sessionId}`)

    // Detail pane opens deep-linked. Switch to the Prompts tab.
    const promptsTab = page.getByTestId("session-tab-prompts")
    await expect(promptsTab).toBeVisible({ timeout: 10_000 })
    await promptsTab.click()

    // Prompt rows render with role badges and the user's prompt content.
    const list = page.getByTestId("prompts-list")
    await expect(list).toBeVisible({ timeout: 10_000 })
    // The relay captures the system + user turns from the request plus the
    // assistant reply from the response — at least three rows.
    await expect(list.getByTestId("prompt-row")).toHaveCount(3)
    await expect(list.locator('[data-role="user"]')).toContainText(userPrompt)
    await expect(list.locator('[data-role="assistant"]')).toContainText(
      "mock reply",
    )
  })

  test("relay path config — mock LLM server is reachable", async () => {
    // Sanity check that the mock is up. Doing this last so that if the
    // earlier tests fail we know whether it's a relay bug or an upstream
    // bug. A failure here means the playwright webServer didn't start
    // the mock — check playwright.config.ts.
    const res = await fetch(`http://127.0.0.1:${MOCK_LLM_PORT}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})
