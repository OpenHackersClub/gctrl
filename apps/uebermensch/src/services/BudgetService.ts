import { Context, type Effect } from "effect"
import type { LlmError, VaultError } from "../errors.js"

export type BudgetSnapshot = {
  readonly date: string
  readonly dailyUsd: number
  readonly spentTodayUsd: number
  readonly remainingTodayUsd: number
  readonly perBriefUsd: number
}

export type BudgetLimits = {
  readonly dailyUsd: number
  readonly perBriefUsd: number
}

export interface BudgetServiceShape {
  readonly snapshot: (
    date: string,
    limits: BudgetLimits,
  ) => Effect.Effect<BudgetSnapshot, VaultError>
  readonly checkBefore: (
    date: string,
    limits: BudgetLimits,
  ) => Effect.Effect<BudgetSnapshot, LlmError | VaultError>
  readonly record: (
    entry: {
      readonly date: string
      readonly costUsd: number
      readonly promptHash: string
      readonly model: string
    },
  ) => Effect.Effect<void, VaultError>
}

export class BudgetService extends Context.Tag("uebermensch/BudgetService")<
  BudgetService,
  BudgetServiceShape
>() {}
