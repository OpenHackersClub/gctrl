import { describe, it, expect } from "vitest"
import { Schema } from "effect"
import {
  Issue,
  IssueId,
  IssueStatus,
  Priority,
  Assignee,
  CreateIssueInput,
  IssueFilter,
  IssueEvent,
  IssueEventType,
  Comment,
  Board,
  Project,
} from "../src/schema/index.js"

describe("Issue schema", () => {
  it("validates a complete issue", () => {
    const issue = {
      id: "BACK-1",
      projectId: "proj-1",
      title: "Add rate limiting",
      description: "Implement rate limiting on /api/users",
      status: "todo" as const,
      priority: "high" as const,
      assignee: { id: "agent-1", name: "claude-code", type: "agent" as const },
      labels: ["backend", "agent-ok"],
      createdAt: "2026-03-22T00:00:00Z",
      updatedAt: "2026-03-22T00:00:00Z",
      createdBy: { id: "user-1", name: "alice", type: "human" as const },
      sessionIds: [],
      totalCostUsd: 0,
      totalTokens: 0,
      prNumbers: [],
      blockedBy: [],
      blocking: [],
      acceptanceCriteria: ["tests pass", "lint clean"],
    }

    const decoded = Schema.decodeUnknownSync(Issue)(issue)
    expect(decoded.title).toBe("Add rate limiting")
    expect(decoded.status).toBe("todo")
    expect(decoded.priority).toBe("high")
    expect(decoded.assignee?.type).toBe("agent")
  })

  it("rejects invalid status", () => {
    const issue = {
      id: "BACK-1",
      projectId: "proj-1",
      title: "Test",
      status: "invalid_status",
      priority: "high",
      labels: [],
      createdAt: "2026-03-22T00:00:00Z",
      updatedAt: "2026-03-22T00:00:00Z",
      createdBy: { id: "u1", name: "alice", type: "human" },
      sessionIds: [],
      totalCostUsd: 0,
      totalTokens: 0,
      prNumbers: [],
      blockedBy: [],
      blocking: [],
      acceptanceCriteria: [],
    }

    expect(() => Schema.decodeUnknownSync(Issue)(issue)).toThrow()
  })

  it("validates CreateIssueInput", () => {
    const input = {
      projectId: "proj-1",
      title: "New feature",
      priority: "medium" as const,
      createdBy: { id: "agent-1", name: "claude-code", type: "agent" as const },
    }

    const decoded = Schema.decodeUnknownSync(CreateIssueInput)(input)
    expect(decoded.title).toBe("New feature")
  })

  it("validates IssueFilter", () => {
    const filter = {
      status: "todo" as const,
      assigneeType: "agent" as const,
      unassigned: true,
    }

    const decoded = Schema.decodeUnknownSync(IssueFilter)(filter)
    expect(decoded.status).toBe("todo")
    expect(decoded.unassigned).toBe(true)
  })
})

describe("IssueEvent schema", () => {
  it("validates an event", () => {
    const event = {
      id: "evt-1",
      issueId: "BACK-1",
      type: "status_changed" as const,
      actor: { id: "agent-1", name: "claude-code", type: "agent" as const },
      timestamp: "2026-03-22T14:00:00Z",
      data: { from: "todo", to: "in_progress" },
    }

    const decoded = Schema.decodeUnknownSync(IssueEvent)(event)
    expect(decoded.type).toBe("status_changed")
  })
})

describe("Board schema", () => {
  it("validates a project", () => {
    const project = {
      id: "proj-1",
      name: "Backend",
      key: "BACK",
      autoIncrementCounter: 42,
    }

    const decoded = Schema.decodeUnknownSync(Project)(project)
    expect(decoded.key).toBe("BACK")
    expect(decoded.autoIncrementCounter).toBe(42)
  })
})
