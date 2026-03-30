import { Schema } from "effect"
import type { IssueId } from "./Issue.js"
import { Assignee } from "./Issue.js"

export const IssueEventType = Schema.Literal(
  "created",
  "status_changed",
  "assigned",
  "unassigned",
  "comment_added",
  "label_added",
  "label_removed",
  "linked_session",
  "linked_pr",
  "estimate_changed",
  "priority_changed",
  "decomposed",
  "blocked",
  "unblocked"
)
export type IssueEventType = typeof IssueEventType.Type

export const IssueEvent = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  type: IssueEventType,
  actor: Assignee,
  timestamp: Schema.String,
  data: Schema.Unknown,
})
export type IssueEvent = typeof IssueEvent.Type

export const Comment = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  author: Assignee,
  body: Schema.String,
  createdAt: Schema.String,
  sessionId: Schema.optional(Schema.String),
})
export type Comment = typeof Comment.Type
