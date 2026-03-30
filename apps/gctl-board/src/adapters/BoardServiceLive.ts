/**
 * BoardServiceLive — concrete implementation of BoardService backed by kernel HTTP API.
 *
 * Maps Effect-TS domain operations to REST calls against /api/board/*.
 */
import { Effect, Layer } from "effect"
import { BoardService } from "../services/BoardService.js"
import {
  BoardError,
  IssueNotFoundError,
} from "../services/errors.js"
import { KernelClient } from "./KernelClient.js"
import type { Issue, IssueId, IssueStatus, IssueFilter, CreateIssueInput, Assignee, Project } from "../schema/index.js"

/**
 * Map kernel API JSON response to the Effect-TS Issue type.
 * The kernel uses snake_case; the TS schema uses camelCase.
 */
const mapIssue = (raw: any): Issue => ({
  id: raw.id as IssueId,
  projectId: raw.project_id,
  title: raw.title,
  description: raw.description ?? undefined,
  status: raw.status as IssueStatus,
  priority: raw.priority ?? "none",
  assignee: raw.assignee_id
    ? { id: raw.assignee_id, name: raw.assignee_name, type: raw.assignee_type as "human" | "agent" }
    : undefined,
  labels: raw.labels ?? [],
  parentId: raw.parent_id ?? undefined,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  createdBy: {
    id: raw.created_by_id,
    name: raw.created_by_name,
    type: raw.created_by_type as "human" | "agent",
  },
  sessionIds: raw.session_ids ?? [],
  totalCostUsd: raw.total_cost_usd ?? 0,
  totalTokens: raw.total_tokens ?? 0,
  prNumbers: raw.pr_numbers ?? [],
  blockedBy: raw.blocked_by ?? [],
  blocking: raw.blocking ?? [],
  acceptanceCriteria: raw.acceptance_criteria ?? [],
})

const mapProject = (raw: any): Project => ({
  id: raw.id,
  name: raw.name,
  key: raw.key,
  autoIncrementCounter: raw.counter ?? 0,
})

