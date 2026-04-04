import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { KernelClient } from "../src/services/KernelClient"
import { createMockKernelClient } from "./helpers/mock-kernel"

// --- schemas (mirroring inbox.ts) ---

const InboxMessage = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  source: Schema.String,
  kind: Schema.String,
  urgency: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  requires_action: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
})
const InboxMessageList = Schema.Array(InboxMessage)

const InboxThreadWithMessages = Schema.Struct({
  id: Schema.String,
  context_type: Schema.String,
  context_ref: Schema.String,
  title: Schema.String,
  project_key: Schema.optional(Schema.NullOr(Schema.String)),
  pending_count: Schema.Number,
  latest_urgency: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  messages: Schema.Array(InboxMessage),
})

const InboxAction = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  thread_id: Schema.String,
  actor_id: Schema.String,
  actor_name: Schema.String,
  action_type: Schema.String,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
})
const InboxActionList = Schema.Array(InboxAction)

const InboxStats = Schema.Struct({
  total: Schema.Number,
  pending: Schema.Number,
  by_urgency: Schema.Unknown,
  by_kind: Schema.Unknown,
})

const ActionResponse = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  action_type: Schema.String,
})

const BatchActionResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      message_id: Schema.String,
      result: Schema.String,
      skip_reason: Schema.optional(Schema.NullOr(Schema.String)),
    })
  ),
})

// --- mock data ---

const mockMessage = {
  id: "msg-1",
  thread_id: "thr-1",
  source: "guardrail",
  kind: "permission_request",
  urgency: "high",
  title: "Agent requests force-push",
  body: "Details here",
  status: "pending",
  requires_action: true,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
}

const mockThread = {
  id: "thr-1",
  context_type: "issue",
  context_ref: "BACK-42",
  title: "BACK-42: Fix auth",
  project_key: "BACK",
  pending_count: 2,
  latest_urgency: "high",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  messages: [mockMessage],
}

const mockAction = {
  id: "act-1",
  message_id: "msg-1",
  thread_id: "thr-1",
  actor_id: "shell",
  actor_name: "gctl-shell",
  action_type: "approve",
  reason: "verified safe",
  created_at: "2026-04-01T00:00:00Z",
}

const mockActionResponse = {
  id: "act-1",
  message_id: "msg-1",
  action_type: "approve",
}

const mockStats = {
  total: 5,
  pending: 3,
  by_urgency: { critical: 1, high: 2 },
  by_kind: { permission_request: 3, status_update: 2 },
}

const mockBatchResult = {
  results: [
    { message_id: "msg-1", result: "success", skip_reason: null },
    { message_id: "msg-2", result: "skipped", skip_reason: "status is acted" },
  ],
}

const MockLayer = createMockKernelClient(
  {
    "/api/inbox/messages": [mockMessage],
    "/api/inbox/messages/msg-1": mockMessage,
    "/api/inbox/threads/thr-1": mockThread,
    "/api/inbox/actions": [mockAction],
    "/api/inbox/stats": mockStats,
  },
  {
    "/api/inbox/actions": mockActionResponse,
    "/api/inbox/batch-action": mockBatchResult,
  }
)

const EmptyMockLayer = createMockKernelClient(
  {
    "/api/inbox/messages": [],
    "/api/inbox/stats": { total: 0, pending: 0, by_urgency: {}, by_kind: {} },
  },
  {}
)

describe("Inbox commands (via KernelClient)", () => {
  it("list messages returns array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/messages", InboxMessageList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("msg-1")
    expect(result[0].kind).toBe("permission_request")
  })

  it("list messages with filters", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get(
        "/api/inbox/messages?urgency=high&status=pending",
        InboxMessageList
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].urgency).toBe("high")
    expect(result[0].status).toBe("pending")
  })

  it("view single message", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/messages/msg-1", InboxMessage)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("msg-1")
    expect(result.title).toBe("Agent requests force-push")
    expect(result.requires_action).toBe(true)
  })

  it("view thread with messages", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/threads/thr-1", InboxThreadWithMessages)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("thr-1")
    expect(result.title).toBe("BACK-42: Fix auth")
    expect(result.pending_count).toBe(2)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe("msg-1")
  })

  it("count shows pending summary", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/stats", InboxStats)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.pending).toBe(3)
  })

  it("approve creates action", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/inbox/actions",
        {
          message_id: "msg-1",
          action_type: "approve",
          actor_id: "shell",
          actor_name: "gctl-shell",
        },
        ActionResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("act-1")
    expect(result.message_id).toBe("msg-1")
    expect(result.action_type).toBe("approve")
  })

  it("deny creates action", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/inbox/actions",
        {
          message_id: "msg-1",
          action_type: "deny",
          reason: "unsafe operation",
          actor_id: "shell",
          actor_name: "gctl-shell",
        },
        ActionResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.message_id).toBe("msg-1")
    expect(result.action_type).toBe("approve") // mock returns fixed response
  })

  it("acknowledge creates action", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/inbox/actions",
        {
          message_id: "msg-1",
          action_type: "acknowledge",
          actor_id: "shell",
          actor_name: "gctl-shell",
        },
        ActionResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.id).toBe("act-1")
    expect(result.message_id).toBe("msg-1")
  })

  it("batch approve returns per-message results", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.post(
        "/api/inbox/batch-action",
        {
          message_ids: ["msg-1", "msg-2"],
          action_type: "approve",
          actor_id: "shell",
          actor_name: "gctl-shell",
        },
        BatchActionResponse
      )
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.results).toHaveLength(2)
    expect(result.results[0].message_id).toBe("msg-1")
    expect(result.results[0].result).toBe("success")
    expect(result.results[1].message_id).toBe("msg-2")
    expect(result.results[1].result).toBe("skipped")
    expect(result.results[1].skip_reason).toBe("status is acted")
  })

  it("list actions", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/actions", InboxActionList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("act-1")
    expect(result[0].action_type).toBe("approve")
    expect(result[0].actor_name).toBe("gctl-shell")
  })

  it("stats returns full breakdown", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/stats", InboxStats)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(MockLayer)))
    expect(result.total).toBe(5)
    expect(result.pending).toBe(3)

    const byUrgency = result.by_urgency as Record<string, number>
    expect(byUrgency.critical).toBe(1)
    expect(byUrgency.high).toBe(2)

    const byKind = result.by_kind as Record<string, number>
    expect(byKind.permission_request).toBe(3)
    expect(byKind.status_update).toBe(2)
  })

  it("empty inbox list returns empty array", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/messages", InboxMessageList)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyMockLayer)))
    expect(result).toHaveLength(0)
  })

  it("empty stats returns zeros", async () => {
    const program = Effect.gen(function* () {
      const kernel = yield* KernelClient
      return yield* kernel.get("/api/inbox/stats", InboxStats)
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(EmptyMockLayer)))
    expect(result.total).toBe(0)
    expect(result.pending).toBe(0)
  })
})
