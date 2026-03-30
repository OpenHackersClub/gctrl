import { Context, Effect } from "effect"
import type {
  Issue,
  IssueId,
  IssueStatus,
  IssueFilter,
  CreateIssueInput,
  Assignee,
  Project,
} from "../schema/index.js"
import type {
  BoardError,
  IssueNotFoundError,
  CyclicDependencyError,
  WipLimitExceededError,
} from "./errors.js"

export class BoardService extends Context.Tag("BoardService")<
  BoardService,
  {
    readonly createProject: (
      name: string,
      key: string
    ) => Effect.Effect<Project, BoardError>

    readonly createIssue: (
      input: CreateIssueInput
    ) => Effect.Effect<Issue, BoardError>

    readonly getIssue: (
      issueId: IssueId
    ) => Effect.Effect<Issue, BoardError | IssueNotFoundError>

    readonly listIssues: (
      filter: IssueFilter
    ) => Effect.Effect<ReadonlyArray<Issue>, BoardError>

    readonly moveIssue: (
      issueId: IssueId,
      newStatus: IssueStatus,
      note?: string
    ) => Effect.Effect<Issue, BoardError | IssueNotFoundError | WipLimitExceededError>

    readonly assignIssue: (
      issueId: IssueId,
      assignee: Assignee
    ) => Effect.Effect<Issue, BoardError | IssueNotFoundError>

    readonly decomposeIssue: (
      parentId: IssueId,
      subTasks: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<Issue>, BoardError | IssueNotFoundError>

    readonly blockIssue: (
      issueId: IssueId,
      blockedById: IssueId
    ) => Effect.Effect<void, BoardError | IssueNotFoundError | CyclicDependencyError>

    readonly unblockIssue: (
      issueId: IssueId,
      blockedById: IssueId
    ) => Effect.Effect<void, BoardError | IssueNotFoundError>

    readonly addComment: (
      issueId: IssueId,
      author: Assignee,
      body: string,
      sessionId?: string
    ) => Effect.Effect<void, BoardError | IssueNotFoundError>

    readonly linkSession: (
      issueId: IssueId,
      sessionId: string,
      costUsd: number,
      tokens: number
    ) => Effect.Effect<void, BoardError | IssueNotFoundError>
  }
>() {}
