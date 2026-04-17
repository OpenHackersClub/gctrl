/**
 * D1 Sync Schema — deploy tests
 *
 * Verifies that the 0002_sync_columns.sql migration landed correctly and that
 * the dual-path sync implementation (spec/sync-sqlite-d1 #15) is observable
 * via the deployed Worker API.
 *
 * Run against the deployed Worker:
 *   DEPLOY_URL=https://gctrl-board.debuggingfuturecors.workers.dev pnpm vitest run test/sync-d1.test.ts
 *
 * What we test:
 *   1. GET /api/sync/status — shape, types, non-negative counts
 *   2. Pending counts increase when board mutations are made
 *   3. sync_manifest table exists (devices array is present and well-typed)
 *   4. Existing CRUD operations still work after the migration (regression)
 *   5. New sync columns (device_id, updated_at, synced) do not break responses
 */

import { describe, it, expect, beforeAll } from "vitest"

const BASE_URL =
  process.env.DEPLOY_URL ?? "https://gctrl-board.debuggingfuturecors.workers.dev"

const shouldRun = !!process.env.DEPLOY_URL || !!process.env.RUN_DEPLOY_TESTS
const describeSync = shouldRun ? describe : describe.skip

// ── Helpers ──

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${path}: ${text}`)
  }
  if (res.status === 204) return null as T
  const text = await res.text()
  if (!text) return null as T
  return JSON.parse(text) as T
}

function uniqueKey() {
  return `S${Date.now().toString(36).slice(-5).toUpperCase()}`
}

interface SyncStatus {
  pending: {
    projects: number
    issues: number
    comments: number
    issue_events: number
  }
  devices: Array<{ device_id: string; last_pull_at: string }>
}

interface Project { id: string; name: string; key: string; counter: number }
interface Issue { id: string; project_id: string; title: string; status: string; labels: string[] }

// ── Tests ──

describeSync("D1 Sync Schema (deploy)", () => {
  let project: Project

  beforeAll(async () => {
    project = await api<Project>("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ name: `Sync Test ${uniqueKey()}`, key: uniqueKey() }),
    })
  })

  // ── /api/sync/status shape ──

  describe("GET /api/sync/status", () => {
    it("returns 200 with correct shape", async () => {
      const res = await fetch(`${BASE_URL}/api/sync/status`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
    })

    it("pending counts are non-negative numbers", async () => {
      const status = await api<SyncStatus>("/api/sync/status")
      expect(typeof status.pending.projects).toBe("number")
      expect(typeof status.pending.issues).toBe("number")
      expect(typeof status.pending.comments).toBe("number")
      expect(typeof status.pending.issue_events).toBe("number")
      expect(status.pending.projects).toBeGreaterThanOrEqual(0)
      expect(status.pending.issues).toBeGreaterThanOrEqual(0)
      expect(status.pending.comments).toBeGreaterThanOrEqual(0)
      expect(status.pending.issue_events).toBeGreaterThanOrEqual(0)
    })

    it("devices is an array (sync_manifest table exists)", async () => {
      const status = await api<SyncStatus>("/api/sync/status")
      expect(Array.isArray(status.devices)).toBe(true)
    })

    it("device entries have correct shape when present", async () => {
      const status = await api<SyncStatus>("/api/sync/status")
      for (const device of status.devices) {
        expect(typeof device.device_id).toBe("string")
        expect(typeof device.last_pull_at).toBe("string")
        expect(new Date(device.last_pull_at).getTime()).not.toBeNaN()
      }
    })
  })

  // ── Pending counts increase with mutations ──

  describe("Pending counts track unsynced rows", () => {
    it("creating a project increments projects pending count", async () => {
      const before = await api<SyncStatus>("/api/sync/status")

      await api<Project>("/api/board/projects", {
        method: "POST",
        body: JSON.stringify({ name: `Count Test ${uniqueKey()}`, key: uniqueKey() }),
      })

      const after = await api<SyncStatus>("/api/sync/status")
      expect(after.pending.projects).toBe(before.pending.projects + 1)
    })

    it("creating an issue increments issues pending count", async () => {
      const before = await api<SyncStatus>("/api/sync/status")

      await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Sync pending count test",
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })

      const after = await api<SyncStatus>("/api/sync/status")
      expect(after.pending.issues).toBe(before.pending.issues + 1)
    })

    it("adding a comment increments comments pending count", async () => {
      const issue = await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Comment pending test",
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })

      const before = await api<SyncStatus>("/api/sync/status")

      await api("/api/board/issues/" + issue.id + "/comment", {
        method: "POST",
        body: JSON.stringify({
          author_id: "test",
          author_name: "Test",
          author_type: "human",
          body: "sync test comment",
        }),
      })

      const after = await api<SyncStatus>("/api/sync/status")
      expect(after.pending.comments).toBe(before.pending.comments + 1)
    })

    it("moving an issue adds an issue_event row to pending count", async () => {
      const issue = await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Event pending test",
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })

      const before = await api<SyncStatus>("/api/sync/status")

      await api("/api/board/issues/" + issue.id + "/move", {
        method: "POST",
        body: JSON.stringify({
          status: "todo",
          actor_id: "test",
          actor_name: "Test",
          actor_type: "human",
        }),
      })

      const after = await api<SyncStatus>("/api/sync/status")
      // At least one new status_changed event
      expect(after.pending.issue_events).toBeGreaterThan(before.pending.issue_events)
    })
  })

  // ── Schema regression: existing CRUD still works ──

  describe("Schema regression — existing operations unaffected", () => {
    it("creates project with correct fields", async () => {
      const key = uniqueKey()
      const p = await api<Project>("/api/board/projects", {
        method: "POST",
        body: JSON.stringify({ name: `Regression ${key}`, key }),
      })
      expect(p.id).toBeTruthy()
      expect(p.key).toBe(key)
      expect(p.counter).toBe(0)
    })

    it("creates issue and reads it back", async () => {
      const issue = await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Regression issue",
          priority: "high",
          labels: ["regression"],
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })

      expect(issue.id).toMatch(/^[A-Z0-9]+-\d+$/)
      expect(issue.status).toBe("backlog")
      expect(issue.labels).toContain("regression")

      const fetched = await api<Issue>("/api/board/issues/" + issue.id)
      expect(fetched.title).toBe("Regression issue")
    })

    it("moves issue through full lifecycle", async () => {
      const issue = await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Lifecycle regression",
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })

      for (const status of ["todo", "in_progress", "in_review", "done"] as const) {
        const moved = await api<Issue>("/api/board/issues/" + issue.id + "/move", {
          method: "POST",
          body: JSON.stringify({
            status,
            actor_id: "test",
            actor_name: "Test",
            actor_type: "human",
          }),
        })
        expect(moved.status).toBe(status)
      }
    })

    it("project list returns array", async () => {
      const projects = await api<Project[]>("/api/board/projects")
      expect(Array.isArray(projects)).toBe(true)
      expect(projects.length).toBeGreaterThan(0)
    })

    it("issue list filters by project_id and status", async () => {
      const issueA = await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Filter backlog",
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })
      const issueB = await api<Issue>("/api/board/issues", {
        method: "POST",
        body: JSON.stringify({
          project_id: project.id,
          title: "Filter todo",
          created_by_id: "test",
          created_by_name: "Test",
          created_by_type: "human",
        }),
      })
      await api("/api/board/issues/" + issueB.id + "/move", {
        method: "POST",
        body: JSON.stringify({
          status: "todo",
          actor_id: "test",
          actor_name: "Test",
          actor_type: "human",
        }),
      })

      const backlog = await api<Issue[]>(
        `/api/board/issues?project_id=${project.id}&status=backlog`
      )
      const todo = await api<Issue[]>(
        `/api/board/issues?project_id=${project.id}&status=todo`
      )

      expect(backlog.some((i) => i.id === issueA.id)).toBe(true)
      expect(todo.some((i) => i.id === issueB.id)).toBe(true)
    })
  })
})
