import { Schema } from "effect"

export class BoardError extends Schema.TaggedError<BoardError>()(
  "BoardError",
  { message: Schema.String }
) {}

export class IssueNotFoundError extends Schema.TaggedError<IssueNotFoundError>()(
  "IssueNotFoundError",
  { issueId: Schema.String }
) {}

export class CyclicDependencyError extends Schema.TaggedError<CyclicDependencyError>()(
  "CyclicDependencyError",
  { issueIds: Schema.Array(Schema.String) }
) {}

export class WipLimitExceededError extends Schema.TaggedError<WipLimitExceededError>()(
  "WipLimitExceededError",
  { column: Schema.String, limit: Schema.Number, current: Schema.Number }
) {}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: Schema.String }
) {}
