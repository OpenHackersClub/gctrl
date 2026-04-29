import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Either, Layer, Schema } from "effect"
import matter from "gray-matter"
import { ProfileError, VaultError } from "../errors.js"
import {
  DIRECTIVES_AVOID_FILE,
  DIRECTIVES_ME_FILE,
  DIRECTIVES_PROFILE_FILE,
  DIRECTIVES_PROJECTS_FILE,
  DIRECTIVES_SOURCES_FILE,
  DIRECTIVES_TOPICS_FILE,
} from "../lib/vault-paths.js"
import { ProfileConfig, SourcesConfig, TopicsConfig } from "../schemas.js"
import { ProfileService } from "../services/ProfileService.js"

const readOrFail = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (e) => new VaultError({ message: `read failed: ${String(e)}`, path }),
  })

const readOptional = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8").catch(() => ""),
    catch: () => new VaultError({ message: "read failed", path }),
  })

const parseFrontmatter = <A, I>(
  text: string,
  schema: Schema.Schema<A, I>,
  file: string,
): Effect.Effect<A, ProfileError> =>
  Effect.try({
    try: () => matter(text).data as unknown,
    catch: (e) =>
      new ProfileError({ message: `${file}: frontmatter parse failed: ${String(e)}` }),
  }).pipe(
    Effect.flatMap((data) =>
      Schema.decodeUnknown(schema)(data).pipe(
        Effect.mapError(
          (e) =>
            new ProfileError({
              message: `${file}: schema decode failed`,
              issues: [String(e)],
            }),
        ),
      ),
    ),
  )

export const FileSystemProfileLive = (vaultDir: string) =>
  Layer.succeed(ProfileService, {
    load: () =>
      Effect.gen(function* () {
        const profileText = yield* readOrFail(join(vaultDir, DIRECTIVES_PROFILE_FILE))
        const topicsText = yield* readOrFail(join(vaultDir, DIRECTIVES_TOPICS_FILE))
        const sourcesText = yield* readOrFail(join(vaultDir, DIRECTIVES_SOURCES_FILE))
        const profile = yield* parseFrontmatter(profileText, ProfileConfig, DIRECTIVES_PROFILE_FILE)
        const topics = yield* parseFrontmatter(topicsText, TopicsConfig, DIRECTIVES_TOPICS_FILE)
        const sources = yield* parseFrontmatter(sourcesText, SourcesConfig, DIRECTIVES_SOURCES_FILE)
        const me = yield* readOptional(join(vaultDir, DIRECTIVES_ME_FILE))
        const projects = yield* readOptional(join(vaultDir, DIRECTIVES_PROJECTS_FILE))
        const avoid = yield* readOptional(join(vaultDir, DIRECTIVES_AVOID_FILE))
        return { profile, topics, sources, me, projects, avoid }
      }),
    validate: () =>
      Effect.gen(function* () {
        const issues: Array<string> = []
        const checks: ReadonlyArray<{ file: string; schema: Schema.Schema<unknown, unknown> }> = [
          { file: DIRECTIVES_PROFILE_FILE, schema: ProfileConfig as unknown as Schema.Schema<unknown> },
          { file: DIRECTIVES_TOPICS_FILE, schema: TopicsConfig as unknown as Schema.Schema<unknown> },
          { file: DIRECTIVES_SOURCES_FILE, schema: SourcesConfig as unknown as Schema.Schema<unknown> },
        ]
        for (const { file, schema } of checks) {
          const text = yield* readOrFail(join(vaultDir, file))
          const data = yield* Effect.try({
            try: () => matter(text).data as unknown,
            catch: (e) =>
              new VaultError({ message: `${file}: frontmatter parse failed: ${String(e)}` }),
          })
          const result = yield* Schema.decodeUnknown(schema)(data).pipe(Effect.either)
          Either.match(result, {
            onLeft: (err) => issues.push(`${file}: ${String(err)}`),
            onRight: () => undefined,
          })
        }
        return issues
      }),
  })
