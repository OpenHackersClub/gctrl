import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import { LlmError, VaultError } from "../errors.js"
import { BudgetService } from "../services/BudgetService.js"

type LedgerEntry = {
  readonly date: string
  readonly cost_usd: number
  readonly prompt_hash: string
  readonly model: string
  readonly ts: string
}

const readLedger = async (path: string): Promise<ReadonlyArray<LedgerEntry>> => {
  try {
    const raw = await readFile(path, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    const entries: Array<LedgerEntry> = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as LedgerEntry
        if (parsed && typeof parsed.date === "string" && typeof parsed.cost_usd === "number") {
          entries.push(parsed)
        }
      } catch {
        // skip corrupt line
      }
    }
    return entries
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
}

const sumSpent = (entries: ReadonlyArray<LedgerEntry>, date: string): number =>
  entries.filter((e) => e.date === date).reduce((acc, e) => acc + e.cost_usd, 0)

export const FileBudgetLedgerLive = (vaultDir: string) => {
  const ledgerPath = join(vaultDir, ".uber", "spend.jsonl")

  const loadSpent = (date: string) =>
    Effect.tryPromise({
      try: async () => sumSpent(await readLedger(ledgerPath), date),
      catch: (e) =>
        new VaultError({
          message: `read spend ledger failed: ${String(e)}`,
          path: ledgerPath,
        }),
    })

  return Layer.succeed(BudgetService, {
    snapshot: (date, limits) =>
      Effect.gen(function* () {
        const spent = yield* loadSpent(date)
        const remaining = Math.max(0, limits.dailyUsd - spent)
        return {
          date,
          dailyUsd: limits.dailyUsd,
          spentTodayUsd: spent,
          remainingTodayUsd: remaining,
          perBriefUsd: limits.perBriefUsd,
        }
      }),
    checkBefore: (date, limits) =>
      Effect.gen(function* () {
        const snap = yield* loadSpent(date).pipe(
          Effect.map((spent) => ({
            date,
            dailyUsd: limits.dailyUsd,
            spentTodayUsd: spent,
            remainingTodayUsd: Math.max(0, limits.dailyUsd - spent),
            perBriefUsd: limits.perBriefUsd,
          })),
        )
        if (snap.remainingTodayUsd <= 0) {
          return yield* Effect.fail(
            new LlmError({
              message: `daily budget exhausted for ${date}: spent $${snap.spentTodayUsd.toFixed(
                4,
              )} / $${limits.dailyUsd.toFixed(2)}`,
              kind: "budget_exceeded",
            }),
          )
        }
        if (snap.remainingTodayUsd < limits.perBriefUsd) {
          return yield* Effect.fail(
            new LlmError({
              message: `remaining $${snap.remainingTodayUsd.toFixed(
                4,
              )} less than per_brief_usd $${limits.perBriefUsd.toFixed(2)}`,
              kind: "budget_exceeded",
            }),
          )
        }
        return snap
      }),
    record: (entry) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(ledgerPath), { recursive: true })
          const line: LedgerEntry = {
            date: entry.date,
            cost_usd: entry.costUsd,
            prompt_hash: entry.promptHash,
            model: entry.model,
            ts: new Date().toISOString(),
          }
          await appendFile(ledgerPath, `${JSON.stringify(line)}\n`, "utf8")
        },
        catch: (e) =>
          new VaultError({
            message: `append spend ledger failed: ${String(e)}`,
            path: ledgerPath,
          }),
      }),
  })
}
