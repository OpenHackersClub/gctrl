import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { BoardService } from "../src/services/BoardService.js"
import { BoardServiceLive } from "../src/adapters/BoardServiceLive.js"
import { KernelClient } from "../src/adapters/KernelClient.js"
import { KernelError } from "../src/services/errors.js"
import type { IssueId, ProjectId } from "../src/schema/index.js"

const fail404 = (msg: string) => Effect.fail(new KernelError({ message: msg, statusCode: 404 }))

/**
 * In-memory mock kernel that simulates the /api/board/* HTTP API.
 * Uses Effect.fail with KernelError for typed error propagation.
 */
const createMockKernel = () => {
  const projects: Record<string, any> = {}
  const issues: Record<string, any> = {}
  const comments: Record<string, any[]> = {}
  let counter = 0

  return Layer.succeed(KernelClient, {
    get: (path: string) =>
      Effect.gen(function* () {
        if (path.startsWith("/api/board/projects")) {
          return Object.values(projects)
        }
        const issueMatch = path.match(/\/api\/board\/issues\/([^/?]+)$/)
        if (issueMatch) {
          const issue = issues[issueMatch[1]]
          if (!issue) return yield* fail404("not found")
          return issue
        }
        const commentsMatch = path.match(/\/api\/board\/issues\/([^/]+)\/comments/)
        if (commentsMatch) {
          return comments[commentsMatch[1]] ?? []
        }
        if (path.startsWith("/api/board/issues")) {
          return Object.values(issues)
        }
        return yield* fail404(`unknown path ${path}`)
      }),
    post: (path: string, body: unknown) =>
      Effect.gen(function* () {
        const b = body as any
        if (path === "/api/board/projects") {
          const project = { id: `p-${++counter}`, name: b.name, key: b.key, counter: 0 }
          projects[project.id] = project
          return project
        }
        if (path === "/api/board/issues") {
          const projId = b.project_id
          const project = Object.values(projects).find((p: any) => p.id === projId) as any
          if (!project) return yield* fail404("project not found")
          project.counter = (project.counter ?? 0) + 1
          const issue = {
            id: `${project.key}-${project.counter}`,
            project_id: projId,
            title: b.title,
            description: b.description,
            status: "backlog",
            priority: b.priority ?? "none",
            assignee_id: null,
            assignee_name: null,
            assignee_type: null,
            labels: b.labels ?? [],
            parent_id: b.parent_id ?? null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            created_by_id: b.created_by_id,
            created_by_name: b.created_by_name,
            created_by_type: b.created_by_type,
            blocked_by: [],
            blocking: [],
            session_ids: [],
            total_cost_usd: 0,
            total_tokens: 0,
            pr_numbers: [],
          }
          issues[issue.id] = issue
          return issue
        }
        const moveMatch = path.match(/\/api\/board\/issues\/([^/]+)\/move/)
        if (moveMatch) {
          const issue = issues[moveMatch[1]]
          if (!issue) return yield* fail404("not found")
          issue.status = b.status
          issue.updated_at = new Date().toISOString()
          return { issue, task_id: null, dispatched: false }
        }
        const assignMatch = path.match(/\/api\/board\/issues\/([^/]+)\/assign/)
        if (assignMatch) {
          const issue = issues[assignMatch[1]]
          if (!issue) return yield* fail404("not found")
          issue.assignee_id = b.assignee_id
          issue.assignee_name = b.assignee_name
          issue.assignee_type = b.assignee_type
          return issue
        }
        const commentMatch = path.match(/\/api\/board\/issues\/([^/]+)\/comment/)
        if (commentMatch) {
          const id = commentMatch[1]
          if (!issues[id]) return yield* fail404("not found")
          if (!comments[id]) comments[id] = []
          comments[id].push({ ...b, id: `c-${++counter}`, issue_id: id, created_at: new Date().toISOString() })
          return comments[id][comments[id].length - 1]
        }
        const linkMatch = path.match(/\/api\/board\/issues\/([^/]+)\/link-session/)
        if (linkMatch) {
          const issue = issues[linkMatch[1]]
          if (!issue) return yield* fail404("not found")
          issue.session_ids.push(b.session_id)
          issue.total_cost_usd += b.cost_usd
          issue.total_tokens += b.tokens
          return null
        }
        return yield* fail404(`unknown POST ${path}`)
      }),
  })
}

