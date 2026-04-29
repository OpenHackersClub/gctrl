import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { FileSystemProfileLive } from "../adapters/FileSystemProfile.js"
import { ProfileError } from "../errors.js"
import { resolveVaultDir } from "../lib/env.js"
import {
  DIRECTIVES_PROFILE_FILE,
  DIRECTIVES_SOURCES_FILE,
  DIRECTIVES_TOPICS_FILE,
} from "../lib/vault-paths.js"
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
      yield* Console.log(
        `✓ ${DIRECTIVES_PROFILE_FILE}, ${DIRECTIVES_TOPICS_FILE}, ${DIRECTIVES_SOURCES_FILE} all valid`,
      )
      return
    }
    yield* Console.error("✗ validation issues:")
    for (const issue of issues) yield* Console.error(`  - ${issue}`)
    yield* Effect.fail(
      new ProfileError({
        message: `${issues.length} validation issue(s)`,
        issues,
      }),
    )
  }),
).pipe(
  Command.withDescription(
    `Validate ${DIRECTIVES_PROFILE_FILE} + ${DIRECTIVES_TOPICS_FILE} + ${DIRECTIVES_SOURCES_FILE} frontmatter`,
  ),
)

export const profile = Command.make("profile").pipe(
  Command.withSubcommands([validate]),
  Command.withDescription("Profile commands"),
)
