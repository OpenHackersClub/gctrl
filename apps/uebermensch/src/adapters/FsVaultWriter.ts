import { createHash } from "node:crypto"
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { Effect, Layer, Option } from "effect"
import { VaultError, vaultIo } from "../errors.js"
import {
  VaultWriterPort,
  type VaultEntry,
  type VaultWriterPortShape,
  type WrittenEntry,
} from "../services/VaultWriterPort.js"

const hashContent = (s: string) =>
  `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`

// Filesystem adapter for VaultWriterPort. Operates on vault-relative paths
// rooted at `vaultDir`. Writes are atomic (tmp + rename) and create parent
// directories as needed; reads return Option.none for missing files; deletes
// are no-ops when the target is missing. Local filesystem is strongly
// consistent so the R2 list write-cache requirement (see VaultWriterPort.list)
// does not apply here.
export const FsVaultWriterLive = (vaultDir: string): Layer.Layer<VaultWriterPort> =>
  Layer.succeed(VaultWriterPort, {
    write: (path, content) =>
      vaultIo(
        async () => {
          const absPath = join(vaultDir, path)
          const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`
          await mkdir(dirname(absPath), { recursive: true })
          await writeFile(tmpPath, content, "utf8")
          await rename(tmpPath, absPath)
          return { contentHash: hashContent(content) } satisfies WrittenEntry
        },
        { message: `write failed for ${path}`, path: join(vaultDir, path) },
      ),
    read: (path) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const buf = await readFile(join(vaultDir, path), "utf8")
            return Option.some(buf)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return Option.none<string>()
            throw e
          }
        },
        catch: (e) =>
          new VaultError({
            message: `read failed for ${path}: ${String(e)}`,
            path: join(vaultDir, path),
            kind: "io_failure",
          }),
      }),
    list: (prefix) =>
      vaultIo(
        async () => {
          const start = join(vaultDir, prefix)
          const entries: Array<VaultEntry> = []
          let dirents
          try {
            dirents = await readdir(start, { recursive: true, withFileTypes: true })
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return entries
            throw e
          }
          for (const d of dirents) {
            if (!d.isFile()) continue
            const name = String(d.name)
            const parent = (d as unknown as { parentPath?: string }).parentPath ?? d.path ?? start
            const abs = join(parent, name)
            const st = await stat(abs)
            entries.push({ path: relative(vaultDir, abs), mtime: st.mtime })
          }
          return entries
        },
        { message: `list failed for ${prefix}`, path: join(vaultDir, prefix) },
      ),
    delete: (path) =>
      vaultIo(
        async () => {
          await rm(join(vaultDir, path), { force: true })
        },
        { message: `delete failed for ${path}`, path: join(vaultDir, path) },
      ),
  } satisfies VaultWriterPortShape)
