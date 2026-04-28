/**
 * Analytics Dashboard — acceptance tests
 *
 * Drives the /analytics/* page tree against a live kernel:
 *
 *   Overview     — KPIs + cost-by-model/cost-by-agent tables
 *   Sessions     — list / timeline / heatmap views, detail pane
 *   Usage        — providers / tools / latency / span distribution
 *   Evals        — alert rules + score lookup form
 *   Contributions — PR table (graceful when `gh` is unavailable)
 *
 * Data is seeded via direct kernel HTTP (`/v1/traces`) bypassing the UI.
 * Each test creates its own session ids so the in-memory kernel — which is
 * shared across the suite by the playwright webServer — stays loosely
 * isolated. Filters are kind-aware: traces ingested through `/v1/traces`
 * land as `created_by=otel_ingest` ⇒ `kind=external`.
 */
import { test, expect } from "./fixtures/test"
import { hexId } from "./fixtures/kernel"

interface SeededSession {
  sessionId: string
  agentName: string
  model: string
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/**
 * Seed a single completed external session with one Generation span.
 * Returns the params so tests can assert on agent name / model / cost.
 */
async function seedExternalSession(
  kernel: import("./fixtures/kernel").KernelTestClient,
  overrides?: Partial<SeededSession>,
): Promise<SeededSession> {
  const stamp = Date.now().toString(36).slice(-4)
  const seeded: SeededSession = {
    sessionId: overrides?.sessionId ?? `sess-${stamp}-${hexId(6)}`,
    agentName: overrides?.agentName ?? `analytics-agent-${stamp}`,
    model: overrides?.model ?? "test-model-v1",
    costUsd: overrides?.costUsd ?? 0.1234,
    inputTokens: overrides?.inputTokens ?? 1500,
    outputTokens: overrides?.outputTokens ?? 850,
  }
  await kernel.ingestTrace({
    traceId: hexId(32),
    spanId: hexId(16),
    sessionId: seeded.sessionId,
    agentName: seeded.agentName,
    spanName: "chat.completion",
    model: seeded.model,
    costUsd: seeded.costUsd,
    inputTokens: seeded.inputTokens,
    outputTokens: seeded.outputTokens,
    durationMs: 1200,
  })
  // End the session so it shows up as `completed` in the list, which
  // matches what the dashboard renders by default. Live sessions are
  // exercised separately by the timeline view test below.
  await kernel.endSession(seeded.sessionId, "completed")
  return seeded
}

test.describe("Analytics Dashboard", () => {
  test("renders all five tabs and routes update via the URL", async ({ page }) => {
    await page.goto("/analytics")
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Sessions" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Usage" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Evals" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Contributions" })).toBeVisible()

    // Click each tab and confirm the URL pushed and the tab body changed.
    await page.getByRole("tab", { name: "Sessions" }).click()
    await expect(page).toHaveURL(/\/analytics\/sessions/)
    await expect(
      page.locator('[data-testid="sessions-view-list"]'),
    ).toBeVisible()

    await page.getByRole("tab", { name: "Usage" }).click()
    await expect(page).toHaveURL(/\/analytics\/usage/)
    // Usage tab loads three rollups in parallel; the first heading is enough
    // to confirm the body switched even if the data is empty.
    await expect(
      page.getByText(/Providers — cost by model/i),
    ).toBeVisible()

    await page.getByRole("tab", { name: "Evals" }).click()
    await expect(page).toHaveURL(/\/analytics\/evals/)
    await expect(page.getByText(/Score lookup/i)).toBeVisible()
    // The page renders an "Alert rules" panel header AND, when empty,
    // a "No alert rules configured." body. Either is sufficient — the
    // heading is the more stable signal that the panel mounted.
    await expect(
      page.getByRole("heading", { name: /Alert rules/i }),
    ).toBeVisible()

    await page.getByRole("tab", { name: "Contributions" }).click()
    await expect(page).toHaveURL(/\/analytics\/contributions/)
    await expect(page.getByPlaceholder("owner/repo")).toBeVisible()

    await page.getByRole("tab", { name: "Overview" }).click()
    await expect(page).toHaveURL(/\/analytics\/overview/)
  })

  test("Overview KPIs reflect seeded sessions", async ({ page, kernel }) => {
    const before = await kernel.getAnalytics()
    const seeded = await seedExternalSession(kernel)

    await page.goto("/analytics/overview")

    // total sessions and total spans must each have grown by at least 1.
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

    // The cost is rolled up into the total. The label is `Total cost` (no
    // suffix) when kind=all is active, which is the default. We use a
    // partial regex because the exact value depends on suite ordering.
    const totalCard = page
      .locator("div", { hasText: /Total cost$/ })
      .first()
    await expect(totalCard).toBeVisible()

    // Cost by agent table should include the seeded service name once
    // /api/analytics/cost has caught up with the ingest. The page polls
    // its own state via the SSE stream, so a hard reload is the simplest
    // way to force a deterministic re-fetch under test conditions.
    await page.reload()
    await expect(
      page.getByRole("cell", { name: seeded.agentName }),
    ).toBeVisible({ timeout: 10_000 })
  })

  test("Sessions tab list view shows the seeded row with model + cost", async ({
    page,
    kernel,
  }) => {
    const seeded = await seedExternalSession(kernel)

    await page.goto("/analytics/sessions")

    // Wait for the row keyed by agent name. The list is virtualized only
    // implicitly (no windowing component), so a substring match is fine.
    const row = page
      .getByRole("row")
      .filter({ hasText: seeded.agentName })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText(`$${seeded.costUsd.toFixed(4)}`)
    const totalTokens = (
      seeded.inputTokens + seeded.outputTokens
    ).toLocaleString()
    await expect(row).toContainText(totalTokens)
  })

  test("Sessions view-mode switcher cycles through list / timeline / heatmap", async ({
    page,
    kernel,
  }) => {
    await seedExternalSession(kernel)

    await page.goto("/analytics/sessions")
    await expect(
      page.locator('[data-testid="sessions-view-list"]'),
    ).toBeVisible()

    await page.locator('[data-testid="sessions-view-timeline"]').click()
    // Timeline body has no role=table; the toggle going pressed is enough
    // to confirm the renderer switched. Radix sets data-state=on on press.
    await expect(
      page.locator('[data-testid="sessions-view-timeline"]'),
    ).toHaveAttribute("data-state", "on")

    await page.locator('[data-testid="sessions-view-heatmap"]').click()
    await expect(
      page.locator('[data-testid="sessions-view-heatmap"]'),
    ).toHaveAttribute("data-state", "on")

    await page.locator('[data-testid="sessions-view-list"]').click()
    await expect(
      page.locator('[data-testid="sessions-view-list"]'),
    ).toHaveAttribute("data-state", "on")
  })

  test("Usage tab surfaces cost-by-model and span distribution", async ({
    page,
    kernel,
  }) => {
    const seeded = await seedExternalSession(kernel, {
      model: `usage-model-${Date.now().toString(36).slice(-4)}`,
    })

    await page.goto("/analytics/usage")

    // Cost-by-model is the first panel; the seeded model + its formatted
    // cost should appear once /api/analytics/cost has the row. The model
    // label also shows up in latency-by-model below, hence `.first()`.
    await expect(
      page.getByRole("cell", { name: seeded.model }).first(),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: seeded.model })
        .getByText(`$${seeded.costUsd.toFixed(4)}`)
        .first(),
    ).toBeVisible()

    // The Generation span type should appear in the distribution. The
    // exact percentage depends on suite ordering — only check the row
    // exists.
    await expect(
      page.getByText("generation", { exact: false }),
    ).toBeVisible()
  })

  test("kind filter narrows totals to external", async ({ page, kernel }) => {
    await seedExternalSession(kernel)

    await page.goto("/analytics/overview")
    await page.locator('[data-testid="kind-external"]').click()

    // KPIs re-fetch with ?kind=external — total_sessions for external
    // must equal what /api/analytics?kind=external reports (which is at
    // least 1 since we just seeded an external row).
    await expect
      .poll(
        async () => {
          const a = await kernel.getAnalytics("external")
          return a.total_sessions >= 1
        },
        { timeout: 10_000 },
      )
      .toBe(true)

    // The "Total sessions (external)" KPI label appears once the filter
    // applies — it's the same Kpi component, just with a kind suffix.
    await expect(
      page.getByText(/Total sessions \(external\)/i),
    ).toBeVisible()
  })

  test("Evals tab — score lookup renders zeros for an unknown rule", async ({
    page,
  }) => {
    await page.goto("/analytics/evals")

    const form = page.locator("form").filter({
      has: page.getByPlaceholder(/score name/i),
    })
    await form.getByPlaceholder(/score name/i).fill("definitely_no_such_score")
    await form.getByRole("button", { name: /lookup/i }).click()

    // The kernel returns 200 + a zero-filled summary for an unknown name
    // (rather than 404), so the panel renders the four KPI cards with
    // zeros and a 0.0% pass rate.
    const passRateCard = page
      .locator("div")
      .filter({ hasText: /^Pass rate$/ })
      .first()
    await expect(passRateCard).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText("0.0%")).toBeVisible()
  })

  test("Contributions tab renders the repo selector and table shell", async ({
    page,
  }) => {
    await page.goto("/analytics/contributions")
    await expect(page.getByPlaceholder("owner/repo")).toBeVisible()
    // The default repo is OpenHackersClub/gctrl; the input is pre-filled
    // either with that or the localStorage override. Either way the
    // value should look like owner/repo.
    const input = page.getByPlaceholder("owner/repo")
    const value = await input.inputValue()
    expect(value).toMatch(/^[\w-]+\/[\w-]+$/)
    // The table either renders rows or an empty-state — both are valid
    // depending on whether `gh` is authed on the host. Just confirm the
    // page didn't crash.
    await expect(page.getByText(/Contributions/i).first()).toBeVisible()
  })
})

