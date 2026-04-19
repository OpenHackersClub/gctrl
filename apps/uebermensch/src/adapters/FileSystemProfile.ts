import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Either, Layer, Schema } from "effect"
import matter from "gray-matter"
import { ProfileError, VaultError } from "../errors.js"
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
        const profileText = yield* readOrFail(join(vaultDir, "profile.md"))
        const topicsText = yield* readOrFail(join(vaultDir, "topics.md"))
        const sourcesText = yield* readOrFail(join(vaultDir, "sources.md"))
        const profile = yield* parseFrontmatter(profileText, ProfileConfig, "profile.md")
        const topics = yield* parseFrontmatter(topicsText, TopicsConfig, "topics.md")
        const sources = yield* parseFrontmatter(sourcesText, SourcesConfig, "sources.md")
        const me = yield* readOptional(join(vaultDir, "ME.md"))
        const projects = yield* readOptional(join(vaultDir, "projects.md"))
        const avoid = yield* readOptional(join(vaultDir, "avoid.md"))
        return { profile, topics, sources, me, projects, avoid }
      }),
    validate: () =>
      Effect.gen(function* () {
        const issues: Array<string> = []
        const checks: ReadonlyArray<{ file: string; schema: Schema.Schema<unknown, unknown> }> = [
          { file: "profile.md", schema: ProfileConfig as unknown as Schema.Schema<unknown> },
          { file: "topics.md", schema: TopicsConfig as unknown as Schema.Schema<unknown> },
          { file: "sources.md", schema: SourcesConfig as unknown as Schema.Schema<unknown> },
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
