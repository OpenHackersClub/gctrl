/**
 * BoardServiceLive — concrete implementation of BoardService backed by kernel HTTP API.
 *
 * Maps Effect-TS domain operations to REST calls against /api/board/*.
 */
import { Effect, Layer, Schema } from "effect"
import { BoardService } from "../services/BoardService.js"
import { BoardError, IssueNotFoundError, KernelError } from "../services/errors.js"
import { AssigneeType, IssueStatus, Priority } from "../schema/Issue.js"
import { KernelClient } from "./KernelClient.js"
import type {
  Assignee,
  CreateIssueInput,
  Issue,
  IssueFilter,
  IssueId,
  Project,
} from "../schema/index.js"

// Wire format: kernel API returns snake_case JSON. Decode-then-map so a
// malformed payload surfaces as a tagged KernelError instead of a runtime
// "cannot read property of undefined".
const optionalNullable = <A, I>(s: Schema.Schema<A, I>) =>
  Schema.optional(Schema.NullOr(s))

const KernelIssue = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  description: optionalNullable(Schema.String),
  status: IssueStatus,
  priority: optionalNullable(Priority),
  assignee_id: optionalNullable(Schema.String),
  assignee_name: optionalNullable(Schema.String),
  assignee_type: optionalNullable(AssigneeType),
  labels: optionalNullable(Schema.Array(Schema.String)),
  parent_id: optionalNullable(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  created_by_id: Schema.String,
  created_by_name: Schema.String,
  created_by_type: AssigneeType,
  session_ids: optionalNullable(Schema.Array(Schema.String)),
  total_cost_usd: optionalNullable(Schema.Number),
  total_tokens: optionalNullable(Schema.Number),
  pr_numbers: optionalNullable(Schema.Array(Schema.Number)),
  blocked_by: optionalNullable(Schema.Array(Schema.String)),
  blocking: optionalNullable(Schema.Array(Schema.String)),
  acceptance_criteria: optionalNullable(Schema.Array(Schema.String)),
})
type KernelIssue = typeof KernelIssue.Type

const KernelIssueArray = Schema.Array(KernelIssue)

const KernelProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  counter: optionalNullable(Schema.Number),
})

const KernelMoveResponse = Schema.Struct({ issue: KernelIssue })

const decodeAs = <A, I>(schema: Schema.Schema<A, I>, raw: unknown, context: string) =>
  Schema.decodeUnknown(schema)(raw).pipe(
    Effect.mapError(
      (e) => new KernelError({ message: `${context}: invalid kernel response — ${String(e)}` }),
    ),
  )

const toIssue = (raw: KernelIssue): Issue => ({
  id: raw.id as IssueId,
  projectId: raw.project_id as Issue["projectId"],
  title: raw.title,
  description: raw.description ?? undefined,
  status: raw.status,
  priority: raw.priority ?? "none",
  assignee: raw.assignee_id
    ? {
        id: raw.assignee_id,
        name: raw.assignee_name ?? raw.assignee_id,
        type: raw.assignee_type ?? "human",
      }
    : undefined,
  labels: raw.labels ?? [],
  parentId: (raw.parent_id ?? undefined) as Issue["parentId"],
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  createdBy: {
    id: raw.created_by_id,
    name: raw.created_by_name,
    type: raw.created_by_type,
  },
  sessionIds: raw.session_ids ?? [],
  totalCostUsd: raw.total_cost_usd ?? 0,
  totalTokens: raw.total_tokens ?? 0,
  prNumbers: raw.pr_numbers ?? [],
  blockedBy: (raw.blocked_by ?? []) as Issue["blockedBy"],
  blocking: (raw.blocking ?? []) as Issue["blocking"],
  acceptanceCriteria: raw.acceptance_criteria ?? [],
})

const toProject = (raw: typeof KernelProject.Type): Project => ({
  id: raw.id,
  name: raw.name,
  key: raw.key,
  autoIncrementCounter: raw.counter ?? 0,
})

const decodeIssue = (raw: unknown, context: string) =>
  Effect.map(decodeAs(KernelIssue, raw, context), toIssue)

const decodeIssueArray = (raw: unknown, context: string) =>
  Effect.map(decodeAs(KernelIssueArray, raw, context), (xs) => xs.map(toIssue))