export const BoardServiceLive = Layer.effect(
  BoardService,
  Effect.gen(function* () {
    const client = yield* KernelClient

    return {
      createProject: (name: string, key: string) =>
        Effect.gen(function* () {
          const raw = yield* client.post("/api/board/projects", { name, key })
          return mapProject(raw)
        }).pipe(
          Effect.catchAll((e) => Effect.fail(new BoardError({ message: String(e) })))
        ),

      createIssue: (input: CreateIssueInput) =>
        Effect.gen(function* () {
          const raw = yield* client.post("/api/board/issues", {
            project_id: input.projectId,
            title: input.title,
            description: input.description,
            priority: input.priority ?? "none",
            labels: input.labels ?? [],
            parent_id: input.parentId,
            created_by_id: input.createdBy.id,
            created_by_name: input.createdBy.name,
            created_by_type: input.createdBy.type,
          })
          return mapIssue(raw)
        }).pipe(
          Effect.catchAll((e) => Effect.fail(new BoardError({ message: String(e) })))
        ),

      getIssue: (issueId: IssueId) =>
        Effect.gen(function* () {
          const raw = yield* client.get(`/api/board/issues/${issueId}`)
          return mapIssue(raw)
        }).pipe(
          Effect.catchAll((e) => {
            const msg = String(e)
            if (msg.includes("404")) return Effect.fail(new IssueNotFoundError({ issueId }))
            return Effect.fail(new BoardError({ message: msg }))
          })
        ),

      listIssues: (filter: IssueFilter) =>
        Effect.gen(function* () {
          const params = new URLSearchParams()
          if (filter.projectId) params.set("project_id", filter.projectId)
          if (filter.status) params.set("status", filter.status)
          if (filter.assigneeId) params.set("assignee_id", filter.assigneeId)
          if (filter.label) params.set("label", filter.label)
          const qs = params.toString()
          const raw = yield* client.get(`/api/board/issues${qs ? `?${qs}` : ""}`) as Effect.Effect<unknown[], Error>
          return (raw as any[]).map(mapIssue)
        }).pipe(
          Effect.catchAll((e) => Effect.fail(new BoardError({ message: String(e) })))
        ),

      moveIssue: (issueId: IssueId, newStatus: IssueStatus, _note?: string) =>
        Effect.gen(function* () {
          const raw = yield* client.post(`/api/board/issues/${issueId}/move`, {
            status: newStatus,
            actor_id: "system",
            actor_name: "gctl-board",
            actor_type: "agent",
          })
          return mapIssue(raw)
        }).pipe(
          Effect.catchAll((e) => {
            const msg = String(e)
            if (msg.includes("404") || msg.includes("not found")) return Effect.fail(new IssueNotFoundError({ issueId }))
            return Effect.fail(new BoardError({ message: msg }))
          })
        ),

      assignIssue: (issueId: IssueId, assignee: Assignee) =>
        Effect.gen(function* () {
          const raw = yield* client.post(`/api/board/issues/${issueId}/assign`, {
            assignee_id: assignee.id,
            assignee_name: assignee.name,
            assignee_type: assignee.type,
          })
          return mapIssue(raw)
        }).pipe(
          Effect.catchAll((e) => {
            const msg = String(e)
            if (msg.includes("404")) return Effect.fail(new IssueNotFoundError({ issueId }))
            return Effect.fail(new BoardError({ message: msg }))
          })
        ),

      decomposeIssue: (parentId: IssueId, subTasks: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const issues: Issue[] = []
          for (const title of subTasks) {
            // Get parent to inherit project
            const parent = yield* client.get(`/api/board/issues/${parentId}`) as any
            const raw = yield* client.post("/api/board/issues", {
              project_id: parent.project_id,
              title,
              parent_id: parentId,
              created_by_id: parent.created_by_id,
              created_by_name: parent.created_by_name,
              created_by_type: parent.created_by_type,
            })
            issues.push(mapIssue(raw))
          }
          return issues
        }).pipe(
          Effect.catchAll((e) => {
            const msg = String(e)
            if (msg.includes("404")) return Effect.fail(new IssueNotFoundError({ issueId: parentId }))
            return Effect.fail(new BoardError({ message: msg }))
          })
        ),

      blockIssue: (_issueId: IssueId, _blockedById: IssueId) =>
        Effect.fail(new BoardError({ message: "blockIssue: not yet implemented in kernel API" })),

      unblockIssue: (_issueId: IssueId, _blockedById: IssueId) =>
        Effect.fail(new BoardError({ message: "unblockIssue: not yet implemented in kernel API" })),

      addComment: (issueId: IssueId, author: Assignee, body: string, sessionId?: string) =>
        Effect.gen(function* () {
          yield* client.post(`/api/board/issues/${issueId}/comment`, {
            author_id: author.id,
            author_name: author.name,
            author_type: author.type,
            body,
            session_id: sessionId,
          })
        }).pipe(
          Effect.catchAll((e) => {
            const msg = String(e)
            if (msg.includes("404")) return Effect.fail(new IssueNotFoundError({ issueId }))
            return Effect.fail(new BoardError({ message: msg }))
          })
        ),

      linkSession: (issueId: IssueId, sessionId: string, costUsd: number, tokens: number) =>
        Effect.gen(function* () {
          yield* client.post(`/api/board/issues/${issueId}/link-session`, {
            session_id: sessionId,
            cost_usd: costUsd,
            tokens,
          })
        }).pipe(
          Effect.catchAll((e) => {
            const msg = String(e)
            if (msg.includes("404")) return Effect.fail(new IssueNotFoundError({ issueId }))
            return Effect.fail(new BoardError({ message: msg }))
          })
        ),
    }
  })
)
