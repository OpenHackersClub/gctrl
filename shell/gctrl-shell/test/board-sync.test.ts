/**
 * Board Sync — acceptance tests (RED phase)
 *
 * Tests the 2-way sync between board issues and GitHub issues.
 * Sync orchestration lives in the shell, composing:
 *   - kernel board API (/api/board/*) for board CRUD
 *   - kernel GitHub driver (/api/github/*) for GitHub CRUD
 *
 * Both are accessed through the same KernelClient mock.
 */
import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

// --- Mock data: board project linked to a GitHub repo ---

const mockProject = {
  id: "proj-1",
  name: "GroundCtrl",
  key: "GCTL",
  counter: 3,
  github_repo: "OpenHackersClub/gctrl",
}

// Board issues (some already synced with GitHub, some not)
const mockBoardIssues = [
  {
    id: "GCTL-1",
    project_id: "proj-1",
    title: "Existing synced issue",
    description: "Already on GitHub",
    status: "in_progress",
    priority: "high",
    labels: ["backend"],
    github_issue_number: 10,
    github_url: "https://github.com/OpenHackersClub/gctrl/issues/10",
    created_at: "2026-03-28T10:00:00Z",
    updated_at: "2026-03-30T10:00:00Z",
    created_by_id: "alice",
    created_by_name: "Alice",
    created_by_type: "human",
    session_ids: [],
    total_cost_usd: 0,
    total_tokens: 0,
    pr_numbers: [],
    blocked_by: [],
    blocking: [],
  },
  {
    id: "GCTL-2",
    project_id: "proj-1",
    title: "Board-only issue",
    description: "Not yet on GitHub",
    status: "todo",
    priority: "medium",
    labels: ["frontend"],
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
    created_by_id: "bob",
    created_by_name: "Bob",
    created_by_type: "human",
    session_ids: [],
    total_cost_usd: 0,
    total_tokens: 0,
    pr_numbers: [],
    blocked_by: [],
    blocking: [],
  },
]

// GitHub issues (some already on board, some not)
const mockGhIssues = [
  {
    number: 10,
    title: "Existing synced issue",
    state: "open",
    author: "alice",
    labels: ["backend"],
    createdAt: "2026-03-28T10:00:00Z",
    url: "https://github.com/OpenHackersClub/gctrl/issues/10",
    body: "Already on GitHub",
  },
  {
    number: 11,
    title: "GitHub-only issue",
    state: "open",
    author: "charlie",
    labels: ["bug"],
    createdAt: "2026-04-02T10:00:00Z",
    url: "https://github.com/OpenHackersClub/gctrl/issues/11",
    body: "Created on GitHub, not yet on board",
  },
]

// Schemas matching the sync service expectations
const GhIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Schema.String),
  createdAt: Schema.String,
  url: Schema.String,
  body: Schema.optional(Schema.String),
})
const GhIssueList = Schema.Array(GhIssue)

const BoardProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  counter: Schema.Number,
  github_repo: Schema.optional(Schema.String),
})
const BoardProjectList = Schema.Array(BoardProject)

const BoardIssue = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.String,
  priority: Schema.String,
  labels: Schema.Array(Schema.String),
  github_issue_number: Schema.optional(Schema.Number),
  github_url: Schema.optional(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  created_by_id: Schema.String,
  created_by_name: Schema.String,
  created_by_type: Schema.String,
})
const BoardIssueList = Schema.Array(BoardIssue)

const SyncResult = Schema.Struct({
  pulled: Schema.Number,
  pushed: Schema.Number,
  skipped: Schema.Number,
})

const MockLayer = createMockKernelClient(
  {
    // Board routes
    "/api/board/projects": [mockProject],
    "/api/board/issues": mockBoardIssues,
    // GitHub routes (via kernel driver)
    "/api/github/issues": mockGhIssues,
  },
  {
    // POST routes
    "/api/board/issues": {
      ...mockBoardIssues[0],
      id: "GCTL-4",
      title: "GitHub-only issue",
      github_issue_number: 11,
    },
    "/api/github/issues": {
      number: 12,
      title: "Board-only issue",
      state: "open",
      author: "gctrl-sync",
      labels: ["frontend"],
      createdAt: "2026-04-05T10:00:00Z",
      url: "https://github.com/OpenHackersClub/gctrl/issues/12",
    },
  }
)

