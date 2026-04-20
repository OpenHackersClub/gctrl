import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { FileBudgetLedgerLive } from "../src/adapters/FileBudgetLedger.js"
import { BudgetService } from "../src/services/BudgetService.js"

const LIMITS = { dailyUsd: 1.0, perBriefUsd: 0.25 }

const run = <A, E>(vaultDir: string, eff: (svc: typeof BudgetService.Service) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* BudgetService
      return yield* eff(svc)
    }).pipe(Effect.provide(FileBudgetLedgerLive(vaultDir))),
  )

describe("FileBudgetLedger", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-budget-"))
  })

  it("returns zero spend + full remaining when no ledger exists", async () => {
    const exit = await run(vaultDir, (svc) => svc.snapshot("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.spentTodayUsd).toBe(0)
    expect(exit.value.remainingTodayUsd).toBe(1.0)
  })

  it("sums only entries matching the requested date", async () => {
    await mkdir(join(vaultDir, ".uber"), { recursive: true })
    const lines = [
      '{"date":"2026-04-19","cost_usd":0.3,"prompt_hash":"x","model":"m","ts":"t"}',
      '{"date":"2026-04-20","cost_usd":0.15,"prompt_hash":"y","model":"m","ts":"t"}',
      '{"date":"2026-04-20","cost_usd":0.10,"prompt_hash":"z","model":"m","ts":"t"}',
    ]
    await writeFile(join(vaultDir, ".uber", "spend.jsonl"), `${lines.join("\n")}\n`)

    const exit = await run(vaultDir, (svc) => svc.snapshot("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.spentTodayUsd).toBeCloseTo(0.25, 6)
    expect(exit.value.remainingTodayUsd).toBeCloseTo(0.75, 6)
  })

  it("checkBefore fails with kind=budget_exceeded when daily is exhausted", async () => {
    await mkdir(join(vaultDir, ".uber"), { recursive: true })
    await writeFile(
      join(vaultDir, ".uber", "spend.jsonl"),
      '{"date":"2026-04-20","cost_usd":1.5,"prompt_hash":"x","model":"m","ts":"t"}\n',
    )
    const exit = await run(vaultDir, (svc) => svc.checkBefore("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("budget_exceeded")
      expect(cause).toContain("daily budget exhausted")
    }
  })

  it("checkBefore fails when remaining < per_brief_usd", async () => {
    await mkdir(join(vaultDir, ".uber"), { recursive: true })
    // daily=$1, per_brief=$0.25, spent $0.85 → remaining $0.15 < $0.25
    await writeFile(
      join(vaultDir, ".uber", "spend.jsonl"),
      '{"date":"2026-04-20","cost_usd":0.85,"prompt_hash":"x","model":"m","ts":"t"}\n',
    )
    const exit = await run(vaultDir, (svc) => svc.checkBefore("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause)
      expect(cause).toContain("budget_exceeded")
      expect(cause).toContain("less than per_brief_usd")
    }
  })

  it("checkBefore passes when remaining >= per_brief_usd", async () => {
    const exit = await run(vaultDir, (svc) => svc.checkBefore("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Success")
  })

  it("record appends JSONL line to <vault>/.uber/spend.jsonl", async () => {
    const exit = await run(vaultDir, (svc) =>
      svc.record({
        date: "2026-04-20",
        costUsd: 0.123456,
        promptHash: "sha256:abc",
        model: "claude-sonnet-4-6",
      }),
    )
    expect(exit._tag).toBe("Success")
    const raw = await readFile(join(vaultDir, ".uber", "spend.jsonl"), "utf8")
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.date).toBe("2026-04-20")
    expect(parsed.cost_usd).toBeCloseTo(0.123456, 6)
    expect(parsed.prompt_hash).toBe("sha256:abc")
    expect(parsed.model).toBe("claude-sonnet-4-6")
    expect(typeof parsed.ts).toBe("string")
  })

  it("record then snapshot sees the appended cost", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* BudgetService
        yield* svc.record({
          date: "2026-04-20",
          costUsd: 0.4,
          promptHash: "h1",
          model: "m",
        })
        yield* svc.record({
          date: "2026-04-20",
          costUsd: 0.3,
          promptHash: "h2",
          model: "m",
        })
      }).pipe(Effect.provide(FileBudgetLedgerLive(vaultDir))),
    )
    const exit = await run(vaultDir, (svc) => svc.snapshot("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.spentTodayUsd).toBeCloseTo(0.7, 6)
    expect(exit.value.remainingTodayUsd).toBeCloseTo(0.3, 6)
  })

  it("tolerates corrupt ledger lines", async () => {
    await mkdir(join(vaultDir, ".uber"), { recursive: true })
    const lines = [
      '{"date":"2026-04-20","cost_usd":0.1,"prompt_hash":"x","model":"m","ts":"t"}',
      "not-json-at-all",
      '{"date":"2026-04-20","cost_usd":0.2,"prompt_hash":"y","model":"m","ts":"t"}',
    ]
    await writeFile(join(vaultDir, ".uber", "spend.jsonl"), `${lines.join("\n")}\n`)
    const exit = await run(vaultDir, (svc) => svc.snapshot("2026-04-20", LIMITS))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.spentTodayUsd).toBeCloseTo(0.3, 6)
  })
})
