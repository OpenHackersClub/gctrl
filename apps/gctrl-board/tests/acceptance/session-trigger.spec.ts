/**
 * Session Trigger — acceptance (TDD contract, currently pending).
 *
 * These tests encode the end-to-end drag-to-dispatch flow from
 * [specs/architecture/session-trigger-from-board.md] and
 * [specs/implementation/kernel/session-trigger.md §Tier 4].
 *
 * They are marked `test.fixme` until the implementation lands. The implementer:
 *   1. Replace `test.fixme` with `test` one at a time (red → green).
 *   2. Ensure the local kernel has Slice 1 wired up: promote-on-move,
 *      orchestrator stub tick, `GET /api/sessions?issue_id=X` filter.
 *   3. Run `pnpm exec playwright test session-trigger` — each un-fixme'd
 *      test should first fail (RED), then pass once the backend is done.
 */
import { test, expect, dragIssueToColumn, selectProject } from "./fixtures/test"

test.describe("Session Trigger from Board", () => {
  test.fixme(
    "dragging an Issue to in_progress creates a linked Session",
    async ({ page, kernel, seedProject }) => {
      const issue = await kernel.createIssue({
        project_id: seedProject.id,
        title: "Exercise drag-to-dispatch",
        priority: "high",
      })

      await page.goto("/")
      await selectProject(page, seedProject.key)

      await dragIssueToColumn(page, issue.id, "in_progress")

      // Card must land in the in_progress column
      await expect(
        page
          .locator('[data-testid="column-in_progress"]')
          .locator(`[data-testid="issue-card-${issue.id}"]`)
      ).toBeVisible()

      // Orchestrator stub should create a Session linked to this Issue
      // within a couple of poll ticks (2s tick interval → 5s budget).
      await expect
        .poll(
          async () => {
            const sessions = await kernel.getSessions({ limit: 50 })
            // TODO: once the `issue_id` query-param filter lands, call
            //       kernel.getSessions({ issue_id: issue.id }) instead.
            return sessions.filter(
              (s: { issue_id?: string }) => s.issue_id === issue.id
            ).length
          },
          { timeout: 5_000, intervals: [250, 500, 1_000] }
        )
        .toBeGreaterThanOrEqual(1)
    }
  )

  test.fixme(
    "re-dragging the same Issue does not create a second Task",
    async ({ page, kernel, seedProject }) => {
      const issue = await kernel.createIssue({
        project_id: seedProject.id,
        title: "Idempotent drag",
      })

      await page.goto("/")
      await selectProject(page, seedProject.key)

      await dragIssueToColumn(page, issue.id, "in_progress")
      // Move back then forward again
      await dragIssueToColumn(page, issue.id, "todo")
      await dragIssueToColumn(page, issue.id, "in_progress")

      // Reuse rule: while the Task is still non-terminal, re-promotion
      // MUST reuse the existing row. Exactly one Task linked to the Issue.
      // (Uses raw fetch until kernel test client exposes tasks listing.)
      const tasks = await fetch(
        `${process.env.PREVIEW_URL ?? "http://localhost:14318"}/api/tasks?issue_id=${issue.id}`
      ).then((r) => r.json())
      expect(Array.isArray(tasks) ? tasks.length : 0).toBe(1)
    }
  )

  test.fixme(
    "Issues in projects without WORKFLOW.md do not trigger dispatch",
    async ({ page, kernel, seedProject }) => {
      // seedProject has no WORKFLOW.md; dragging must NOT create a Task,
      // but the Issue move itself must still succeed.
      const issue = await kernel.createIssue({
        project_id: seedProject.id,
        title: "No agent config",
      })

      await page.goto("/")
      await selectProject(page, seedProject.key)

      await dragIssueToColumn(page, issue.id, "in_progress")

      await expect(
        page
          .locator('[data-testid="column-in_progress"]')
          .locator(`[data-testid="issue-card-${issue.id}"]`)
      ).toBeVisible()

      // No session should exist for this issue.
      const sessions = await kernel.getSessions({ limit: 50 })
      const linked = sessions.filter(
        (s: { issue_id?: string }) => s.issue_id === issue.id
      )
      expect(linked.length).toBe(0)
    }
  )
})
