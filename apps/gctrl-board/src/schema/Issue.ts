import { Schema } from "effect"

export const IssueId = Schema.String.pipe(Schema.brand("IssueId"))
export type IssueId = typeof IssueId.Type

export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type

export const IssueStatus = Schema.Literal(
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled"
)
export type IssueStatus = typeof IssueStatus.Type

export const Priority = Schema.Literal("urgent", "high", "medium", "low", "none")
export type Priority = typeof Priority.Type

export const AssigneeType = Schema.Literal("human", "agent")
export type AssigneeType = typeof AssigneeType.Type

export const Assignee = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: AssigneeType,
  deviceId: Schema.optional(Schema.String),
})
export type Assignee = typeof Assignee.Type

export const Issue = Schema.Struct({
  id: IssueId,
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: IssueStatus,
  priority: Priority,
  assignee: Schema.optional(Assignee),
  labels: Schema.Array(Schema.String),
  parentId: Schema.optional(IssueId),
  estimate: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: Assignee,

  // Execution linkage
  sessionIds: Schema.Array(Schema.String),
  totalCostUsd: Schema.Number,
  totalTokens: Schema.Number,
  prNumbers: Schema.Array(Schema.Number),

  // Agent coordination
  blockedBy: Schema.Array(IssueId),
  blocking: Schema.Array(IssueId),
  agentNotes: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
})
export type Issue = typeof Issue.Type

export const CreateIssueInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  priority: Schema.optional(Priority),
  labels: Schema.optional(Schema.Array(Schema.String)),
  parentId: Schema.optional(IssueId),
  estimate: Schema.optional(Schema.Number),
  createdBy: Assignee,
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
})
export type CreateIssueInput = typeof CreateIssueInput.Type

export const IssueFilter = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  status: Schema.optional(IssueStatus),
  priority: Schema.optional(Priority),
  assigneeId: Schema.optional(Schema.String),
  assigneeType: Schema.optional(AssigneeType),
  label: Schema.optional(Schema.String),
  parentId: Schema.optional(IssueId),
  unassigned: Schema.optional(Schema.Boolean),
})
export type IssueFilter = typeof IssueFilter.Type
