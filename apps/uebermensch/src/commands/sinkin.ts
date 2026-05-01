/**
 * `uber sinkin` — open and close SinkIn sessions through the kernel.
 *
 * M0 scope: scaffolding only — registers a session row at start, scans the
 * vault to count pages, and closes the session with `pages_scanned`. The
 * actual gap-pass + answer-pass LLM stages (per
 * apps/uebermensch/vault/specs/sinkin.md) land in a follow-up that wires
 * the prompt templates in directives/personas/sinkin-{gap,answer}.md
 * through the existing `LlmService`.
 */
import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { FileSystemVaultLive } from "../adapters/FileSystemVault.js"
import { resolveVaultDir } from "../lib/env.js"
import { VaultService } from "../services/VaultService.js"

const scopeTopicOpt = Options.text("topic").pipe(
  Options.withDescription("Restrict the pass to one topic slug"),
  Options.optional,
)

const scopeThesisOpt = Options.text("thesis").pipe(
  Options.withDescription("Restrict the pass to one thesis slug"),
  Options.optional,
)

const dryRunOpt = Options.boolean("dry-run").pipe(
  Options.withDescription("Scan + report only — do not POST to the kernel"),
  Options.withDefault(false),
)

const newSessionId = (): string => {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/T/, "-")
    .replace(/Z$/, "")
  const rand = Math.random().toString(36).slice(2, 8)
  return `sinkin-${ts}-${rand}`
}

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

type UpsertArgs = {
  readonly id: string
  readonly status: "running" | "completed" | "failed"
  readonly mode: "manual"
  readonly scopeKind?: string
  readonly scopeValue?: string
  readonly pagesScanned?: number
  readonly gapsFound?: number
  readonly gapsAnswered?: number
  readonly connectionsFound?: number
  readonly costUsd?: number
  readonly model?: string
  readonly promptHash?: string
  readonly failedReason?: string
  readonly completedAt?: string
}

const upsertKernelSession = (args: UpsertArgs) =>
  Effect.tryPromise({
    try: async () => {
      const resp = await fetch(`${kernelBase()}/api/uber/sinkin/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: args.id,
          status: args.status,
          mode: args.mode,
          scope_kind: args.scopeKind,
          scope_value: args.scopeValue,
          pages_scanned: args.pagesScanned,
          gaps_found: args.gapsFound,
          gaps_answered: args.gapsAnswered,
          connections_found: args.connectionsFound,
          cost_usd: args.costUsd,
          model: args.model,
          prompt_hash: args.promptHash,
          failed_reason: args.failedReason,
          completed_at: args.completedAt,
        }),
      })
      return resp.ok
    },
    catch: (e) => new Error(String(e)),
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))

export const sinkin = Command.make(
  "sinkin",
  { scopeTopicOpt, scopeThesisOpt, dryRunOpt },
  ({ scopeTopicOpt: topic, scopeThesisOpt: thesis, dryRunOpt: dryRun }) =>
    Effect.gen(function* () {
      const vaultDir = yield* resolveVaultDir()
      const sessionId = newSessionId()

      const scopeKind = Option.isSome(thesis)
        ? "thesis"
        : Option.isSome(topic)
          ? "topic"
          : undefined
      const scopeValue = Option.getOrUndefined(thesis) ?? Option.getOrUndefined(topic)

      yield* Console.log(
        `sinkin run ${sessionId} (vault=${vaultDir}, scope=${scopeKind ?? "all"}${
          scopeValue ? `:${scopeValue}` : ""
        }, dry-run=${dryRun})`,
      )

      // Open the session in the kernel index.
      if (!dryRun) {
        const opened = yield* upsertKernelSession({
          id: sessionId,
          status: "running",
          mode: "manual",
          scopeKind,
          scopeValue,
        })
        if (!opened) {
          yield* Console.log("(kernel offline — proceeding without index)")
        }
      }

      // M0 scaffold: count vault pages so the closed row carries real signal.
      // Real gap/answer LLM pipeline lands in a follow-up.
      const program = Effect.gen(function* () {
        const vaultSvc = yield* VaultService
        const slugs = yield* vaultSvc.listSlugs()
        return slugs.length
      })
      const pagesScanned = yield* program.pipe(
        Effect.provide(FileSystemVaultLive(vaultDir)),
      )

      yield* Console.log(`  ${pagesScanned} page(s) scanned`)
      yield* Console.log("  (M0 scaffold: gap/answer passes deferred to follow-up)")

      if (dryRun) {
        yield* Console.log("(dry-run — not closing session)")
        return
      }

      const closed = yield* upsertKernelSession({
        id: sessionId,
        status: "completed",
        mode: "manual",
        scopeKind,
        scopeValue,
        pagesScanned,
        gapsFound: 0,
        gapsAnswered: 0,
        connectionsFound: 0,
        costUsd: 0,
        completedAt: new Date().toISOString(),
      })
      if (closed) {
        yield* Console.log(`✓ session ${sessionId} closed`)
      } else {
        yield* Console.log(`(kernel offline — session ${sessionId} not indexed)`)
      }
    }),
).pipe(
  Command.withDescription(
    "Open + close a SinkIn session in the kernel index (M0 scaffold; LLM passes TBD)",
  ),
)
