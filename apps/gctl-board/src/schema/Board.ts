import { Schema } from "effect"
import { IssueStatus } from "./Issue.js"

export const BoardId = Schema.String.pipe(Schema.brand("BoardId"))
export type BoardId = typeof BoardId.Type

export const Board = Schema.Struct({
  id: BoardId,
  projectId: Schema.String,
  name: Schema.String,
  columns: Schema.Array(IssueStatus),
  wipLimits: Schema.Record({ key: Schema.String, value: Schema.Number }),
})
export type Board = typeof Board.Type

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  key: Schema.String,
  defaultBoard: Schema.optional(BoardId),
  autoIncrementCounter: Schema.Number,
})
export type Project = typeof Project.Type
