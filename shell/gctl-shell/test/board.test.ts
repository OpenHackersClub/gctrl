import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient.js"
import { createMockKernelClient } from "./helpers/mock-kernel.js"

const mockProjects = [
  { id: "proj-1", name: "GroundCtrl", key: "GCTL", counter: 42 },
]

const mockIssues = [
  {
    id: "iss-1",
    project_id: "proj-1",
    title: "Implement shell analytics",
    status: "in_progress",
    priority: "high",
    assignee_id: "user-1",
    assignee_name: "debuggingfuture",
    labels: ["shell", "feature"],
    created_at: "2026-03-28T10:00:00Z",
    updated_at: "2026-03-30T10:00:00Z",
  },
]

const mockComments = [
  {
    id: "cmt-1",
    issue_id: "iss-1",
    author_id: "user-1",
    author_name: "debuggingfuture",
    author_type: "human",
    body: "Working on this now.",
    created_at: "2026-03-30T12:00:00Z",
  },
]

const mockEvents = [
  {
    id: "evt-1",
    issue_id: "iss-1",
    event_type: "status_changed",
    actor_name: "debuggingfuture",
    actor_type: "human",
    timestamp: "2026-03-30T11:00:00Z",
  },
]

const MockLayer = createMockKernelClient(
  {
    "/api/board/projects": mockProjects,
    "/api/board/issues": mockIssues,
    "/api/board/issues/iss-1": mockIssues[0],
    "/api/board/issues/iss-1/comments": mockComments,
    "/api/board/issues/iss-1/events": mockEvents,
  },
  {
    "/api/board/projects": mockProjects[0],
    "/api/board/issues": mockIssues[0],
    "/api/board/issues/iss-1/move": { ...mockIssues[0], status: "done" },
    "/api/board/issues/iss-1/assign": { ...mockIssues[0], assignee_name: "agent-1" },
    "/api/board/issues/iss-1/comment": mockComments[0],
    "/api/board/issues/iss-1/link-session": {},
  }
)

const BoardProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  counter: Schema.Number,
})

const BoardIssue = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  priority: Schema.String,
  assignee_name: Schema.optional(Schema.String),
  labels: Schema.Array(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

const BoardComment = Schema.Struct({
  id: Schema.String,
  issue_id: Schema.String,
  author_name: Schema.String,
  body: Schema.String,
  created_at: Schema.String,
})

const BoardEvent = Schema.Struct({
  id: Schema.String,
  issue_id: Schema.String,
  event_type: Schema.String,
  actor_name: Schema.String,
  timestamp: Schema.String,
})

describe("Board commands (via KernelClient)", () => {
  it("list projects", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/board/projects", Schema.Array(BoardProject))
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("GCTL")
  })

  it("create project", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/board/projects", { name: "New", key: "NEW" }, BoardProject)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.name).toBe("GroundCtrl")
  })

  it("list issues", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/board/issues?limit=50", Schema.Array(BoardIssue))
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe("in_progress")
  })

  it("create issue", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/board/issues", {
        project_id: "proj-1",
        title: "New task",
        priority: "high",
        created_by_id: "shell",
        created_by_name: "gctl-shell",
      }, BoardIssue)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.title).toBe("Implement shell analytics")
  })

  it("view issue", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/board/issues/iss-1", BoardIssue)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("iss-1")
    expect(result.priority).toBe("high")
  })

  it("move issue", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/board/issues/iss-1/move", {
        status: "done",
        actor_id: "shell",
        actor_name: "gctl-shell",
      }, BoardIssue)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.status).toBe("done")
  })

  it("assign issue", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/board/issues/iss-1/assign", {
        assignee_id: "agent-1",
        assignee_name: "agent-1",
        assignee_type: "agent",
      }, BoardIssue)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.assignee_name).toBe("agent-1")
  })

  it("add comment", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post("/api/board/issues/iss-1/comment", {
        author_id: "shell",
        author_name: "gctl-shell",
        body: "Progress update",
      }, BoardComment)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.body).toBe("Working on this now.")
  })

  it("list comments", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/board/issues/iss-1/comments", Schema.Array(BoardComment))
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].author_name).toBe("debuggingfuture")
  })

  it("list events", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/board/issues/iss-1/events", Schema.Array(BoardEvent))
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].event_type).toBe("status_changed")
  })

  it("link session", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      yield* kernel.post("/api/board/issues/iss-1/link-session", {
        session_id: "sess-001",
      }, Schema.Struct({}))
    })

    await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
  })
})
