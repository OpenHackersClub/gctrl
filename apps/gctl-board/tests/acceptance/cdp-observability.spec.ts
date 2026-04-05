/**
 * CDP Observability — acceptance tests
 *
 * Uses the Chrome DevTools Protocol to validate non-functional requirements:
 * network routing (all API calls through proxy), response correctness,
 * console health, performance metrics, and request latency.
 *
 * These tests go beyond standard Playwright by tapping into CDP domains:
 *   Network — request/response interception
 *   Runtime — console and exception capture
 *   Performance — timing metrics, heap size, layout duration
 */
import { test, expect, selectProject, dragIssueToColumn, clickIssueCard } from "./fixtures/test"

test.describe("CDP Observability", () => {
  test("all API requests route through /api/board/* proxy", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "CDP network test issue",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText("CDP network test issue")).toBeVisible()

    const apiRequests = cdp.getApiRequests()
    expect(apiRequests.length).toBeGreaterThan(0)

    // All API requests must go through Vite proxy (/api/board/*),
    // never directly to the kernel port
    for (const req of apiRequests) {
      const url = new URL(req.url)
      expect(url.pathname).toMatch(/^\/api\/board\//)
      expect(url.port).not.toBe("14318")
    }
  })

  test("API responses use application/json content-type", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Content-type test",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText("Content-type test")).toBeVisible()

    const apiReqs = cdp.getApiRequests()
    const withHeaders = apiReqs.filter((r) => r.responseHeaders)

    expect(withHeaders.length).toBeGreaterThan(0)
    for (const req of withHeaders) {
      const ct =
        req.responseHeaders?.["content-type"] ??
        req.responseHeaders?.["Content-Type"] ??
        ""
      expect(ct).toContain("application/json")
    }
  })

  test("no console errors during normal board workflow", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Console health test",
    })
    await kernel.addComment(issue.id, "Test comment for console check")

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText("Console health test")).toBeVisible()

    // Open detail panel, switch tabs
    await clickIssueCard(page, issue.id)
    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel).toBeVisible()
    await panel.getByRole("button", { name: /comments/i }).click()
    await expect(
      panel.getByText("Test comment for console check")
    ).toBeVisible()
    await panel.getByRole("button", { name: /events/i }).click()
    await panel.getByRole("button", { name: /details/i }).click()

    // Close panel
    await panel.locator("button:has(svg)").first().click()

    // No console errors during the entire workflow
    const errors = cdp.getConsoleErrors()
    expect(errors).toHaveLength(0)
  })

  test("no JavaScript exceptions during drag-and-drop", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "DnD exception test",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText(issue.id)).toBeVisible()

    // Clear startup noise
    cdp.clearConsole()

    // Drag to todo
    await dragIssueToColumn(page, issue.id, "todo")
    const todoCol = page.locator('[data-testid="column-todo"]')
    await expect(todoCol.getByText(issue.title)).toBeVisible()

    // No JS exceptions during DnD
    const errors = cdp.getConsoleErrors()
    expect(errors).toHaveLength(0)
  })

  test("performance metrics within acceptable bounds", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    // Create a realistic board with 10 issues across columns
    const priorities = ["urgent", "high", "medium", "low", "none"]
    const statuses = [
      null, null,
      "todo", "todo",
      "in_progress", "in_progress",
      "in_review", "in_review",
      "done", "done",
    ] as const

    for (let i = 0; i < 10; i++) {
      const issue = await kernel.createIssue({
        project_id: seedProject.id,
        title: `Perf test issue ${i + 1}`,
        priority: priorities[i % priorities.length],
      })
      const target = statuses[i]
      if (target === "todo") {
        await kernel.moveIssue(issue.id, "todo")
      } else if (target === "in_progress") {
        await kernel.moveIssue(issue.id, "todo")
        await kernel.moveIssue(issue.id, "in_progress")
      } else if (target === "in_review") {
        await kernel.moveIssue(issue.id, "todo")
        await kernel.moveIssue(issue.id, "in_progress")
        await kernel.moveIssue(issue.id, "in_review")
      } else if (target === "done") {
        await kernel.moveIssue(issue.id, "todo")
        await kernel.moveIssue(issue.id, "in_progress")
        await kernel.moveIssue(issue.id, "in_review")
        await kernel.moveIssue(issue.id, "done")
      }
    }

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText("Perf test issue 10")).toBeVisible()

    // CDP Performance metrics
    const metrics = await cdp.getPerformanceMetrics()

    // Layout duration < 1s (no excessive layout thrashing)
    expect(metrics["LayoutDuration"]).toBeLessThan(1.0)

    // Script duration < 3s
    expect(metrics["ScriptDuration"]).toBeLessThan(3.0)

    // JS heap < 50MB for a kanban board
    const heapMB = await cdp.getJSHeapSizeMB()
    expect(heapMB).toBeLessThan(50)
  })

  test("First Contentful Paint under 3 seconds", async ({ page }) => {
    await page.goto("/")

    const fcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const entry = performance
          .getEntriesByType("paint")
          .find((e) => e.name === "first-contentful-paint")
        if (entry) {
          resolve(entry.startTime)
        } else {
          const observer = new PerformanceObserver((list) => {
            const fcpEntry = list
              .getEntries()
              .find((e) => e.name === "first-contentful-paint")
            if (fcpEntry) {
              observer.disconnect()
              resolve(fcpEntry.startTime)
            }
          })
          observer.observe({ type: "paint", buffered: true })
        }
      })
    })

    expect(fcp).toBeLessThan(3000)
  })

  test("API response times under 500ms for CRUD operations", async ({
    page,
    kernel,
    seedProject,
  }) => {
    await page.goto("/")
    await selectProject(page, seedProject.key)

    // Wait for initial load
    await page.waitForLoadState("networkidle")

    // Create an issue and measure API timing
    await page.getByRole("button", { name: "+ NEW ISSUE" }).click()
    await page
      .locator('[data-testid="create-issue-dialog"]')
      .getByPlaceholder("What needs to be done?")
      .fill("Latency test issue")
    await page
      .locator('[data-testid="create-issue-dialog"]')
      .getByRole("button", { name: "CREATE ISSUE" })
      .click()
    await expect(page.getByText(/Created/)).toBeVisible()

    // Measure API timings via PerformanceResourceTiming
    const apiTimings = await page.evaluate(() => {
      return performance
        .getEntriesByType("resource")
        .filter(
          (e): e is PerformanceResourceTiming =>
            e.name.includes("/api/board/")
        )
        .map((e) => ({
          url: e.name,
          duration: e.duration,
        }))
    })

    expect(apiTimings.length).toBeGreaterThan(0)
    for (const timing of apiTimings) {
      expect(timing.duration).toBeLessThan(500)
    }
  })

  test("network summary report is clean after full workflow", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Report test issue",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText("Report test issue")).toBeVisible()

    const report = cdp.report()

    // Should have made API requests
    expect(report.apiRequests).toBeGreaterThan(0)
    // No failed requests
    expect(report.failedRequests).toBe(0)
    // No console errors
    expect(report.consoleErrors).toBe(0)
    // All API paths are board-related
    for (const path of report.apiPaths) {
      expect(path).toMatch(/^\/api\/board\//)
    }
  })

  test("document count stays stable during panel open/close", async ({
    page,
    cdp,
    kernel,
    seedProject,
  }) => {
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "DOM leak check",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText("DOM leak check")).toBeVisible()

    const docsBefore = await cdp.getDocumentCount()

    // Open and close panel 3 times
    for (let i = 0; i < 3; i++) {
      await page.locator(`[data-testid^="issue-card-"]`).first().click()
      const panel = page.locator('[data-testid="issue-detail-panel"]')
      await expect(panel).toBeVisible()
      await panel.locator("button:has(svg)").first().click()
      await expect(panel).not.toBeVisible()
    }

    const docsAfter = await cdp.getDocumentCount()
    // Document count should not grow (no iframe/document leaks)
    expect(docsAfter).toBeLessThanOrEqual(docsBefore + 1)
  })
})