const runWithMock = <A, E>(effect: Effect.Effect<A, E, BoardService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(BoardServiceLive),
      Effect.provide(createMockKernel()),
    )
  )

describe("BoardServiceLive", () => {
  it("creates a project", async () => {
    const project = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        return yield* svc.createProject("Backend", "BACK")
      })
    )
    expect(project.name).toBe("Backend")
    expect(project.key).toBe("BACK")
  })

  it("creates an issue with auto-generated ID", async () => {
    const issue = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        return yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Fix auth bug",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
      })
    )
    expect(issue.id).toBe("BACK-1")
    expect(issue.title).toBe("Fix auth bug")
    expect(issue.status).toBe("backlog")
  })

  it("lists issues", async () => {
    const issues = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        const pid = "p-1" as ProjectId
        yield* svc.createIssue({ projectId: pid, title: "Issue 1", createdBy: { id: "u1", name: "Alice", type: "human" } })
        yield* svc.createIssue({ projectId: pid, title: "Issue 2", createdBy: { id: "u1", name: "Alice", type: "human" } })
        return yield* svc.listIssues({})
      })
    )
    expect(issues.length).toBe(2)
  })

  it("gets an issue by ID", async () => {
    const issue = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Get me",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
        return yield* svc.getIssue("BACK-1" as IssueId)
      })
    )
    expect(issue.title).toBe("Get me")
  })

  it("moves an issue to a new status", async () => {
    const issue = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Move me",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
        return yield* svc.moveIssue("BACK-1" as IssueId, "todo")
      })
    )
    expect(issue.status).toBe("todo")
  })

  it("assigns an issue", async () => {
    const issue = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Assign me",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
        return yield* svc.assignIssue("BACK-1" as IssueId, {
          id: "agent1",
          name: "claude-code",
          type: "agent",
        })
      })
    )
    expect(issue.assignee?.id).toBe("agent1")
    expect(issue.assignee?.type).toBe("agent")
  })

  it("adds a comment", async () => {
    await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Comment me",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
        yield* svc.addComment(
          "BACK-1" as IssueId,
          { id: "u1", name: "Alice", type: "human" },
          "LGTM!"
        )
      })
    )
    // No error = success
  })

  it("links a session and accumulates cost", async () => {
    const issue = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Track cost",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
        yield* svc.linkSession("BACK-1" as IssueId, "sess-1", 1.50, 5000)
        yield* svc.linkSession("BACK-1" as IssueId, "sess-2", 0.75, 2500)
        return yield* svc.getIssue("BACK-1" as IssueId)
      })
    )
    expect(issue.totalCostUsd).toBe(2.25)
    expect(issue.totalTokens).toBe(7500)
    expect(issue.sessionIds).toEqual(["sess-1", "sess-2"])
  })

  it("decomposes an issue into sub-tasks", async () => {
    const subs = await runWithMock(
      Effect.gen(function* () {
        const svc = yield* BoardService
        yield* svc.createProject("Backend", "BACK")
        yield* svc.createIssue({
          projectId: "p-1" as ProjectId,
          title: "Parent task",
          createdBy: { id: "u1", name: "Alice", type: "human" },
        })
        return yield* svc.decomposeIssue("BACK-1" as IssueId, ["Sub 1", "Sub 2", "Sub 3"])
      })
    )
    expect(subs.length).toBe(3)
    expect(subs[0].title).toBe("Sub 1")
    expect(subs[0].parentId).toBe("BACK-1")
  })

  it("fails with IssueNotFoundError for unknown ID", async () => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* BoardService
        return yield* svc.getIssue("NONEXISTENT" as IssueId)
      }).pipe(
        Effect.provide(BoardServiceLive),
        Effect.provide(createMockKernel()),
      )
    )
    expect(result._tag).toBe("Failure")
  })
})
