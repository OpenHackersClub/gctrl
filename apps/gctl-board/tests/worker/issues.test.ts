/**
 * Worker issue CRUD tests — run inside Miniflare V8 isolate via
 * @cloudflare/vitest-pool-workers, validating D1 batch operations,
 * JSON column parsing, and auto-incrementing issue IDs.
 *
 * Uses @effect/platform HttpClient (wired to SELF.fetch via fixtures/http.ts).
 *
 * Note: vitest-pool-workers isolates D1 state per test (snapshot after
 * beforeAll, reset between each it()). Each test must be self-contained.
 */
import { HttpBody, HttpClient } from "@effect/platform"
import { Effect } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { HOST, runTest } from "./fixtures/http"
import { seedIssue, seedProject, type SeededProject } from "./fixtures/seed"

describe("Issue CRUD (D1 batch operations)", () => {
  let project: SeededProject

  beforeAll(async () => {
    project = await runTest(seedProject("Issue Tests", "ISS"))
  })

  // ── Create ──

  it("creates issue with auto-incremented ID", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "First issue")
        expect(issue.id).toBe("ISS-1")
        expect(issue.title).toBe("First issue")
        expect(issue.status).toBe("backlog")
        expect(issue.priority).toBe("none")
        expect(issue.project_id).toBe(project.id)
      }),
    ))

  it("increments counter across multiple issues", () =>
    runTest(
      Effect.gen(function* () {
        const issue1 = yield* seedIssue(project.id, "Issue A")
        const issue2 = yield* seedIssue(project.id, "Issue B")
        expect(issue1.id).toBe("ISS-1")
        expect(issue2.id).toBe("ISS-2")
      }),
    ))

  it("creates issue with labels as parsed JSON array", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Labeled issue", {
          labels: ["bug", "urgent"],
        })
        expect(issue.labels).toEqual(["bug", "urgent"])
      }),
    ))

  it("creates issue with description and priority", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Detailed issue", {
          description: "Some description",
          priority: "high",
        })
        expect(issue.description).toBe("Some description")
        expect(issue.priority).toBe("high")
      }),
    ))

  it("rejects issue without project_id", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/board/issues`, {
          body: HttpBody.unsafeJson({ title: "No project" }),
        })
        expect(res.status).toBe(400)
      }),
    ))

  it("rejects issue without title", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/board/issues`, {
          body: HttpBody.unsafeJson({ project_id: project.id }),
        })
        expect(res.status).toBe(400)
      }),
    ))

  it("rejects issue with nonexistent project", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/board/issues`, {
          body: HttpBody.unsafeJson({ project_id: "nonexistent", title: "Ghost" }),
        })
        expect(res.status).toBe(404)
      }),
    ))

  // ── Read ──

  it("GET /api/board/issues/:id returns parsed JSON columns", () =>
    runTest(
      Effect.gen(function* () {
        const created = yield* seedIssue(project.id, "JSON columns test", {
          labels: ["frontend", "a11y"],
        })
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/issues/${created.id}`)
        expect(res.status).toBe(200)

        const issue = (yield* res.json) as Record<string, unknown>
        expect(issue.labels).toEqual(["frontend", "a11y"])
        expect(issue.session_ids).toEqual([])
        expect(issue.pr_numbers).toEqual([])
        expect(issue.blocked_by).toEqual([])
        expect(issue.blocking).toEqual([])
        expect(issue.acceptance_criteria).toEqual([])
      }),
    ))

  it("GET /api/board/issues/:id returns 404 for missing issue", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/issues/NOPE-999`)
        expect(res.status).toBe(404)
      }),
    ))

  // ── List with filters ──

  it("GET /api/board/issues?project_id= filters by project", () =>
    runTest(
      Effect.gen(function* () {
        const other = yield* seedProject("Other Project", "OTH")
        yield* seedIssue(project.id, "ISS issue")
        yield* seedIssue(other.id, "OTH issue")

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(
          `${HOST}/api/board/issues?project_id=${project.id}`,
        )
        expect(res.status).toBe(200)
        const issues = (yield* res.json) as Array<{ project_id: string }>
        expect(issues.length).toBe(1)
        expect(issues[0].project_id).toBe(project.id)
      }),
    ))

  it("GET /api/board/issues?status= filters by status", () =>
    runTest(
      Effect.gen(function* () {
        yield* seedIssue(project.id, "Backlog issue")

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/issues?status=backlog`)
        expect(res.status).toBe(200)
        const issues = (yield* res.json) as Array<{ status: string }>
        expect(issues.length).toBeGreaterThan(0)
        for (const i of issues) {
          expect(i.status).toBe("backlog")
        }
      }),
    ))

  it("GET /api/board/issues?label= filters by label (fuzzy)", () =>
    runTest(
      Effect.gen(function* () {
        yield* seedIssue(project.id, "Bug fix", { labels: ["bug", "p1"] })
        yield* seedIssue(project.id, "Feature", { labels: ["enhancement"] })

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/issues?label=bug`)
        expect(res.status).toBe(200)
        const issues = (yield* res.json) as Array<{ labels: string[] }>
        expect(issues.length).toBe(1)
        expect(issues[0].labels).toContain("bug")
      }),
    ))
})
