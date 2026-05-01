import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Console, Effect, Schema } from "effect"
import matter from "gray-matter"
import { ScheduleError } from "../errors.js"
import { resolveVaultDir } from "../lib/env.js"
import { DIRECTIVES_SCHEDULES_FILE } from "../lib/vault-paths.js"
import { SchedulesConfig, type ScheduleEntry } from "../schemas.js"

// HKT is UTC+8 with no DST. To convert a HKT cron to UTC:
//   subtract 8 from the hour field.
//   if result < 0, add 24 and shift day-of-week field back 1.
// Limitation: only the hour field is adjusted; DOW shift is only applied when the
// schedule uses a restricted DOW (not "*"). M2 supports Asia/Hong_Kong only.
export const hktCronToUtc = (hktCron: string): string => {
  const parts = hktCron.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`invalid 5-field cron: "${hktCron}"`)
  }
  const [minute, hourStr, dom, month, dow] = parts as [string, string, string, string, string]
  const hour = parseInt(hourStr, 10)
  if (isNaN(hour) || hour < 0 || hour > 23) {
    throw new Error(`cron hour field must be a numeric 0-23, got: "${hourStr}"`)
  }
  const utcHour = hour - 8
  if (utcHour >= 0) {
    return [minute, String(utcHour), dom, month, dow].join(" ")
  }
  // Hour crossed midnight: add 24 to wrap, shift DOW back 1
  const wrappedHour = utcHour + 24
  const shiftedDow = shiftDowBack(dow)
  return [minute, String(wrappedHour), dom, month, shiftedDow].join(" ")
}

// Shift a DOW field back by 1 day. Handles "*", single values, and ranges.
// Only needed in the midnight-crossing case (hour < 8 HKT).
const shiftDowBack = (dow: string): string => {
  if (dow === "*") return "*"
  // Handle comma-separated lists and single values
  return dow
    .split(",")
    .map((part) => {
      // Range like 1-5
      if (part.includes("-")) {
        const [lo, hi] = part.split("-").map((n) => parseInt(n, 10))
        if (lo === undefined || hi === undefined || isNaN(lo) || isNaN(hi)) return part
        return `${(lo + 6) % 7}-${(hi + 6) % 7}`
      }
      // Step like */2
      if (part.includes("/")) return part
      const n = parseInt(part, 10)
      if (isNaN(n)) return part
      return String((n + 6) % 7)
    })
    .join(",")
}

// Same allowlist for all uber jobs: brief and report both deliver via the same
// Telegram/Discord channels and read the vault from $UBER_VAULT_DIR.
const ENV_KEYS_UBER_JOB = [
  "UBER_VAULT_DIR",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_PRIMARY_CHAT_ID",
  "DISCORD_NOTIFY_WEBHOOK_URL",
  "GCTRL_KERNEL_URL",
] as const

const VALID_JOBS = ["brief-and-send", "report-and-send"] as const
type JobKind = (typeof VALID_JOBS)[number]

const TIMEOUT_SECS = 300

type KernelScheduleRow = {
  name: string
  cron: string
  target_kind: string
  command: ReadonlyArray<string>
  cwd: string
  env_keys: ReadonlyArray<string>
  enabled: boolean
  timeout_secs: number
}

const kernelBase = () =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

const kernelFetch = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Effect.Effect<unknown, ScheduleError> =>
  Effect.tryPromise({
    try: async () => {
      const url = `${kernelBase()}${path}`
      const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new ScheduleError({
          message: `kernel ${method} ${path} HTTP ${res.status}: ${text.slice(0, 500)}`,
          kind: res.status >= 500 || res.status === 0 ? "kernel_unreachable" : "io_failure",
        })
      }
      return text.length > 0 ? JSON.parse(text) : {}
    },
    catch: (e) =>
      e instanceof ScheduleError
        ? e
        : new ScheduleError({
            message: `kernel fetch failed: ${String(e)}`,
            kind: "kernel_unreachable",
          }),
  })

export const buildCommand = (
  uberDistPath: string,
  nodePath: string,
  job: JobKind,
): ReadonlyArray<string> => {
  switch (job) {
    case "brief-and-send":
      return [nodePath, uberDistPath, "run-daily"]
    case "report-and-send":
      return [nodePath, uberDistPath, "report", "--send"]
  }
}

const buildRow = (
  name: string,
  entry: ScheduleEntry,
  vaultDir: string,
  uberDistPath: string,
  nodePath: string,
): KernelScheduleRow => {
  const cronUtc = hktCronToUtc(entry.cron)
  return {
    name,
    cron: cronUtc,
    target_kind: "exec",
    command: buildCommand(uberDistPath, nodePath, entry.job),
    cwd: vaultDir,
    env_keys: [...ENV_KEYS_UBER_JOB],
    enabled: entry.enabled ?? true,
    timeout_secs: TIMEOUT_SECS,
  }
}

