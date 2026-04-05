/**
 * Issue Lifecycle — acceptance tests
 *
 * Validates the full issue lifecycle through the UI: project creation,
 * issue CRUD, detail panel interactions, status transitions (forward and
 * invalid), comments, and event history. Leverages the kernel HTTP API
 * to verify server-side state after each UI interaction.
 */
import { test, expect, selectProject, dragIssueToColumn, clickIssueCard } from "./fixtures/test"

test.describe("Issue Lifecycle", () => {
  test("creates project via project selector inline form", { tag: "@solo" }, async ({
    page,
  }) => {
    await page.goto("/")

    // Open selector
    const selectorContainer = page.locator("header .relative")
    await selectorContainer.locator("button").first().click()

    // Wait for dropdown, then click create
    const dropdown = selectorContainer.locator(".absolute")
    await expect(dropdown).toBeVisible()
    const createBtn = dropdown.getByText("+ Create project")
    await createBtn.scrollIntoViewIfNeeded()
    await createBtn.click({ force: true })

    // Fill form
    await page.getByPlaceholder("Project name").fill("Acceptance Test Project")
    await page.getByPlaceholder("KEY (e.g. BACK)").fill("ATP")

    // Submit
    await page.getByRole("button", { name: "CREATE" }).click()

    // Project now selected — key visible in selector button
    await expect(
      page.getByRole("button", { name: "ATP Acceptance Test Project" })
    ).toBeVisible()
  })

  test("shows error when creating project with duplicate key", async ({
    page,
    kernel,
  }) => {
    // Seed a project with key "DUP" via kernel
    await kernel.createProject("Original Project", "DUP")

    await page.goto("/")

    // Open selector and create form
    const selectorContainer = page.locator("header .relative")
    await selectorContainer.locator("button").first().click()
    const dropdown = selectorContainer.locator(".absolute")
    await expect(dropdown).toBeVisible()
    const createBtn = dropdown.getByText("+ Create project")
    await createBtn.scrollIntoViewIfNeeded()
    await createBtn.click({ force: true })

    // Try to create with the same key
    await page.getByPlaceholder("Project name").fill("Duplicate Project")
    await page.getByPlaceholder("KEY (e.g. BACK)").fill("DUP")
    await page.getByRole("button", { name: "CREATE" }).click()

    // Error toast appears
    await expect(
      page.locator(".bg-rose-950\\/80").first()
    ).toBeVisible({ timeout: 3_000 })
    await expect(page.getByText(/already exists/)).toBeVisible()
  })

  test("opens detail panel on issue card click", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Detail panel test",
      description: "This issue tests the detail panel",
      priority: "medium",
      labels: ["ui", "test"],
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)

    await clickIssueCard(page, issue.id)

    // Panel opens
    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel).toBeVisible()

    // Verify properties
    await expect(panel.getByText(issue.id)).toBeVisible()
    await expect(panel.getByText("Detail panel test")).toBeVisible()
    await expect(
      panel.getByText("This issue tests the detail panel")
    ).toBeVisible()
    await expect(panel.getByText("Backlog")).toBeVisible()
  })

  test("detail panel tabs switch correctly", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Tab test issue",
    })
    await kernel.addComment(issue.id, "Test comment from kernel")

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await clickIssueCard(page, issue.id)

    const panel = page.locator('[data-testid="issue-detail-panel"]')

    // Switch to comments
    await panel.getByRole("button", { name: /comments/i }).click()
    await expect(panel.getByText("Test comment from kernel")).toBeVisible()

    // Switch to events
    await panel.getByRole("button", { name: /events/i }).click()
    await expect(panel.getByText("created")).toBeVisible()
  })

  test("adds comment via detail panel", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Comment test issue",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await clickIssueCard(page, issue.id)

    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await panel.getByRole("button", { name: /comments/i }).click()

    // Type and submit comment
    await panel
      .getByPlaceholder("Add a comment...")
      .fill("Playwright acceptance test comment")
    await panel.getByRole("button", { name: "COMMENT", exact: true }).click()

    // Comment appears in UI
    await expect(
      panel.getByText("Playwright acceptance test comment")
    ).toBeVisible()

    // Verify via kernel
    const comments = await kernel.getComments(issue.id)
    expect(
      comments.some(
        (c) => c.body === "Playwright acceptance test comment"
      )
    ).toBe(true)
  })

  test("full forward transition: backlog → todo → in_progress → in_review → done", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Lifecycle transition issue",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText(issue.id)).toBeVisible()

    const targets = ["todo", "in_progress", "in_review", "done"] as const

    for (const status of targets) {
      await dragIssueToColumn(page, issue.id, status)
      const targetCol = page.locator(`[data-testid="column-${status}"]`)
      await expect(targetCol.getByText(issue.title)).toBeVisible({
        timeout: 5_000,
      })
    }

    // Kernel confirms final state
    const final = await kernel.getIssue(issue.id)
    expect(final.status).toBe("done")

    // Event history has all transitions
    const events = await kernel.getEvents(issue.id)
    const statusChanges = events.filter(
      (e) => e.event_type === "status_changed"
    )
    expect(statusChanges.length).toBeGreaterThanOrEqual(4)
  })

  test("invalid transition shows error toast", async ({
    page,
    kernel,
    seedProject,
  }) => {
    // Move issue to "done" via kernel
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Invalid transition test",
    })
    await kernel.moveIssue(issue.id, "todo")
    await kernel.moveIssue(issue.id, "in_progress")
    await kernel.moveIssue(issue.id, "in_review")
    await kernel.moveIssue(issue.id, "done")

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText(issue.id)).toBeVisible()

    // Try to drag from done → backlog (invalid)
    await dragIssueToColumn(page, issue.id, "backlog")

    // Error toast appears (rose background)
    await expect(
      page.locator(".bg-rose-950\\/80").first()
    ).toBeVisible({ timeout: 3_000 })

    // Issue stays in done column
    const doneCol = page.locator('[data-testid="column-done"]')
    await expect(doneCol.getByText(issue.title)).toBeVisible()
  })

  test("close detail panel via close button", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Close panel test",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await clickIssueCard(page, issue.id)

    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel).toBeVisible()

    // Close via X button
    await panel.locator("button:has(svg)").first().click()
    await expect(panel).not.toBeVisible()
  })

  test("close detail panel via backdrop click", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Backdrop close test",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await clickIssueCard(page, issue.id)

    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel).toBeVisible()

    // Click the backdrop overlay
    await page.locator(".fixed.inset-0.bg-black\\/50").click({ force: true })
    await expect(panel).not.toBeVisible()
  })

  test("labels display in detail panel", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Labels panel test",
      labels: ["frontend", "perf", "p0"],
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await clickIssueCard(page, issue.id)

    const panel = page.locator('[data-testid="issue-detail-panel"]')
    await expect(panel.getByText("frontend")).toBeVisible()
    await expect(panel.getByText("perf")).toBeVisible()
    await expect(panel.getByText("p0")).toBeVisible()
  })
})
