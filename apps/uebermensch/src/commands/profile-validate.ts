import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { resolveVaultDir } from "../lib/env.js"
import { ProfileService } from "../services/ProfileService.js"

const validate = Command.make("validate", {}, () =>
  Effect.gen(function* () {
    const vaultDir = yield* resolveVaultDir()
    yield* Console.log(`validating profile at ${vaultDir}`)
    const issues = yield* Effect.gen(function* () {
      const service = yield* ProfileService
      return yield* service.validate()
    }).pipe(Effect.provide(FileSystemProfileLive(vaultDir)))
    if (issues.length === 0) {
      yield* Console.log("✓ profile.md, topics.md, sources.md all valid")
      return
    }
    yield* Console.error("✗ validation issues:")
    for (const issue of issues) yield* Console.error(`  - ${issue}`)
    yield* Effect.fail(new Error(`${issues.length} validation issue(s)`))
  }),
).pipe(Command.withDescription("Validate profile.md + topics.md + sources.md frontmatter"))

export const profile = Command.make("profile").pipe(
  Command.withSubcommands([validate]),
  Command.withDescription("Profile commands"),
)