describe("Board GitHub Sync", () => {
  it("reads board project with github_repo field", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      const projects = yield* kernel.get("/api/board/projects", BoardProjectList)
      return projects
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result[0].github_repo).toBe("OpenHackersClub/gctrl")
  })

  it("reads board issues with github_issue_number field", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/board/issues?project_id=proj-1", BoardIssueList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    const synced = result.find((i) => i.id === "GCTL-1")
    expect(synced?.github_issue_number).toBe(10)
    expect(synced?.github_url).toContain("github.com")
  })

  it("reads GitHub issues via kernel driver", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/github/issues?repo=OpenHackersClub/gctrl",
        GhIssueList
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(2)
    expect(result[1].title).toBe("GitHub-only issue")
  })

  it("sync pull: identifies GitHub issues not yet on board", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient

      // 1. Get project config
      const projects = yield* kernel.get("/api/board/projects", BoardProjectList)
      const project = projects.find((p) => p.key === "GCTL")!
      const repo = project.github_repo!

      // 2. Fetch GitHub issues
      const ghIssues = yield* kernel.get(
        `/api/github/issues?repo=${encodeURIComponent(repo)}`,
        GhIssueList
      )

      // 3. Fetch board issues for this project
      const boardIssues = yield* kernel.get(
        `/api/board/issues?project_id=${project.id}`,
        BoardIssueList
      )

      // 4. Find GH issues not yet on board
      const existingGhNumbers = new Set(
        boardIssues
          .filter((i) => i.github_issue_number !== undefined)
          .map((i) => i.github_issue_number)
      )
      const newFromGh = ghIssues.filter((gi) => !existingGhNumbers.has(gi.number))

      return newFromGh
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe("GitHub-only issue")
    expect(result[0].number).toBe(11)
  })

  it("sync push: identifies board issues not yet on GitHub", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient

      const projects = yield* kernel.get("/api/board/projects", BoardProjectList)
      const project = projects.find((p) => p.key === "GCTL")!

      const boardIssues = yield* kernel.get(
        `/api/board/issues?project_id=${project.id}`,
        BoardIssueList
      )

      // Find board issues without github_issue_number
      const unsynced = boardIssues.filter(
        (i) => i.github_issue_number === undefined || i.github_issue_number === null
      )

      return unsynced
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe("Board-only issue")
    expect(result[0].id).toBe("GCTL-2")
  })

  it("sync pull: creates board issue from GitHub issue", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient

      // Simulate creating a board issue from a GH issue
      const ghIssue = mockGhIssues[1] // GitHub-only issue #11
      const created = yield* kernel.post(
        "/api/board/issues",
        {
          project_id: "proj-1",
          title: ghIssue.title,
          description: ghIssue.body,
          labels: ghIssue.labels,
          github_issue_number: ghIssue.number,
          github_url: ghIssue.url,
          created_by_id: "gctrl-sync",
          created_by_name: "gctrl-sync",
          created_by_type: "agent",
        },
        BoardIssue
      )

      return created
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.github_issue_number).toBe(11)
    expect(result.title).toBe("GitHub-only issue")
  })

  it("sync push: creates GitHub issue from board issue", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient

      // Simulate creating a GH issue from a board issue
      const boardIssue = mockBoardIssues[1] // Board-only issue GCTL-2
      const created = yield* kernel.post(
        "/api/github/issues?repo=OpenHackersClub/gctrl",
        {
          title: boardIssue.title,
          body: boardIssue.description,
          labels: boardIssue.labels,
        },
        GhIssue
      )

      return created
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.number).toBe(12)
    expect(result.title).toBe("Board-only issue")
  })

  it("maps GitHub state to board status correctly", () => {
    // open → backlog (default for pull), closed → done
    const mapGhStateToStatus = (state: string): string => {
      switch (state) {
        case "closed":
          return "done"
        case "open":
        default:
          return "backlog"
      }
    }

    expect(mapGhStateToStatus("open")).toBe("backlog")
    expect(mapGhStateToStatus("closed")).toBe("done")
  })

  it("maps board status to GitHub state correctly", () => {
    const mapStatusToGhState = (status: string): string => {
      switch (status) {
        case "done":
        case "cancelled":
          return "closed"
        default:
          return "open"
      }
    }

    expect(mapStatusToGhState("backlog")).toBe("open")
    expect(mapStatusToGhState("todo")).toBe("open")
    expect(mapStatusToGhState("in_progress")).toBe("open")
    expect(mapStatusToGhState("done")).toBe("closed")
    expect(mapStatusToGhState("cancelled")).toBe("closed")
  })
})
