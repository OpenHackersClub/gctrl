import { describe, expect, it } from "vitest"
import type { InboxMessage, InboxThread } from "../../types"
import { UNGROUPED_PROJECT, groupMessagesByProject, projectOptions } from "../inbox-group"

const thread = (id: string, project_key?: string): InboxThread => ({
  id,
  context_type: "session",
  context_ref: `ref-${id}`,
  title: `Thread ${id}`,
  project_key,
  pending_count: 0,
  latest_urgency: "medium",
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
})

const message = (id: string, thread_id: string): InboxMessage => ({
  id,
  thread_id,
  source: "agent",
  kind: "agent_question",
  urgency: "medium",
  title: `Message ${id}`,
  context: {},
  status: "pending",
  requires_action: false,
  duplicate_count: 0,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
})

describe("groupMessagesByProject", () => {
  it("groups messages by their thread's project_key, alphabetical", () => {
    const threads = [thread("t1", "widget"), thread("t2", "acme"), thread("t3", "acme")]
    const messages = [message("m1", "t1"), message("m2", "t2"), message("m3", "t3")]

    const groups = groupMessagesByProject(messages, threads)

    expect(groups.map((g) => g.project)).toEqual(["acme", "widget"])
    expect(groups[0].messages.map((m) => m.id)).toEqual(["m2", "m3"])
    expect(groups[1].messages.map((m) => m.id)).toEqual(["m1"])
  })

  it("buckets messages without a project last", () => {
    const threads = [thread("t1", "widget"), thread("t2")]
    const messages = [message("m1", "t2"), message("m2", "t1"), message("m3", "unknown-thread")]

    const groups = groupMessagesByProject(messages, threads)

    expect(groups.map((g) => g.project)).toEqual(["widget", UNGROUPED_PROJECT])
    expect(groups[1].messages.map((m) => m.id)).toEqual(["m1", "m3"])
  })

  it("preserves message order within a group", () => {
    const threads = [thread("t1", "acme")]
    const messages = [message("m3", "t1"), message("m1", "t1"), message("m2", "t1")]

    const groups = groupMessagesByProject(messages, threads)

    expect(groups[0].messages.map((m) => m.id)).toEqual(["m3", "m1", "m2"])
  })

  it("returns no groups for no messages", () => {
    expect(groupMessagesByProject([], [thread("t1", "acme")])).toEqual([])
  })
})

describe("projectOptions", () => {
  it("returns distinct sorted project keys, skipping threads without one", () => {
    const threads = [
      thread("t1", "widget"),
      thread("t2", "acme"),
      thread("t3", "acme"),
      thread("t4"),
    ]
    expect(projectOptions(threads)).toEqual(["acme", "widget"])
  })
})