const decodeProject = (raw: unknown, context: string) =>
  Effect.map(decodeAs(KernelProject, raw, context), toProject)

export const BoardServiceLive = Layer.effect(
  BoardService,
  Effect.gen(function* () {
    const client = yield* KernelClient

    return {
      createProject: (name: string, key: string) =>
        Effect.gen(function* () {
          const raw = yield* client.post("/api/board/projects", { name, key })
          return yield* decodeProject(raw, "createProject")
        }).pipe(
          Effect.catchTags({
            KernelError: (e) => Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
          })
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
          return yield* decodeIssue(raw, "createIssue")
        }).pipe(
          Effect.catchTags({
            KernelError: (e) => Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
          })
        ),

      getIssue: (issueId: IssueId) =>
        Effect.gen(function* () {
          const raw = yield* client.get(`/api/board/issues/${issueId}`)
          return yield* decodeIssue(raw, "getIssue")
        }).pipe(
          Effect.catchTags({
            KernelError: (e): Effect.Effect<never, BoardError | IssueNotFoundError> =>
              e.statusCode === 404
                ? Effect.fail(new IssueNotFoundError({ issueId }))
                : Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
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
          const raw = yield* client.get(`/api/board/issues${qs ? `?${qs}` : ""}`)
          return yield* decodeIssueArray(raw, "listIssues")
        }).pipe(
          Effect.catchTags({
            KernelError: (e) => Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
          })
        ),

      moveIssue: (issueId: IssueId, newStatus: IssueStatus, _note?: string) =>
        Effect.gen(function* () {
          const raw = yield* client.post(`/api/board/issues/${issueId}/move`, {
            status: newStatus,
            actor_id: "system",
            actor_name: "gctrl-board",
            actor_type: "agent",
          })
          const envelope = yield* decodeAs(KernelMoveResponse, raw, "moveIssue")
          return toIssue(envelope.issue)
        }).pipe(
          Effect.catchTags({
            KernelError: (e): Effect.Effect<never, BoardError | IssueNotFoundError> =>
              e.statusCode === 404
                ? Effect.fail(new IssueNotFoundError({ issueId }))
                : Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
          })
        ),

      assignIssue: (issueId: IssueId, assignee: Assignee) =>
        Effect.gen(function* () {
          const raw = yield* client.post(`/api/board/issues/${issueId}/assign`, {
            assignee_id: assignee.id,
            assignee_name: assignee.name,
            assignee_type: assignee.type,
          })
          return yield* decodeIssue(raw, "assignIssue")
        }).pipe(
          Effect.catchTags({
            KernelError: (e): Effect.Effect<never, BoardError | IssueNotFoundError> =>
              e.statusCode === 404
                ? Effect.fail(new IssueNotFoundError({ issueId }))
                : Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
          })
        ),

      decomposeIssue: (parentId: IssueId, subTasks: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const issues: Issue[] = []
          for (const title of subTasks) {
            const parentRaw = yield* client.get(`/api/board/issues/${parentId}`)
            const parent = yield* decodeAs(KernelIssue, parentRaw, "decomposeIssue.parent")
            const raw = yield* client.post("/api/board/issues", {
              project_id: parent.project_id,
              title,
              parent_id: parentId,
              created_by_id: parent.created_by_id,
              created_by_name: parent.created_by_name,
              created_by_type: parent.created_by_type,
            })
            issues.push(yield* decodeIssue(raw, "decomposeIssue.child"))
          }
          return issues
        }).pipe(
          Effect.catchTags({
            KernelError: (e): Effect.Effect<never, BoardError | IssueNotFoundError> =>
              e.statusCode === 404
                ? Effect.fail(new IssueNotFoundError({ issueId: parentId }))
                : Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
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
          Effect.catchTags({
            KernelError: (e): Effect.Effect<never, BoardError | IssueNotFoundError> =>
              e.statusCode === 404
                ? Effect.fail(new IssueNotFoundError({ issueId }))
                : Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
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
          Effect.catchTags({
            KernelError: (e): Effect.Effect<never, BoardError | IssueNotFoundError> =>
              e.statusCode === 404
                ? Effect.fail(new IssueNotFoundError({ issueId }))
                : Effect.fail(new BoardError({ message: e.message })),
            KernelUnavailableError: (e) => Effect.fail(new BoardError({ message: e.message })),
          })
        ),
    }
  })
)
