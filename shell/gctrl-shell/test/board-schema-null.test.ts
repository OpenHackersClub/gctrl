import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { BoardIssue } from "../src/commands/board"

// Regression: kernel `Option<T>` fields land on the wire as JSON `null`
// (not omitted). `Schema.optional(Schema.String)` rejects null and fails
// the entire `Schema.Array(BoardIssue)` decode, which manifested as
// `gctrl board issues list` showing zero issues against a kernel that
// held 32+. Lock in null-tolerance against the real exported schema so
// a future "tighten the schema" refactor can't silently re-break it.

describe("BoardIssue schema null tolerance", () => {
  it("decodes a wire payload with null assignee/description/github fields", async () => {
    const wire = [
      {
        id: "iss-1",
        project_id: "proj-1",
        title: "Test issue",
        description: null,
        status: "backlog",
        priority: "high",
        // Every Option<String> field on the kernel side serializes null:
        assignee_id: null,
        assignee_name: null,
        assignee_type: null,
        labels: [],
        created_at: "2026-05-06T00:00:00Z",
        updated_at: "2026-05-06T00:00:00Z",
        created_by_id: "debuggingfuture",
        created_by_name: "debuggingfuture",
        created_by_type: "human",
        github_issue_number: null,
        github_url: null,
      },
    ]

    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(Schema.Array(BoardIssue))(wire)
    )

    expect(decoded).toHaveLength(1)
    expect(decoded[0].id).toBe("iss-1")
    // Null-flavored fields should round-trip as null (not undefined) so
    // downstream `!= null` checks behave the same way they do in prod.
    expect(decoded[0].assignee_id).toBeNull()
    expect(decoded[0].github_issue_number).toBeNull()
  })

  it("still decodes when nullable fields are simply absent", async () => {
    // Older kernel builds and our own POST handlers may omit fields entirely
    // rather than emit explicit nulls. Both shapes must work.
    const wire = [
      {
        id: "iss-2",
        project_id: "proj-1",
        title: "Minimal issue",
        status: "todo",
        priority: "none",
        labels: [],
        created_at: "2026-05-06T00:00:00Z",
        updated_at: "2026-05-06T00:00:00Z",
      },
    ]

    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(Schema.Array(BoardIssue))(wire)
    )

    expect(decoded).toHaveLength(1)
    expect(decoded[0].assignee_id).toBeUndefined()
  })
})
