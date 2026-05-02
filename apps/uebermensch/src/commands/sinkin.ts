/**
 * `uber sinkin` — open and close SinkIn sessions, vault-only.
 *
 * M0 scope: scaffolding only — generates a session id, scans the vault to
 * count pages, logs the result. The actual gap-pass + answer-pass LLM stages
 * (per apps/uebermensch/vault/specs/sinkin.md) land in a follow-up that wires
 * the prompt templates in directives/personas/sinkin-{gap,answer}.md through
 * the existing `LlmService`.
 *
 * Pre-eject this command upserted a row into the kernel's
 * `uber_sinkin_sessions` table via `/api/uber/sinkin/sessions`. That table +
 * route are gone in the eject (vault is the source of truth across all uber
 * data); session metadata will land in `apps/uebermensch/vault/data/sinkin/`
 * when the real LLM passes are wired up.
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
  Options.withDescription("Scan + report only — do not record the session"),
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

      // M0 scaffold: count vault pages so the closing log carries real signal.
      // Real gap/answer LLM pipeline lands in a follow-up.
      const program = Effect.gen(function* () {
        const vaultSvc = yield* VaultService
        const slugs = yield* vaultSvc.listSlugs()
        return slugs.size
      })
      const pagesScanned = yield* program.pipe(
        Effect.provide(FileSystemVaultLive(vaultDir)),
      )

      yield* Console.log(`  ${pagesScanned} page(s) scanned`)
      yield* Console.log("  (M0 scaffold: gap/answer passes deferred to follow-up)")

      if (dryRun) {
        yield* Console.log("(dry-run — not recording session)")
        return
      }

      yield* Console.log(`✓ session ${sessionId} closed`)
    }),
).pipe(
  Command.withDescription(
    "Scan vault + scaffold a SinkIn session (M0; gap/answer LLM passes TBD)",
  ),
)
