import { Context, Effect } from "effect"
import type { IssueId } from "../schema/index.js"
import type { CyclicDependencyError, BoardError } from "./errors.js"

export class DependencyResolver extends Context.Tag("DependencyResolver")<
  DependencyResolver,
  {
    readonly addDependency: (
      issueId: IssueId,
      blockedById: IssueId
    ) => Effect.Effect<void, CyclicDependencyError | BoardError>

    readonly removeDependency: (
      issueId: IssueId,
      blockedById: IssueId
    ) => Effect.Effect<void, BoardError>

    readonly getBlocked: (
      issueId: IssueId
    ) => Effect.Effect<ReadonlyArray<IssueId>, BoardError>

    readonly getBlocking: (
      issueId: IssueId
    ) => Effect.Effect<ReadonlyArray<IssueId>, BoardError>

    readonly resolveDependency: (
      completedIssueId: IssueId
    ) => Effect.Effect<ReadonlyArray<IssueId>, BoardError>

    readonly hasCycle: (
      issueId: IssueId,
      blockedById: IssueId
    ) => Effect.Effect<boolean, BoardError>
  }
>() {}
