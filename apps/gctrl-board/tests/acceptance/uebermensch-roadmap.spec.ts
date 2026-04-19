/**
 * Uebermensch Roadmap — acceptance tests
 *
 * Demonstrates that gctrl-board hosts the uebermensch product roadmap
 * via the **vault-first / markdown-sync** path — no HTTP coupling from
 * uebermensch to the board. uebermensch writes markdown to its vault;
 * gctrl-board imports it via `/api/board/import` (see
 * apps/gctrl-board/tests/acceptance/markdown-sync.spec.ts for the
 * import contract).
 *
 * Covered:
 *  - Roadmap items (M0/M1/M2 milestones) seeded as a vault folder of
 *    `.md` files, then imported into a `UBER` project.
 *  - User drags items across kanban columns and the kernel reflects
 *    each transition.
 *  - "Convert brief item to action" simulated by writing a single
 *    issue `.md` (shape uebermensch would emit) and re-importing.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  test,
  expect,
  selectProject,
  dragIssueToColumn,
} from "./fixtures/test"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uber-vault-"))
}

function issueMarkdown(input: {
  key: string
  num: number
  title: string
  status: string
  priority: string
  labels: string[]
  body: string
  createdBy?: string
}): string {
  return `---
id: ${input.key}-${input.num}
project: ${input.key}
status: ${input.status}
priority: ${input.priority}
labels: [${input.labels.join(", ")}]
created_by: ${input.createdBy ?? "uebermensch"}
---

# ${input.title}

${input.body}
`
}

const ROADMAP = [
  {
    num: 1,
    title: "M0 — runnable slice: profile validate + stub brief",
    status: "in_progress",
    priority: "high",
    labels: ["m0"],
    body: "Profile schema + `uber profile validate` + stub `uber brief`.",
  },
  {
    num: 2,
    title: "M1 — vault-first BriefingService writes daily brief markdown",
    status: "todo",
    priority: "high",
    labels: ["m1", "vault"],
    body: "BriefingService renders to `$UBER_VAULT_DIR/briefs/<date>.md`.",
  },
  {
    num: 3,
    title: "M2 — DelivererService fan-out: App + Telegram + Discord",
    status: "backlog",
    priority: "medium",
    labels: ["m2", "delivery"],
    body: "Channel router + per-channel renderers.",
  },
] as const

function uberKey(): string {
  return `UBER${Date.now().toString(36).slice(-4).toUpperCase()}`
}

test.describe("Uebermensch Roadmap on gctrl-board", () => {
  test("imports vault markdown into UBER project, items land in correct columns", async ({
    page,
    kernel,
  }) => {
    const project = await kernel.createProject("Uebermensch", uberKey())

    const dir = tmpDir()
    try {
      for (const r of ROADMAP) {
        fs.writeFileSync(
          path.join(dir, `${project.key}-${r.num}.md`),
          issueMarkdown({
            key: project.key,
            num: r.num,
            title: r.title,
            status: r.status,
            priority: r.priority,
            labels: [...r.labels],
            body: r.body,
          })
        )
      }

      const result = await kernel.importMarkdown(dir)
      expect(result.imported).toBe(ROADMAP.length)
      expect(result.skipped).toBe(0)

      await page.goto("/")
      await selectProject(page, project.key)

      await expect(
        page.getByText(`${project.key} / ${ROADMAP.length} issues`)
      ).toBeVisible()

      for (const r of ROADMAP) {
        const col = page.locator(`[data-testid="column-${r.status}"]`)
        await expect(col.getByText(r.title)).toBeVisible()
      }
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("user drags roadmap item from backlog to in_progress", async ({
    page,
    kernel,
  }) => {
    const project = await kernel.createProject("Uebermensch", uberKey())

    const dir = tmpDir()
    try {
      const num = 1
      fs.writeFileSync(
        path.join(dir, `${project.key}-${num}.md`),
        issueMarkdown({
          key: project.key,
          num,
          title: "M2 — DelivererService fan-out",
          status: "backlog",
          priority: "high",
          labels: ["m2"],
          body: "Channel router + per-channel renderers.",
        })
      )
      const result = await kernel.importMarkdown(dir)
      expect(result.imported).toBe(1)

      const issueId = `${project.key}-${num}`

      await page.goto("/")
      await selectProject(page, project.key)
      await expect(page.getByText(issueId)).toBeVisible()

      await dragIssueToColumn(page, issueId, "in_progress")

      const ipCol = page.locator('[data-testid="column-in_progress"]')
      await expect(ipCol.getByText("M2 — DelivererService fan-out")).toBeVisible({ timeout: 5_000 })

      const updated = await kernel.getIssue(issueId)
      expect(updated.status).toBe("in_progress")
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("'convert brief item to action' = uebermensch writes one .md, board imports it", async ({
    page,
    kernel,
  }) => {
    // Vault-first: uebermensch's "convert to action" writes a single
    // issue file into the vault — gctrl-board picks it up via markdown
    // import. No HTTP coupling between uebermensch and the board.
    const project = await kernel.createProject("Uebermensch", uberKey())

    const dir = tmpDir()
    try {
      const num = 42
      fs.writeFileSync(
        path.join(dir, `${project.key}-${num}.md`),
        issueMarkdown({
          key: project.key,
          num,
          title: "Follow up with thesis: LLM tooling consolidation",
          status: "backlog",
          priority: "medium",
          labels: ["from-brief"],
          body: "Captured from morning brief 2026-04-19, item #2.",
          createdBy: "uebermensch",
        })
      )

      const imported = await kernel.importMarkdown(dir)
      expect(imported.imported).toBe(1)

      const issueId = `${project.key}-${num}`
      const created = await kernel.getIssue(issueId)
      expect(created.status).toBe("backlog")
      expect(created.created_by_id).toBe("uebermensch")

      await page.goto("/")
      await selectProject(page, project.key)

      const backlogCol = page.locator('[data-testid="column-backlog"]')
      await expect(backlogCol.getByText(created.title)).toBeVisible()

      // User triages the imported action across the roadmap
      await dragIssueToColumn(page, issueId, "todo")
      const todoCol = page.locator('[data-testid="column-todo"]')
      await expect(todoCol.getByText(created.title)).toBeVisible({ timeout: 5_000 })

      const persisted = await kernel.getIssue(issueId)
      expect(persisted.status).toBe("todo")
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})
