/**
 * Agent Integration — acceptance tests
 *
 * Validates the human+agent collaboration features of gctrl-board:
 * agent assignment badges, session linking with cost/token accumulation,
 * OTel trace ingestion through the kernel telemetry pipeline, and
 * multi-agent cost tracking.
 *
 * These tests exercise the full kernel stack:
 *   OTel ingest → session creation → board linking → UI display
 */
import { test, expect, selectProject, clickIssueCard } from "./fixtures/test"
import { hexId } from "./fixtures/kernel"

test.describe("Agent Integration", () => {
  test("agent assignee shows cyan badge with > prefix", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Agent assigned issue",
    })
    await kernel.assignIssue(issue.id, {
      assignee_id: "claude-code-1",
      assignee_name: "claude-code",
      assignee_type: "agent",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)

    const card = page.locator(`[data-testid="issue-card-${issue.id}"]`)
    await expect(card).toBeVisible()

    // Agent badge: cyan color + ">" prefix
    const badge = card.locator("span").filter({ hasText: "claude-code" })
    await expect(badge).toBeVisible()
    await expect(badge).toHaveClass(/cyan/)
  })

  test("human assignee shows amber badge with @ prefix", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Human assigned issue",
    })
    await kernel.assignIssue(issue.id, {
      assignee_id: "alice-1",
      assignee_name: "Alice",
      assignee_type: "human",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)

    const card = page.locator(`[data-testid="issue-card-${issue.id}"]`)
    await expect(card).toBeVisible()

    // Human badge: amber color + "@" prefix
    const badge = card.locator("span").filter({ hasText: "Alice" })
    await expect(badge).toBeVisible()
    await expect(badge).toHaveClass(/amber/)
  })

  test("session linking via kernel updates cost display on card", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Cost tracking issue",
    })

    // Link two sessions via kernel
    await kernel.linkSession(issue.id, "sess-001", 1.5, 5000)
    await kernel.linkSession(issue.id, "sess-002", 0.75, 2500)

    await page.goto("/")
    await selectProject(page, seedProject.key)

    const card = page.locator(`[data-testid="issue-card-${issue.id}"]`)
    await expect(card).toBeVisible()
    // Card shows accumulated cost
    await expect(card.getByText("$2.25")).toBeVisible()
  })

  test("detail panel shows cost, tokens, and session count", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Detail cost tracking",
    })
    await kernel.linkSession(issue.id, "sess-a", 1.5, 5000)
    await kernel.linkSession(issue.id, "sess-b", 0.75, 2500)

    await page.goto("/")
    await selectProject(page, seedProject.key)

    await clickIssueCard(page, issue.id)
    const panel = page.locator('[data-testid="issue-detail-panel"]')

    await expect(panel.getByText("$2.25")).toBeVisible()
    await expect(panel.getByText("7,500")).toBeVisible()
  })

  test("end-to-end: ingest OTel trace → link session → verify in UI", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Full agent pipeline test",
    })

    // Simulate agent work: ingest a trace
    const traceId = hexId(32)
    const spanId = hexId(16)
    const sessionId = `test-sess-${Date.now()}`

    await kernel.ingestTrace({
      traceId,
      spanId,
      sessionId,
      agentName: "claude-code",
      spanName: "implement-feature",
      costUsd: 3.42,
      durationMs: 15_000,
    })

    // Link the session to the board issue
    await kernel.linkSession(issue.id, sessionId, 3.42, 12000)

    // Verify session exists in kernel telemetry
    const sessions = await kernel.getSessions({
      agent: "claude-code",
      limit: 10,
    })
    expect(sessions.length).toBeGreaterThanOrEqual(1)

    // Verify in the board UI
    await page.goto("/")
    await selectProject(page, seedProject.key)

    const card = page.locator(`[data-testid="issue-card-${issue.id}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByText("$3.42")).toBeVisible()

    // Detail panel
    await clickIssueCard(page, issue.id)
    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel.getByText("$3.42")).toBeVisible()
    await expect(panel.getByText("12,000")).toBeVisible()
  })

  test("multiple agents on same issue accumulate cost independently", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Multi-agent cost test",
    })

    // Two different agent sessions
    await kernel.linkSession(issue.id, "sess-claude-1", 2.0, 8000)
    await kernel.linkSession(issue.id, "sess-reviewer-1", 0.5, 2000)

    await page.goto("/")
    await selectProject(page, seedProject.key)

    const card = page.locator(`[data-testid="issue-card-${issue.id}"]`)
    await expect(card.getByText("$2.50")).toBeVisible()

    await clickIssueCard(page, issue.id)
    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel.getByText("$2.50")).toBeVisible()
    await expect(panel.getByText("10,000")).toBeVisible()
  })

  test("kernel health reflects running state", async ({ kernel }) => {
    const health = await kernel.health()
    expect(health.version).toBeDefined()
    expect(health.uptime_seconds).toBeGreaterThan(0)
  })

  test("agent assignment visible in detail panel", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Agent detail panel test",
    })
    await kernel.assignIssue(issue.id, {
      assignee_id: "claude-code-1",
      assignee_name: "claude-code",
      assignee_type: "agent",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await clickIssueCard(page, issue.id)

    const panel = page.locator('[data-testid="issue-detail-panel"]')
    // Detail panel shows agent assignee
    await expect(panel.getByText("claude-code")).toBeVisible()
  })
})
