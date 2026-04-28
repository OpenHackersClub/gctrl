import { cp, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { VaultError, vaultIo } from "../errors.js"

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = resolve(here, "../../tests/fixtures/vault")

const target = Args.text({ name: "target" }).pipe(
  Args.withDescription("Vault directory to create (will be initialized)"),
)

const fromSeed = Options.text("from-seed").pipe(
  Options.withDescription("Copy from an existing seed vault directory instead of the fixture"),
  Options.optional,
)

export const vaultInit = Command.make("init", { target, fromSeed }, ({ target, fromSeed }) =>
  Effect.gen(function* () {
    const abs = resolve(target)
    const exists = yield* vaultIo(
      async () => {
        try {
          const s = await stat(abs)
          return s.isDirectory()
        } catch {
          return false
        }
      },
      { message: "stat target failed", path: abs },
    )
    if (exists) {
      yield* Console.error(`target ${abs} already exists — refusing to overwrite`)
      return yield* Effect.fail(
        new VaultError({ message: "target exists", path: abs, kind: "collision" }),
      )
    }
    const seed = Option.match(fromSeed, {
      onNone: () => FIXTURE_ROOT,
      onSome: (value) => resolve(value),
    })
    yield* vaultIo(
      async () => {
        await mkdir(dirname(abs), { recursive: true })
        await cp(seed, abs, { recursive: true })
        const tmpl = join(abs, "gitignore.template")
        try {
          await rename(tmpl, join(abs, ".gitignore"))
        } catch {
          // no template — fine
        }
      },
      { message: "init failed", path: abs },
    )
    yield* Console.log(`✓ initialized vault at ${abs} from ${seed}`)
    yield* Console.log(`  Set UBER_VAULT_DIR=${abs} and open it in Obsidian.`)
  }),
).pipe(Command.withDescription("Initialize a new uebermensch vault from seed or fixture"))
