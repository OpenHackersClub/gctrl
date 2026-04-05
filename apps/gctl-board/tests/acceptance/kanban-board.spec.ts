/**
 * Kanban Board — acceptance tests
 *
 * Validates the core board UI: column rendering, issue card display,
 * drag-and-drop movement, and create-issue flow.
 * Data is seeded via the kernel HTTP API (not through the UI).
 */
import { test, expect, selectProject, dragIssueToColumn } from "./fixtures/test"

test.describe("Kanban Board", () => {
  test("renders 5 status columns with correct headers", async ({
    page,
    seedProject,
  }) => {
    await page.goto("/")
    await selectProject(page, seedProject.key)

    const expected = ["Backlog", "To Do", "In Progress", "In Review", "Done"]
    for (const label of expected) {
      await expect(
        page.locator(`[data-testid^="column-"]`).getByText(label).first()
      ).toBeVisible()
    }
  })

  test("shows empty state when no project selected", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("no project selected")).toBeVisible()
    await expect(
      page.getByText("Select or create a project")
    ).toBeVisible()
  })

  test("displays issue cards in correct columns", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const backlogIssue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Stays in backlog",
    })
    const ipIssue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Moved to in-progress",
    })
    await kernel.moveIssue(ipIssue.id, "todo")
    await kernel.moveIssue(ipIssue.id, "in_progress")

    await page.goto("/")
    await selectProject(page, seedProject.key)

    await expect(page.getByText(backlogIssue.id)).toBeVisible()
    await expect(page.getByText(ipIssue.id)).toBeVisible()

    const backlogCol = page.locator('[data-testid="column-backlog"]')
    const ipCol = page.locator('[data-testid="column-in_progress"]')

    await expect(backlogCol.getByText(backlogIssue.title)).toBeVisible()
    await expect(ipCol.getByText(ipIssue.title)).toBeVisible()
  })

  test("shows issue count in header", async ({
    page,
    kernel,
    seedProject,
  }) => {
    for (let i = 0; i < 3; i++) {
      await kernel.createIssue({
        project_id: seedProject.id,
        title: `Count issue ${i + 1}`,
      })
    }

    await page.goto("/")
    await selectProject(page, seedProject.key)

    await expect(page.getByText("Count issue 1")).toBeVisible()
    // Header shows total "KEY / 3 issues"
    await expect(
      page.getByText(`${seedProject.key} / 3 issues`)
    ).toBeVisible()
  })

  test("displays card details — ID, title, priority badge, labels", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Auth middleware refactor",
      priority: "high",
      labels: ["bug", "security"],
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)

    const card = page.locator(`[data-testid="issue-card-${issue.id}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByText(issue.id)).toBeVisible()
    await expect(card.getByText("Auth middleware refactor")).toBeVisible()
    await expect(card.getByText("HI")).toBeVisible()
    await expect(card.getByText("bug")).toBeVisible()
    await expect(card.getByText("security")).toBeVisible()
  })

  test("drag-and-drop moves issue to valid column", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Drag test issue",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText(issue.id)).toBeVisible()

    await dragIssueToColumn(page, issue.id, "todo")

    // Card should now be in todo column
    const todoCol = page.locator('[data-testid="column-todo"]')
    await expect(todoCol.getByText(issue.title)).toBeVisible({ timeout: 5_000 })

    // Kernel confirms the move
    const updated = await kernel.getIssue(issue.id)
    expect(updated.status).toBe("todo")
  })

  test("drag across multiple columns auto-transits intermediate statuses", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Auto-transit drag test",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)
    await expect(page.getByText(issue.id)).toBeVisible()

    // Drag from backlog directly to in_progress (skipping todo)
    await dragIssueToColumn(page, issue.id, "in_progress")

    const ipCol = page.locator('[data-testid="column-in_progress"]')
    await expect(ipCol.getByText(issue.title)).toBeVisible({ timeout: 5_000 })

    // Kernel confirms final status
    const updated = await kernel.getIssue(issue.id)
    expect(updated.status).toBe("in_progress")

    // Events include both intermediate steps
    const events = await kernel.getEvents(issue.id)
    const statusChanges = events.filter((e) => e.event_type === "status_changed")
    expect(statusChanges.length).toBe(2) // backlog→todo, todo→in_progress
  })

  test("header shows project key and issue count", async ({
    page,
    kernel,
    seedProject,
  }) => {
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Header count A",
    })
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Header count B",
    })

    await page.goto("/")
    await selectProject(page, seedProject.key)

    await expect(page.getByText("Header count A")).toBeVisible()
    await expect(
      page.getByText(`${seedProject.key} / 2 issues`)
    ).toBeVisible()
  })

  test("creates issue via NEW ISSUE button and dialog", async ({
    page,
    kernel,
    seedProject,
  }) => {
    await page.goto("/")
    await selectProject(page, seedProject.key)

    // Open dialog
    await page.getByRole("button", { name: "+ NEW ISSUE" }).click()

    const dialog = page.locator('[data-testid="create-issue-dialog"]')
    await expect(dialog).toBeVisible()

    // Fill fields
    await dialog
      .getByPlaceholder("What needs to be done?")
      .fill("New acceptance test issue")
    await dialog
      .getByPlaceholder("Details, context, acceptance criteria...")
      .fill("Created by Playwright")
    // Set priority to high
    await dialog.getByText("HI").click()
    // Labels
    await dialog.getByPlaceholder("bug, frontend, auth").fill("test, e2e")

    // Submit
    await dialog.getByRole("button", { name: "CREATE ISSUE" }).click()

    // Success toast
    await expect(page.getByText(/Created .+-1/)).toBeVisible()

    // Card in backlog
    const backlogCol = page.locator('[data-testid="column-backlog"]')
    await expect(
      backlogCol.getByText("New acceptance test issue")
    ).toBeVisible()
  })

  test("NEW ISSUE button is disabled when no project selected", async ({
    page,
  }) => {
    await page.goto("/")
    const btn = page.getByRole("button", { name: "+ NEW ISSUE" })
    await expect(btn).toBeDisabled()
  })
})
