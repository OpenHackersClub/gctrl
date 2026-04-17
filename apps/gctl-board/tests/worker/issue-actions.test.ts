/**
 * Worker issue actions tests — move, assign, comment, link-session.
 * Validates D1 batch operations (multi-statement atomicity) and
 * JSON array accumulation in the Workers runtime.
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

describe("Issue move (status transitions + events)", () => {
  let project: SeededProject

  beforeAll(async () => {
    project = await runTest(seedProject("Move Tests", "MOV"))
  })

  it("moves issue and creates status_changed event", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Movable issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        const moveRes = yield* client.post(
          `${HOST}/api/board/issues/${issueId}/move`,
          { body: HttpBody.unsafeJson({ status: "in_progress" }) },
        )
        expect(moveRes.status).toBe(200)

        const moved = (yield* moveRes.json) as Record<string, unknown>
        expect(moved.status).toBe("in_progress")

        const eventsRes = yield* client.get(
          `${HOST}/api/board/issues/${issueId}/events`,
        )
        expect(eventsRes.status).toBe(200)

        const events = (yield* eventsRes.json) as Array<{
          event_type: string
          data: { from?: string; to?: string }
        }>
        const statusEvent = events.find((e) => e.event_type === "status_changed")
        expect(statusEvent).toBeDefined()
        expect(statusEvent!.data.from).toBe("backlog")
        expect(statusEvent!.data.to).toBe("in_progress")
      }),
    ))

  it("rejects move without status", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "No status issue")
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(
          `${HOST}/api/board/issues/${issue.id}/move`,
          { body: HttpBody.unsafeJson({}) },
        )
        expect(res.status).toBe(400)
      }),
    ))

  it("returns 404 for nonexistent issue", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(`${HOST}/api/board/issues/NOPE-1/move`, {
          body: HttpBody.unsafeJson({ status: "done" }),
        })
        expect(res.status).toBe(404)
      }),
    ))
})

describe("Issue assign + events", () => {
  let project: SeededProject

  beforeAll(async () => {
    project = await runTest(seedProject("Assign Tests", "ASG"))
  })

  it("assigns issue and creates assigned event", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Assignable issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        const res = yield* client.post(
          `${HOST}/api/board/issues/${issueId}/assign`,
          {
            body: HttpBody.unsafeJson({
              assignee_id: "agent-1",
              assignee_name: "Claude",
              assignee_type: "agent",
            }),
          },
        )
        expect(res.status).toBe(200)

        const assigned = (yield* res.json) as Record<string, unknown>
        expect(assigned.assignee_id).toBe("agent-1")
        expect(assigned.assignee_name).toBe("Claude")
        expect(assigned.assignee_type).toBe("agent")

        const eventsRes = yield* client.get(
          `${HOST}/api/board/issues/${issueId}/events`,
        )
        const events = (yield* eventsRes.json) as Array<{
          event_type: string
          data: { assignee_id?: string }
        }>
        const assignEvent = events.find((e) => e.event_type === "assigned")
        expect(assignEvent).toBeDefined()
        expect(assignEvent!.data.assignee_id).toBe("agent-1")
      }),
    ))

  it("rejects assign without assignee_id", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "No assignee")
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(
          `${HOST}/api/board/issues/${issue.id}/assign`,
          { body: HttpBody.unsafeJson({ assignee_name: "Nobody" }) },
        )
        expect(res.status).toBe(400)
      }),
    ))
})

describe("Comments + events", () => {
  let project: SeededProject

  beforeAll(async () => {
    project = await runTest(seedProject("Comment Tests", "CMT"))
  })

  it("adds a comment and returns 204", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Commentable issue")
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(
          `${HOST}/api/board/issues/${issue.id}/comment`,
          {
            body: HttpBody.unsafeJson({
              author_id: "user-1",
              author_name: "Alice",
              body: "First comment",
            }),
          },
        )
        expect(res.status).toBe(204)
      }),
    ))

  it("lists multiple comments in chronological order with events", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Multi-comment issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        yield* client.post(`${HOST}/api/board/issues/${issueId}/comment`, {
          body: HttpBody.unsafeJson({
            author_id: "user-1",
            author_name: "Alice",
            body: "First",
          }),
        })
        yield* client.post(`${HOST}/api/board/issues/${issueId}/comment`, {
          body: HttpBody.unsafeJson({
            author_id: "agent-1",
            author_name: "Claude",
            author_type: "agent",
            body: "Second",
          }),
        })

        const res = yield* client.get(
          `${HOST}/api/board/issues/${issueId}/comments`,
        )
        expect(res.status).toBe(200)
        const comments = (yield* res.json) as Array<{
          author_name: string
          body: string
          issue_id: string
        }>
        expect(comments.length).toBe(2)
        expect(comments[0].body).toBe("First")
        expect(comments[1].body).toBe("Second")
        expect(comments[1].author_name).toBe("Claude")

        const eventsRes = yield* client.get(
          `${HOST}/api/board/issues/${issueId}/events`,
        )
        const events = (yield* eventsRes.json) as Array<{
          event_type: string
          data: { comment_id?: string }
        }>
        const commentEvents = events.filter(
          (e) => e.event_type === "comment_added",
        )
        expect(commentEvents.length).toBe(2)
        expect(commentEvents[0].data.comment_id).toBeDefined()
      }),
    ))

  it("rejects comment without body", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "No body issue")
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(
          `${HOST}/api/board/issues/${issue.id}/comment`,
          { body: HttpBody.unsafeJson({ author_id: "user-1" }) },
        )
        expect(res.status).toBe(400)
      }),
    ))
})

describe("Link session (JSON array accumulation)", () => {
  let project: SeededProject

  beforeAll(async () => {
    project = await runTest(seedProject("Session Tests", "SES"))
  })

  it("links a session with cost and tokens", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Trackable issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        const res = yield* client.post(
          `${HOST}/api/board/issues/${issueId}/link-session`,
          {
            body: HttpBody.unsafeJson({
              session_id: "sess-001",
              cost_usd: 1.5,
              tokens: 5000,
            }),
          },
        )
        expect(res.status).toBe(204)

        const issueRes = yield* client.get(
          `${HOST}/api/board/issues/${issueId}`,
        )
        const updated = (yield* issueRes.json) as Record<string, unknown>
        expect(updated.session_ids).toEqual(["sess-001"])
        expect(updated.total_cost_usd).toBe(1.5)
        expect(updated.total_tokens).toBe(5000)
      }),
    ))

  it("accumulates cost/tokens across multiple sessions", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Multi-session issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        yield* client.post(
          `${HOST}/api/board/issues/${issueId}/link-session`,
          {
            body: HttpBody.unsafeJson({
              session_id: "sess-001",
              cost_usd: 1.5,
              tokens: 5000,
            }),
          },
        )
        yield* client.post(
          `${HOST}/api/board/issues/${issueId}/link-session`,
          {
            body: HttpBody.unsafeJson({
              session_id: "sess-002",
              cost_usd: 0.75,
              tokens: 2500,
            }),
          },
        )

        const res = yield* client.get(`${HOST}/api/board/issues/${issueId}`)
        const updated = (yield* res.json) as Record<string, unknown>
        expect(updated.session_ids).toEqual(["sess-001", "sess-002"])
        expect(updated.total_cost_usd).toBe(2.25)
        expect(updated.total_tokens).toBe(7500)
      }),
    ))

  it("deduplicates session IDs but still accumulates cost", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "Dedup issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        yield* client.post(
          `${HOST}/api/board/issues/${issueId}/link-session`,
          {
            body: HttpBody.unsafeJson({
              session_id: "sess-001",
              cost_usd: 1.0,
              tokens: 3000,
            }),
          },
        )
        yield* client.post(
          `${HOST}/api/board/issues/${issueId}/link-session`,
          {
            body: HttpBody.unsafeJson({
              session_id: "sess-001",
              cost_usd: 0.5,
              tokens: 1000,
            }),
          },
        )

        const res = yield* client.get(`${HOST}/api/board/issues/${issueId}`)
        const updated = (yield* res.json) as Record<string, unknown>
        expect(updated.session_ids).toEqual(["sess-001"])
        expect(updated.total_cost_usd).toBe(1.5)
        expect(updated.total_tokens).toBe(4000)
      }),
    ))

  it("rejects link without session_id", () =>
    runTest(
      Effect.gen(function* () {
        const issue = yield* seedIssue(project.id, "No session")
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(
          `${HOST}/api/board/issues/${issue.id}/link-session`,
          { body: HttpBody.unsafeJson({ cost_usd: 1.0 }) },
        )
        expect(res.status).toBe(400)
      }),
    ))

  it("returns 404 for nonexistent issue", () =>
    runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const res = yield* client.post(
          `${HOST}/api/board/issues/NOPE-1/link-session`,
          { body: HttpBody.unsafeJson({ session_id: "sess-x" }) },
        )
        expect(res.status).toBe(404)
      }),
    ))
})

describe("Events", () => {
  it("lists events with parsed JSON data column", () =>
    runTest(
      Effect.gen(function* () {
        const project = yield* seedProject("Event Tests", "EVT")
        const issue = yield* seedIssue(project.id, "Event issue")
        const issueId = issue.id as string
        const client = yield* HttpClient.HttpClient

        yield* client.post(`${HOST}/api/board/issues/${issueId}/move`, {
          body: HttpBody.unsafeJson({ status: "todo" }),
        })

        const res = yield* client.get(
          `${HOST}/api/board/issues/${issueId}/events`,
        )
        expect(res.status).toBe(200)

        const events = (yield* res.json) as Array<{
          event_type: string
          data: unknown
          issue_id: string
        }>
        expect(events.length).toBe(2)

        const statusEvent = events.find((e) => e.event_type === "status_changed")!
        expect(typeof statusEvent.data).toBe("object")
        expect((statusEvent.data as Record<string, string>).from).toBe("backlog")
        expect((statusEvent.data as Record<string, string>).to).toBe("todo")

        for (const e of events) {
          expect(e.issue_id).toBe(issueId)
        }
      }),
    ))
})
