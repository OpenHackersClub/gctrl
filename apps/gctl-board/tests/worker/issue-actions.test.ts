/**
 * Worker issue actions tests — move, assign, comment, link-session.
 * Validates D1 batch operations (multi-statement atomicity) and
 * JSON array accumulation in the Workers runtime.
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
  return (await res.json()) as { id: string; key: string }
}

async function seedIssue(projectId: string, title: string) {
  const res = await SELF.fetch(`${HOST}/api/board/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      title,
      created_by_id: "user-1",
      created_by_name: "Alice",
      created_by_type: "human",
    }),
  })
  return (await res.json()) as Record<string, unknown>
}

describe("Issue move (status transitions + events)", () => {
  let project: { id: string; key: string }

  beforeAll(async () => {
    project = await seedProject("Move Tests", "MOV")
  })

  it("moves issue and creates status_changed event", async () => {
    const issue = await seedIssue(project.id, "Movable issue")
    const issueId = issue.id as string

    const moveRes = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    })
    expect(moveRes.status).toBe(200)

    const moved = (await moveRes.json()) as Record<string, unknown>
    expect(moved.status).toBe("in_progress")

    // Verify event was created with from/to data
    const eventsRes = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/events`)
    expect(eventsRes.status).toBe(200)

    const events = (await eventsRes.json()) as Array<{
      event_type: string
      data: { from?: string; to?: string }
    }>
    const statusEvent = events.find((e) => e.event_type === "status_changed")
    expect(statusEvent).toBeDefined()
    expect(statusEvent!.data.from).toBe("backlog")
    expect(statusEvent!.data.to).toBe("in_progress")
  })

  it("rejects move without status", async () => {
    const issue = await seedIssue(project.id, "No status issue")
    const res = await SELF.fetch(`${HOST}/api/board/issues/${issue.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("returns 404 for nonexistent issue", async () => {
    const res = await SELF.fetch(`${HOST}/api/board/issues/NOPE-1/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    })
    expect(res.status).toBe(404)
  })
})

describe("Issue assign + events", () => {
  let project: { id: string }

  beforeAll(async () => {
    project = await seedProject("Assign Tests", "ASG")
  })

  it("assigns issue and creates assigned event", async () => {
    const issue = await seedIssue(project.id, "Assignable issue")
    const issueId = issue.id as string

    const res = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignee_id: "agent-1",
        assignee_name: "Claude",
        assignee_type: "agent",
      }),
    })
    expect(res.status).toBe(200)

    const assigned = (await res.json()) as Record<string, unknown>
    expect(assigned.assignee_id).toBe("agent-1")
    expect(assigned.assignee_name).toBe("Claude")
    expect(assigned.assignee_type).toBe("agent")

    // Verify event
    const eventsRes = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/events`)
    const events = (await eventsRes.json()) as Array<{
      event_type: string
      data: { assignee_id?: string }
    }>
    const assignEvent = events.find((e) => e.event_type === "assigned")
    expect(assignEvent).toBeDefined()
    expect(assignEvent!.data.assignee_id).toBe("agent-1")
  })

  it("rejects assign without assignee_id", async () => {
    const issue = await seedIssue(project.id, "No assignee")
    const res = await SELF.fetch(`${HOST}/api/board/issues/${issue.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_name: "Nobody" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("Comments + events", () => {
  let project: { id: string }

  beforeAll(async () => {
    project = await seedProject("Comment Tests", "CMT")
  })

  it("adds a comment and returns 204", async () => {
    const issue = await seedIssue(project.id, "Commentable issue")

    const res = await SELF.fetch(`${HOST}/api/board/issues/${issue.id}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        author_id: "user-1",
        author_name: "Alice",
        body: "First comment",
      }),
    })
    expect(res.status).toBe(204)
  })

  it("lists multiple comments in chronological order with events", async () => {
    const issue = await seedIssue(project.id, "Multi-comment issue")
    const issueId = issue.id as string

    // Add two comments
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author_id: "user-1", author_name: "Alice", body: "First" }),
    })
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author_id: "agent-1", author_name: "Claude", author_type: "agent", body: "Second" }),
    })

    // Verify comments
    const res = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/comments`)
    expect(res.status).toBe(200)
    const comments = (await res.json()) as Array<{ author_name: string; body: string; issue_id: string }>
    expect(comments.length).toBe(2)
    expect(comments[0].body).toBe("First")
    expect(comments[1].body).toBe("Second")
    expect(comments[1].author_name).toBe("Claude")

    // Verify comment_added events
    const eventsRes = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/events`)
    const events = (await eventsRes.json()) as Array<{
      event_type: string
      data: { comment_id?: string }
    }>
    const commentEvents = events.filter((e) => e.event_type === "comment_added")
    expect(commentEvents.length).toBe(2)
    expect(commentEvents[0].data.comment_id).toBeDefined()
  })

  it("rejects comment without body", async () => {
    const issue = await seedIssue(project.id, "No body issue")
    const res = await SELF.fetch(`${HOST}/api/board/issues/${issue.id}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author_id: "user-1" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("Link session (JSON array accumulation)", () => {
  let project: { id: string }

  beforeAll(async () => {
    project = await seedProject("Session Tests", "SES")
  })

  it("links a session with cost and tokens", async () => {
    const issue = await seedIssue(project.id, "Trackable issue")
    const issueId = issue.id as string

    const res = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-001", cost_usd: 1.50, tokens: 5000 }),
    })
    expect(res.status).toBe(204)

    const issueRes = await SELF.fetch(`${HOST}/api/board/issues/${issueId}`)
    const updated = (await issueRes.json()) as Record<string, unknown>
    expect(updated.session_ids).toEqual(["sess-001"])
    expect(updated.total_cost_usd).toBe(1.5)
    expect(updated.total_tokens).toBe(5000)
  })

  it("accumulates cost/tokens across multiple sessions", async () => {
    const issue = await seedIssue(project.id, "Multi-session issue")
    const issueId = issue.id as string

    // Link two sessions sequentially
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-001", cost_usd: 1.50, tokens: 5000 }),
    })
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-002", cost_usd: 0.75, tokens: 2500 }),
    })

    const res = await SELF.fetch(`${HOST}/api/board/issues/${issueId}`)
    const updated = (await res.json()) as Record<string, unknown>
    expect(updated.session_ids).toEqual(["sess-001", "sess-002"])
    expect(updated.total_cost_usd).toBe(2.25)
    expect(updated.total_tokens).toBe(7500)
  })

  it("deduplicates session IDs but still accumulates cost", async () => {
    const issue = await seedIssue(project.id, "Dedup issue")
    const issueId = issue.id as string

    // Link same session twice
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-001", cost_usd: 1.00, tokens: 3000 }),
    })
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-001", cost_usd: 0.50, tokens: 1000 }),
    })

    const res = await SELF.fetch(`${HOST}/api/board/issues/${issueId}`)
    const updated = (await res.json()) as Record<string, unknown>
    // ID not duplicated
    expect(updated.session_ids).toEqual(["sess-001"])
    // Cost and tokens still accumulate
    expect(updated.total_cost_usd).toBe(1.5)
    expect(updated.total_tokens).toBe(4000)
  })

  it("rejects link without session_id", async () => {
    const issue = await seedIssue(project.id, "No session")
    const res = await SELF.fetch(`${HOST}/api/board/issues/${issue.id}/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cost_usd: 1.0 }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 404 for nonexistent issue", async () => {
    const res = await SELF.fetch(`${HOST}/api/board/issues/NOPE-1/link-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-x" }),
    })
    expect(res.status).toBe(404)
  })
})

describe("Events", () => {
  it("lists events with parsed JSON data column", async () => {
    const project = await seedProject("Event Tests", "EVT")
    const issue = await seedIssue(project.id, "Event issue")
    const issueId = issue.id as string

    // Move to generate a status_changed event with JSON data
    await SELF.fetch(`${HOST}/api/board/issues/${issueId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    })

    const res = await SELF.fetch(`${HOST}/api/board/issues/${issueId}/events`)
    expect(res.status).toBe(200)

    const events = (await res.json()) as Array<{
      event_type: string
      data: unknown
      issue_id: string
    }>
    expect(events.length).toBe(2) // created + status_changed

    // data should be parsed objects, not raw JSON strings
    const statusEvent = events.find((e) => e.event_type === "status_changed")!
    expect(typeof statusEvent.data).toBe("object")
    expect((statusEvent.data as Record<string, string>).from).toBe("backlog")
    expect((statusEvent.data as Record<string, string>).to).toBe("todo")

    for (const e of events) {
      expect(e.issue_id).toBe(issueId)
    }
  })
})