const rowsEqual = (a: KernelScheduleRow, b: KernelScheduleRow): boolean =>
  a.cron === b.cron &&
  a.target_kind === b.target_kind &&
  JSON.stringify(a.command) === JSON.stringify(b.command) &&
  a.cwd === b.cwd &&
  JSON.stringify(a.env_keys) === JSON.stringify(b.env_keys) &&
  a.enabled === b.enabled &&
  a.timeout_secs === b.timeout_secs

export const scheduleSyncProgram = Effect.gen(function* () {
  const vaultDir = yield* resolveVaultDir()

  const uberDistPath = process.env.UBER_DIST_PATH
  if (!uberDistPath || uberDistPath.trim() === "") {
    return yield* Effect.fail(
      new ScheduleError({
        message:
          "UBER_DIST_PATH is not set. Set it to the absolute path of the compiled uber binary: " +
          "set UBER_DIST_PATH=/abs/path/to/apps/uebermensch/dist/bin/uber.js",
        kind: "config",
      }),
    )
  }

  const nodePath = process.env.GCTRL_NODE_PATH
  if (!nodePath || nodePath.trim() === "") {
    return yield* Effect.fail(
      new ScheduleError({
        message:
          "GCTRL_NODE_PATH is not set. Set it to the absolute path of the node binary " +
          "(the kernel scheduler rejects relative argv[0]). " +
          "Example: set GCTRL_NODE_PATH=$(which node)",
        kind: "config",
      }),
    )
  }

  const schedulesAbs = join(vaultDir, DIRECTIVES_SCHEDULES_FILE)
  const fileText = yield* Effect.tryPromise({
    try: () => readFile(schedulesAbs, "utf8").then((t) => t as string | null).catch(() => null),
    catch: () =>
      new ScheduleError({ message: "unexpected I/O error reading schedules file", kind: "io_failure" }),
  })

  if (fileText === null) {
    yield* Console.log("no schedules defined")
    return
  }

  const frontmatter = yield* Effect.try({
    try: () => matter(fileText).data as unknown,
    catch: (e) =>
      new ScheduleError({
        message: `${DIRECTIVES_SCHEDULES_FILE}: frontmatter parse failed: ${String(e)}`,
        kind: "schema_invalid",
      }),
  })

  const config = yield* Schema.decodeUnknown(SchedulesConfig)(frontmatter).pipe(
    Effect.mapError(
      (e) =>
        new ScheduleError({
          message: `${DIRECTIVES_SCHEDULES_FILE}: schema validation failed: ${String(e)}`,
          kind: "schema_invalid",
        }),
    ),
  )

  // Validate all jobs in the config exist in registry before touching anything
  for (const [localName, entry] of Object.entries(config.schedules)) {
    if (!(VALID_JOBS as ReadonlyArray<string>).includes(entry.job)) {
      return yield* Effect.fail(
        new ScheduleError({
          message: `schedule "${localName}" references unknown job "${entry.job}". ` +
            `Valid jobs: ${VALID_JOBS.join(", ")}`,
          kind: "schema_invalid",
        }),
      )
    }
  }

  // Compute desired rows
  const desired = new Map<string, KernelScheduleRow>()
  for (const [localName, entry] of Object.entries(config.schedules)) {
    const kernelName = `uber.${localName}`
    desired.set(kernelName, buildRow(kernelName, entry, vaultDir, uberDistPath, nodePath))
  }

  // Fetch existing uber.* rows from kernel
  const existingRaw = yield* kernelFetch("GET", "/api/schedules?name_prefix=uber.").pipe(
    Effect.mapError((e) => {
      if (e.kind === "kernel_unreachable") {
        return new ScheduleError({
          message: `kernel unreachable at ${kernelBase()}`,
          kind: "kernel_unreachable",
        })
      }
      return e
    }),
  )

  const existingRows: Array<KernelScheduleRow> =
    Array.isArray(existingRaw) ? (existingRaw as Array<KernelScheduleRow>) : []
  const existing = new Map<string, KernelScheduleRow>(existingRows.map((r) => [r.name, r]))

  let created = 0
  let updated = 0
  let deleted = 0
  let unchanged = 0

  // Apply: create or update (delete + create)
  for (const [name, desiredRow] of desired) {
    const existingRow = existing.get(name)
    if (!existingRow) {
      yield* kernelFetch("POST", "/api/schedules", desiredRow)
      created++
      yield* Console.log(`  created ${name}`)
    } else if (!rowsEqual(existingRow, desiredRow)) {
      // Kernel does not have PUT; delete then re-create
      yield* kernelFetch("DELETE", `/api/schedules/${encodeURIComponent(name)}`)
      yield* kernelFetch("POST", "/api/schedules", desiredRow)
      updated++
      yield* Console.log(`  updated ${name}`)
    } else {
      unchanged++
    }
  }

  // Delete rows no longer in desired
  for (const [name] of existing) {
    if (!desired.has(name)) {
      yield* kernelFetch("DELETE", `/api/schedules/${encodeURIComponent(name)}`)
      deleted++
      yield* Console.log(`  deleted ${name}`)
    }
  }

  yield* Console.log(
    `schedule sync done: created ${created}, updated ${updated}, deleted ${deleted}, unchanged ${unchanged}`,
  )
})
