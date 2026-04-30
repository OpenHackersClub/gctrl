import { readFileSync, writeFileSync } from "node:fs"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

// --- schemas ---

const VaultMount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root_path: Schema.String,
  kind: Schema.String,
  git_url: Schema.optional(Schema.NullOr(Schema.String)),
  app_id: Schema.optional(Schema.NullOr(Schema.String)),
  last_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  last_synced_at: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
})
const VaultMountList = Schema.Array(VaultMount)

const VaultPagePut = Schema.Struct({
  mount: Schema.String,
  path: Schema.String,
  abs_path: Schema.String,
  content_hash: Schema.String,
})

const VaultPageGet = Schema.Struct({
  mount: Schema.String,
  path: Schema.String,
  abs_path: Schema.String,
  content_hash: Schema.String,
  content: Schema.String,
})

// --- list ---

const formatOption = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table"),
)

const listCommand = Command.make("list", { format: formatOption }, ({ format }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    const mounts = yield* kernel.get("/api/vault/mounts", VaultMountList)

    if (mounts.length === 0) {
      yield* Console.log("No vault mounts. Register one with `gctrl vault mount`.")
      return
    }

    if (format === "json") {
      yield* Console.log(JSON.stringify(mounts, null, 2))
      return
    }

    yield* Console.log(`${"NAME".padEnd(20)} ${"KIND".padEnd(11)} ROOT`)
    yield* Console.log("-".repeat(80))
    for (const m of mounts) {
      yield* Console.log(
        `${m.name.padEnd(20)} ${m.kind.padEnd(11)} ${m.root_path}`,
      )
    }
  }),
)

// --- mount (create) ---

const nameOption = Options.text("name").pipe(
  Options.withDescription("Mount name (unique)"),
)
const rootOption = Options.text("root").pipe(
  Options.withDescription("Absolute path to vault root"),
)
const kindOption = Options.choice("kind", ["workspace", "app", "external"]).pipe(
  Options.withDefault("workspace"),
)
const gitUrlOption = Options.text("git-url").pipe(Options.optional)
const appIdOption = Options.text("app-id").pipe(Options.optional)

const mountCommand = Command.make(
  "mount",
  { name: nameOption, root: rootOption, kind: kindOption, gitUrl: gitUrlOption, appId: appIdOption },
  ({ name, root, kind, gitUrl, appId }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const created = yield* kernel.post(
        "/api/vault/mounts",
        {
          name,
          root_path: root,
          kind,
          git_url: Option.getOrUndefined(gitUrl),
          app_id: Option.getOrUndefined(appId),
        },
        VaultMount,
      )
      yield* Console.log(`Mounted: ${created.name} → ${created.root_path}`)
    }),
)

// --- unmount (delete) ---

const unmountName = Args.text({ name: "name" })

const unmountCommand = Command.make("unmount", { name: unmountName }, ({ name }) =>
  Effect.gen(function* () {
    const kernel = yield* KernelClient
    yield* kernel.delete(`/api/vault/mounts/${encodeURIComponent(name)}`)
    yield* Console.log(`Unmounted: ${name}`)
  }),
)

// --- get (read a page) ---

const getMount = Args.text({ name: "mount" })
const getPath = Args.text({ name: "path" })
const outOption = Options.text("out").pipe(
  Options.withDescription("Write content to this file instead of stdout"),
  Options.optional,
)

const getCommand = Command.make(
  "get",
  { mount: getMount, path: getPath, out: outOption },
  ({ mount, path, out }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const page = yield* kernel.get(
        `/api/vault/page?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`,
        VaultPageGet,
      )
      const dest = Option.getOrUndefined(out)
      if (dest) {
        writeFileSync(dest, page.content)
        yield* Console.log(`Wrote ${page.content.length} bytes to ${dest}`)
      } else {
        yield* Console.log(page.content)
      }
    }),
)

// --- put (write a page) ---

const putMount = Args.text({ name: "mount" })
const putPath = Args.text({ name: "path" })
const contentOption = Options.text("content").pipe(
  Options.withDescription("Content (mutually exclusive with --file)"),
  Options.optional,
)
const fileOption = Options.text("file").pipe(
  Options.withDescription("Read content from this file (mutually exclusive with --content)"),
  Options.optional,
)

const putCommand = Command.make(
  "put",
  { mount: putMount, path: putPath, content: contentOption, file: fileOption },
  ({ mount, path, content, file }) =>
    Effect.gen(function* () {
      const inline = Option.getOrUndefined(content)
      const fromFile = Option.getOrUndefined(file)
      if (!inline && !fromFile) {
        return yield* Effect.fail({
          _tag: "MissingContent" as const,
          message: "Provide --content or --file",
        })
      }
      const body = fromFile ? readFileSync(fromFile, "utf-8") : (inline ?? "")
      const kernel = yield* KernelClient
      const written = yield* kernel.post(
        "/api/vault/page",
        { mount, path, content: body },
        VaultPagePut,
      )
      yield* Console.log(
        `Wrote ${written.path} (${body.length} bytes, hash ${written.content_hash.slice(0, 12)}…)`,
      )
    }),
)

// --- compose ---

export const vaultCommand = Command.make("vault").pipe(
  Command.withSubcommands([listCommand, mountCommand, unmountCommand, getCommand, putCommand]),
)
