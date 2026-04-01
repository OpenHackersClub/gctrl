/**
 * audit — run build, lint, test, and acceptance criteria checks.
 *
 * Designed to be invoked by Claude Code skills or CI to gate PRs.
 * Each check prints PASS/FAIL with details; exits non-zero on any failure.
 */
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { execPromise, type CheckResult } from "../lib/exec"

const runCheck = (
  name: string,
  cmd: string,
  cwd: string
): Effect.Effect<CheckResult, never> =>
  Effect.gen(function* () {
    yield* Console.log(`\n--- ${name} ---`)
    const result = yield* execPromise(cmd, cwd)
    if (result.ok) {
      yield* Console.log(`PASS: ${name}`)
    } else {
      yield* Console.log(`FAIL: ${name}`)
      yield* Console.log(result.output)
    }
    return result
  })

const checkAcceptanceCriteria = (
  cwd: string
): Effect.Effect<CheckResult, never> =>
  Effect.gen(function* () {
    yield* Console.log("\n--- Acceptance Criteria ---")

    // Check for specs with acceptance criteria
    const specSearch = yield* execPromise(
      "grep -r 'acceptance_criteria\\|Acceptance Criteria\\|## AC\\|\\- \\[[ x]\\]' specs/ --include='*.md' -l 2>/dev/null || true",
      cwd
    )

    // Check for unchecked acceptance criteria items
    const unchecked = yield* execPromise(
      "grep -rn '\\- \\[ \\]' specs/ --include='*.md' 2>/dev/null || true",
      cwd
    )

    const specFiles = specSearch.output.trim().split("\n").filter(Boolean)
    const uncheckedLines = unchecked.output.trim().split("\n").filter(Boolean)

    if (specFiles.length > 0) {
      yield* Console.log(`Spec files with criteria: ${specFiles.length}`)
    }

    if (uncheckedLines.length > 0) {
      yield* Console.log(`Unchecked items: ${uncheckedLines.length}`)
      for (const line of uncheckedLines.slice(0, 10)) {
        yield* Console.log(`  ${line}`)
      }
      if (uncheckedLines.length > 10) {
        yield* Console.log(`  ... and ${uncheckedLines.length - 10} more`)
      }
      yield* Console.log("WARN: Acceptance criteria have unchecked items")
      return { ok: true, output: `${uncheckedLines.length} unchecked items` }
    }

    yield* Console.log("PASS: Acceptance Criteria (no unchecked items)")
    return { ok: true, output: "" }
  })

const fix = Options.boolean("fix").pipe(
  Options.withDescription("Auto-fix lint issues where possible"),
  Options.withDefault(false)
)

const skipTests = Options.boolean("skip-tests").pipe(
  Options.withDescription("Skip running tests"),
  Options.withDefault(false)
)

export const auditCommand = Command.make(
  "audit",
  { fix, skipTests },
  ({ fix, skipTests }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      yield* Console.log("gctl audit — codebase quality gate")
      yield* Console.log(`cwd: ${cwd}`)

      const results: CheckResult[] = []

      // 1. Build
      const build = yield* runCheck("Build", "npm run build", cwd)
      results.push(build)

      // 2. Lint
      const lintCmd = fix
        ? "npx biome lint --write shell/*/src/ apps/*/src/"
        : "npx biome lint shell/*/src/ apps/*/src/"
      const lint = yield* runCheck("Biome Lint", lintCmd, cwd)
      results.push(lint)

      // 3. Tests
      if (!skipTests) {
        const tests = yield* runCheck("Tests (TS)", "npm run test:ts", cwd)
        results.push(tests)
      } else {
        yield* Console.log("\n--- Tests (TS) ---\nSKIPPED")
      }

      // 4. Acceptance criteria
      const ac = yield* checkAcceptanceCriteria(cwd)
      results.push(ac)

      // Summary
      const passed = results.filter((r) => r.ok).length
      const failed = results.filter((r) => !r.ok).length

      yield* Console.log("\n========== AUDIT SUMMARY ==========")
      yield* Console.log(`PASSED: ${passed}  FAILED: ${failed}`)

      if (failed > 0) {
        yield* Console.log("Audit FAILED — fix issues before PR.")
        return yield* Effect.fail(new Error("Audit failed"))
      }

      yield* Console.log("Audit PASSED — ready for PR.")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(String(e)).pipe(Effect.flatMap(() => Effect.fail(e)))
      )
    )
)
