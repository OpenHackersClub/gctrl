/**
 * Gantt API tests — PATCH /schedule and GET /projects/:id/gantt.
 *
 * Mirrors the spec in apps/gctrl-board/vault/specs/gantt.md:
 *  - start_date <= due_date validated
 *  - null clears a field (other is preserved)
 *  - emits issue_events with event_type="scheduled"
 *  - range = raw min/max over scheduled dates
 *  - unscheduled issues returned with null dates
 */
import { HttpBody, HttpClient } from "@effect/platform"
import { Effect } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { HOST, runTest } from "./fixtures/http"
import { seedIssue, seedProject, type SeededProject } from "./fixtures/seed"

const schedule = (id: string, body: { start_date?: string | null; due_date?: string | null }) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.patch(`${HOST}/api/board/issues/${id}/schedule`, {
      body: HttpBody.unsafeJson(body),
    })
  })

describe("PATCH /api/board/issues/:id/schedule", () => {
  let project: SeededProject

  beforeAll(async () => {
    project = await runTest(seedProject("Gantt Tests", "GNT"))
  })

  it("sets both start_date and due_date", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Schedule me")
        const res = yield* schedule(issue.id as string, {
          start_date: "2026-05-01",
          due_date: "2026-05-14",
        })
        expect(res.status).toBe(200)
        const body = (yield* res.json) as Record<string, unknown>
        expect(body.start_date).toBe("2026-05-01")
        expect(body.due_date).toBe("2026-05-14")
      }),
    ))

  it("rejects start_date > due_date with 400", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Invalid dates")
        const res = yield* schedule(issue.id as string, {
          start_date: "2026-05-14",
          due_date: "2026-05-01",
        })
        expect(res.status).toBe(400)
      }),
    ))

  it("rejects malformed date string with 400", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Bad date format")
        const res = yield* schedule(issue.id as string, {
          start_date: "not-a-date",
        })
        expect(res.status).toBe(400)
      }),
    ))

  it("null clears only the specified field", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Partial clear")
        yield* schedule(issue.id as string, {
          start_date: "2026-05-01",
          due_date: "2026-05-14",
        })
        const res = yield* schedule(issue.id as string, { start_date: null })
        expect(res.status).toBe(200)
        const body = (yield* res.json) as Record<string, unknown>
        expect(body.start_date).toBeNull()
        expect(body.due_date).toBe("2026-05-14")
      }),
    ))

  it("accepts due_date alone (start defaults to null)", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Due only")
        const res = yield* schedule(issue.id as string, { due_date: "2026-06-01" })
        expect(res.status).toBe(200)
        const body = (yield* res.json) as Record<string, unknown>
        expect(body.start_date).toBeNull()
        expect(body.due_date).toBe("2026-06-01")
      }),
    ))

  it("rejects empty body", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Empty schedule")
        const res = yield* schedule(issue.id as string, {})
        expect(res.status).toBe(400)
      }),
    ))

  it("returns 404 for missing issue", () =>
    runTest(
      Effect.gen(function* () {
        const res = yield* schedule("NOPE-999", { start_date: "2026-05-01" })
        expect(res.status).toBe(404)
      }),
    ))

  it("emits an issue_events row with event_type=scheduled", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Emits event")
        yield* schedule(issue.id as string, {
          start_date: "2026-05-01",
          due_date: "2026-05-14",
        })
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/issues/${issue.id}/events`)
        const events = (yield* res.json) as Array<{ event_type: string; data: unknown }>
        const scheduled = events.find((e) => e.event_type === "scheduled")
        expect(scheduled).toBeDefined()
        expect(scheduled!.data).toEqual({
          start_date: "2026-05-01",
          due_date: "2026-05-14",
        })
      }),
    ))
})

describe("GET /api/board/projects/:id/gantt", () => {
  it("returns raw min/max range over scheduled issues", () =>
    runTest(
      Effect.gen(function* () {
        const project = yield* seedProject("Range Test", "RNG")
        const a = yield* seedIssue(project.id, "A")
        const b = yield* seedIssue(project.id, "B")
        yield* schedule(a.id as string, { start_date: "2026-05-01", due_date: "2026-05-10" })
        yield* schedule(b.id as string, { start_date: "2026-06-01", due_date: "2026-06-15" })

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/projects/${project.id}/gantt`)
        expect(res.status).toBe(200)
        const body = (yield* res.json) as {
          range: { min: string | null; max: string | null }
          issues: Array<Record<string, unknown>>
        }
        expect(body.range.min).toBe("2026-05-01")
        expect(body.range.max).toBe("2026-06-15")
        expect(body.issues.length).toBe(2)
      }),
    ))

  it("returns unscheduled issues with null dates", () =>
    runTest(
      Effect.gen(function* () {
        const project = yield* seedProject("Unscheduled Test", "UNS")
        yield* seedIssue(project.id, "No dates")

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/projects/${project.id}/gantt`)
        const body = (yield* res.json) as {
          range: { min: string | null; max: string | null }
          issues: Array<Record<string, unknown>>
        }
        expect(body.range.min).toBeNull()
        expect(body.range.max).toBeNull()
        expect(body.issues.length).toBe(1)
        expect(body.issues[0].start_date).toBeNull()
        expect(body.issues[0].due_date).toBeNull()
      }),
    ))

  it("returns 404 for missing project", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/projects/nonexistent/gantt`)
        expect(res.status).toBe(404)
      }),
    ))

  it("mixes scheduled and unscheduled, computes range only over scheduled", () =>
    runTest(
      Effect.gen(function* () {
        const project = yield* seedProject("Mixed", "MIX")
        const a = yield* seedIssue(project.id, "Scheduled")
        yield* seedIssue(project.id, "Unscheduled")
        yield* schedule(a.id as string, { start_date: "2026-05-05", due_date: "2026-05-09" })

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${HOST}/api/board/projects/${project.id}/gantt`)
        const body = (yield* res.json) as {
          range: { min: string | null; max: string | null }
          issues: Array<{ start_date: string | null; due_date: string | null }>
        }
        expect(body.range.min).toBe("2026-05-05")
        expect(body.range.max).toBe("2026-05-09")
        expect(body.issues.length).toBe(2)
        expect(body.issues.some((i) => i.start_date === null)).toBe(true)
      }),
    ))
})
