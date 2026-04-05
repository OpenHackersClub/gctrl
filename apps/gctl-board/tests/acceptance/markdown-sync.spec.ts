/**
 * Markdown Sync — acceptance tests
 *
 * Validates bidirectional sync between markdown issue files and the kernel.
 * Tests export (DuckDB → markdown), import (markdown → DuckDB), roundtrip,
 * content_hash change detection, and UI reflection of imported changes.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { test, expect, selectProject } from "./fixtures/test"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gctl-board-md-"))
}

test.describe("Markdown Sync", () => {
  test("export writes markdown files with YAML frontmatter", async ({
    kernel,
    seedProject,
  }) => {
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Export test issue",
      description: "Should appear in markdown body",
      priority: "high",
      labels: ["test", "export"],
    })

    const dir = tmpDir()
    try {
      const result = await kernel.exportMarkdown(dir, seedProject.id)
      expect(result.exported).toBe(1)
      expect(result.files).toHaveLength(1)

      const filePath = path.join(dir, result.files[0])
      const content = fs.readFileSync(filePath, "utf-8")

      // Verify YAML frontmatter
      expect(content).toContain("---")
      expect(content).toMatch(/id: .+-1/)
      expect(content).toContain(`project: ${seedProject.key}`)
      expect(content).toContain("status: backlog")
      expect(content).toContain("priority: high")
      expect(content).toContain("labels: [test, export]")

      // Verify markdown body
      expect(content).toContain("# Export test issue")
      expect(content).toContain("Should appear in markdown body")
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("import creates issues from markdown files", async ({
    kernel,
    seedProject,
  }) => {
    const dir = tmpDir()
    try {
      const md = `---
id: ${seedProject.key}-99
project: ${seedProject.key}
status: todo
priority: medium
labels: [imported, markdown]
created_by: test-harness
---

# Imported from markdown

This issue was created from a markdown file.
`
      fs.writeFileSync(path.join(dir, `${seedProject.key}-99.md`), md)

      const result = await kernel.importMarkdown(dir)
      expect(result.imported).toBe(1)
      expect(result.skipped).toBe(0)

      // Verify issue exists in kernel
      const issue = await kernel.getIssue(`${seedProject.key}-99`)
      expect(issue.title).toBe("Imported from markdown")
      expect(issue.status).toBe("todo")
      expect(issue.priority).toBe("medium")
      expect(issue.labels).toEqual(["imported", "markdown"])
      expect(issue.description).toContain(
        "This issue was created from a markdown file."
      )
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("import skips unchanged files (content_hash match)", async ({
    kernel,
    seedProject,
  }) => {
    const dir = tmpDir()
    try {
      const md = `---
id: ${seedProject.key}-50
project: ${seedProject.key}
status: backlog
priority: low
created_by: test-harness
---

# Unchanged issue
`
      fs.writeFileSync(path.join(dir, `${seedProject.key}-50.md`), md)

      // First import
      const first = await kernel.importMarkdown(dir)
      expect(first.imported).toBe(1)

      // Second import — same content, should skip
      const second = await kernel.importMarkdown(dir)
      expect(second.skipped).toBe(1)
      expect(second.imported).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("import detects content changes and updates", async ({
    kernel,
    seedProject,
  }) => {
    const dir = tmpDir()
    const filePath = path.join(dir, `${seedProject.key}-60.md`)
    try {
      // Create initial version
      fs.writeFileSync(
        filePath,
        `---
id: ${seedProject.key}-60
project: ${seedProject.key}
status: backlog
priority: low
created_by: test-harness
---

# Original title
`
      )
      await kernel.importMarkdown(dir)

      const before = await kernel.getIssue(`${seedProject.key}-60`)
      expect(before.priority).toBe("low")

      // Edit file — change priority
      fs.writeFileSync(
        filePath,
        `---
id: ${seedProject.key}-60
project: ${seedProject.key}
status: backlog
priority: urgent
created_by: test-harness
---

# Original title
`
      )
      const result = await kernel.importMarkdown(dir)
      expect(result.imported).toBe(1)
      expect(result.skipped).toBe(0)

      const after = await kernel.getIssue(`${seedProject.key}-60`)
      expect(after.priority).toBe("urgent")
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("export then import roundtrip preserves data", async ({
    kernel,
    seedProject,
  }) => {
    // Create issues via kernel
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Roundtrip issue A",
      description: "Description A",
      priority: "high",
      labels: ["alpha"],
    })
    await kernel.createIssue({
      project_id: seedProject.id,
      title: "Roundtrip issue B",
      priority: "low",
      labels: ["beta", "gamma"],
    })

    const dir = tmpDir()
    try {
      // Export
      const exported = await kernel.exportMarkdown(dir, seedProject.id)
      expect(exported.exported).toBe(2)

      // Import into same kernel — should skip (unchanged)
      const imported = await kernel.importMarkdown(dir)
      expect(imported.total).toBe(2)
      // Both should skip since content matches what was just exported
      // (content_hash was set on export-side issues)

      // Verify issues still correct
      const issues = await kernel.listIssues({
        project_id: seedProject.id,
      })
      expect(issues).toHaveLength(2)
      const titles = issues.map((i) => i.title).sort()
      expect(titles).toEqual(["Roundtrip issue A", "Roundtrip issue B"])
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("imported markdown issue appears on kanban board", async ({
    page,
    kernel,
    seedProject,
  }) => {
    const dir = tmpDir()
    try {
      // Create issue via markdown import
      const md = `---
id: ${seedProject.key}-77
project: ${seedProject.key}
status: backlog
priority: high
labels: [ui-test]
created_by: markdown-author
---

# Issue from markdown file

Created outside the web UI.
`
      fs.writeFileSync(path.join(dir, `${seedProject.key}-77.md`), md)
      await kernel.importMarkdown(dir)

      // Open board and verify the issue appears
      await page.goto("/")
      await selectProject(page, seedProject.key)

      const backlogCol = page.locator('[data-testid="column-backlog"]')
      await expect(
        backlogCol.getByText("Issue from markdown file")
      ).toBeVisible()
      await expect(page.getByText(`${seedProject.key}-77`)).toBeVisible()
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  test("web UI changes reflected in subsequent export", async ({
    page,
    kernel,
    seedProject,
  }) => {
    // Create issue via kernel
    const issue = await kernel.createIssue({
      project_id: seedProject.id,
      title: "Will be moved via UI",
      priority: "medium",
    })

    // Move to todo via kernel (simulating UI drag)
    await kernel.moveIssue(issue.id, "todo")

    // Export and verify status in markdown
    const dir = tmpDir()
    try {
      await kernel.exportMarkdown(dir, seedProject.id)
      const content = fs.readFileSync(
        path.join(dir, `${issue.id}.md`),
        "utf-8"
      )
      expect(content).toContain("status: todo")
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})
