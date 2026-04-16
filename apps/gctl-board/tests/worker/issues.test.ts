/**
 * Worker issue CRUD tests — run inside Miniflare V8 isolate via
 * @cloudflare/vitest-pool-workers, validating D1 batch operations,
 * JSON column parsing, and auto-incrementing issue IDs.
 *
 * Note: vitest-pool-workers isolates D1 state per test (snapshot after
 * beforeAll, reset between each it()). Each test must be self-contained.
 */
import { SELF } from "cloudflare:test"
import { describe, it, expect, beforeAll } from "vitest"

const HOST = "http://fake-host"

async function seedProject(name: string, key: string) {
  const res = await SELF.fetch(`${HOST}/api/board/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, key }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; key: string; counter: number }
}

async function seedIssue(projectId: string, title: string, extra?: Record<string, unknown>) {
  const res = await SELF.fetch(`${HOST}/api/board/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      title,
      created_by_id: "user-1",
      created_by_name: "Alice",
      created_by_type: "human",
      ...extra,
    }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as Record<string, unknown>
}

describe("Issue CRUD (D1 batch operations)", () => {
  let project: { id: string; key: string }

  beforeAll(async () => {
    project = await seedProject("Issue Tests", "ISS")
  })

  // ── Create ──

  it("creates issue with auto-incremented ID", async () => {
    const issue = await seedIssue(project.id, "First issue")

    expect(issue.id).toBe("ISS-1")
    expect(issue.title).toBe("First issue")
    expect(issue.status).toBe("backlog")
    expect(issue.priority).toBe("none")
    expect(issue.project_id).toBe(project.id)
  })

  it("increments counter across multiple issues", async () => {
    // Each test starts from beforeAll snapshot (counter=0)
    const issue1 = await seedIssue(project.id, "Issue A")
    const issue2 = await seedIssue(project.id, "Issue B")

    expect(issue1.id).toBe("ISS-1")
    expect(issue2.id).toBe("ISS-2")
  })

  it("creates issue with labels as parsed JSON array", async () => {
    const issue = await seedIssue(project.id, "Labeled issue", {
      labels: ["bug", "urgent"],
    })

    expect(issue.labels).toEqual(["bug", "urgent"])
  })

  it("creates issue with description and priority", async () => {
    const issue = await seedIssue(project.id, "Detailed issue", {
      description: "Some description",
      priority: "high",
    })

    expect(issue.description).toBe("Some description")
    expect(issue.priority).toBe("high")
  })

  it("rejects issue without project_id", async () => {
    const res = await SELF.fetch(`${HOST}/api/board/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No project" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects issue without title", async () => {
    const res = await SELF.fetch(`${HOST}/api/board/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: project.id }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects issue with nonexistent project", async () => {
    const res = await SELF.fetch(`${HOST}/api/board/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "nonexistent", title: "Ghost" }),
    })
    expect(res.status).toBe(404)
  })

  // ── Read ──

  it("GET /api/board/issues/:id returns parsed JSON columns", async () => {
    const created = await seedIssue(project.id, "JSON columns test", {
      labels: ["frontend", "a11y"],
    })
    const res = await SELF.fetch(`${HOST}/api/board/issues/${created.id}`)
    expect(res.status).toBe(200)

    const issue = (await res.json()) as Record<string, unknown>
    expect(issue.labels).toEqual(["frontend", "a11y"])
    expect(issue.session_ids).toEqual([])
    expect(issue.pr_numbers).toEqual([])
    expect(issue.blocked_by).toEqual([])
    expect(issue.blocking).toEqual([])
    expect(issue.acceptance_criteria).toEqual([])
  })

  it("GET /api/board/issues/:id returns 404 for missing issue", async () => {
    const res = await SELF.fetch(`${HOST}/api/board/issues/NOPE-999`)
    expect(res.status).toBe(404)
  })

  // ── List with filters ──

  it("GET /api/board/issues?project_id= filters by project", async () => {
    // Seed issues in two different projects within this test
    const other = await seedProject("Other Project", "OTH")
    await seedIssue(project.id, "ISS issue")
    await seedIssue(other.id, "OTH issue")

    const res = await SELF.fetch(`${HOST}/api/board/issues?project_id=${project.id}`)
    expect(res.status).toBe(200)
    const issues = (await res.json()) as Array<{ project_id: string }>
    expect(issues.length).toBe(1)
    expect(issues[0].project_id).toBe(project.id)
  })

  it("GET /api/board/issues?status= filters by status", async () => {
    await seedIssue(project.id, "Backlog issue")

    const res = await SELF.fetch(`${HOST}/api/board/issues?status=backlog`)
    expect(res.status).toBe(200)
    const issues = (await res.json()) as Array<{ status: string }>
    expect(issues.length).toBeGreaterThan(0)
    for (const i of issues) {
      expect(i.status).toBe("backlog")
    }
  })

  it("GET /api/board/issues?label= filters by label (fuzzy)", async () => {
    // Seed a labeled issue within this test
    await seedIssue(project.id, "Bug fix", { labels: ["bug", "p1"] })
    await seedIssue(project.id, "Feature", { labels: ["enhancement"] })

    const res = await SELF.fetch(`${HOST}/api/board/issues?label=bug`)
    expect(res.status).toBe(200)
    const issues = (await res.json()) as Array<{ labels: string[] }>
    expect(issues.length).toBe(1)
    expect(issues[0].labels).toContain("bug")
  })
})