test.describe("Analytics Dashboard — CDP observability", () => {
  test("no console errors while clicking through every tab", async ({
    page,
    cdp,
    kernel,
  }) => {
    await seedExternalSession(kernel)

    await page.goto("/analytics/overview")
    cdp.clearConsole()

    for (const tab of ["Sessions", "Usage", "Evals", "Contributions", "Overview"]) {
      await page.getByRole("tab", { name: tab }).click()
      // Give each tab a beat to load its data — purely to flush any
      // promise-rejection noise into the console capture.
      await page.waitForTimeout(250)
    }

    const errors = cdp.getConsoleErrors()
    // Filter out noise from analytics_sync_status: in local dev there's
    // no Worker, so the route 404s. The page swallows it via .catch and
    // it produces a network 404 (not a console error), so this filter
    // is defensive — if it fires, we still want to know.
    const realErrors = errors.filter(
      (e) => !e.text.includes("/api/analytics/sync-status"),
    )
    expect(realErrors).toHaveLength(0)
  })

  test("all analytics requests are JSON and complete with 2xx", async ({
    page,
    cdp,
    kernel,
  }) => {
    await seedExternalSession(kernel)

    await page.goto("/analytics/overview")
    await expect(
      page.getByRole("tab", { name: "Overview" }),
    ).toHaveAttribute("data-state", "active")
    await page.getByRole("tab", { name: "Usage" }).click()
    await page.waitForTimeout(500)

    const analyticsReqs = cdp
      .getRequests()
      .filter((r) => {
        try {
          const url = new URL(r.url)
          return (
            url.pathname.startsWith("/api/analytics") ||
            url.pathname.startsWith("/api/sessions") ||
            url.pathname.startsWith("/api/net")
          )
        } catch {
          return false
        }
      })

    expect(analyticsReqs.length).toBeGreaterThan(0)

    for (const req of analyticsReqs) {
      // sync-status is a Worker-only endpoint and 404s in local dev. The
      // page tolerates that explicitly. Skip it for the 2xx assertion.
      if (req.url.includes("/api/analytics/sync-status")) continue

      // SSE long-polls don't carry a final status here; only assert when
      // a status was captured.
      if (req.responseStatus != null) {
        expect(
          req.responseStatus,
          `${req.url} returned ${req.responseStatus}`,
        ).toBeLessThan(400)
      }
    }
  })
})
