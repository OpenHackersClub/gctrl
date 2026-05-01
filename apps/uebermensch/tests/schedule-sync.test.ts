import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildCommand,
  buildDesiredRows,
  diffSchedules,
  hktCronToUtc,
  scheduleSyncProgram,
  type KernelScheduleRow,
} from "../src/commands/schedule-sync.js"
import { SchedulesConfig } from "../src/schemas.js"

// --- Pure: HKT → UTC cron conversion ---

describe("hktCronToUtc", () => {
  it("subtracts 8 hours mid-day", () => {
    expect(hktCronToUtc("30 8 * * *")).toBe("30 0 * * *")
  })

  it("evening schedule, no day rollover", () => {
    expect(hktCronToUtc("59 23 * * *")).toBe("59 15 * * *")
  })

  it("wraps past midnight; * DOW unchanged", () => {
    expect(hktCronToUtc("0 6 * * *")).toBe("0 22 * * *")
  })

  it("shifts specific DOW back when crossing midnight", () => {
    // HKT 01:00 Mon (1) → UTC 17:00 Sun (0)
    expect(hktCronToUtc("0 1 * * 1")).toBe("0 17 * * 0")
  })

  it("wraps DOW 0 (Sun) back to 6 (Sat)", () => {
    expect(hktCronToUtc("0 1 * * 0")).toBe("0 17 * * 6")
  })

  it("rejects 4-field cron", () => {
    expect(() => hktCronToUtc("0 1 * *")).toThrow("invalid 5-field cron")
  })

  it("rejects non-numeric hour", () => {
    expect(() => hktCronToUtc("0 * * * *")).toThrow("cron hour field must be a numeric")
  })
})

// --- Pure: argv per job kind ---

describe("buildCommand", () => {
  it("brief-and-send → run-daily", () => {
    expect(buildCommand("/abs/uber.js", "/usr/bin/node", "brief-and-send")).toEqual([
      "/usr/bin/node",
      "/abs/uber.js",
      "run-daily",
    ])
  })

  it("report-and-send → report --send", () => {
    expect(buildCommand("/abs/uber.js", "/usr/bin/node", "report-and-send")).toEqual([
      "/usr/bin/node",
      "/abs/uber.js",
      "report",
      "--send",
    ])
  })
})

// --- Schema validation ---

describe("SchedulesConfig schema", () => {
  const validRaw = {
    schema_version: 1,
    schedules: {
      morning_brief: {
        cron: "30 8 * * *",
        tz: "Asia/Hong_Kong",
        job: "brief-and-send",
        enabled: true,
      },
    },
  }

  it("accepts a valid config", async () => {
    const result = await Effect.runPromise(Schema.decodeUnknown(SchedulesConfig)(validRaw))
    expect(result.schedules.morning_brief.cron).toBe("30 8 * * *")
  })

  it("accepts both job kinds", async () => {
    const raw = {
      schema_version: 1,
      schedules: {
        b: { cron: "0 8 * * *", tz: "Asia/Hong_Kong", job: "brief-and-send" },
        r: { cron: "0 9 * * 1", tz: "Asia/Hong_Kong", job: "report-and-send" },
      },
    }
    const result = await Effect.runPromise(Schema.decodeUnknown(SchedulesConfig)(raw))
    expect(result.schedules.b.job).toBe("brief-and-send")
    expect(result.schedules.r.job).toBe("report-and-send")
  })

  it("rejects unknown job", async () => {
    const raw = {
      schema_version: 1,
      schedules: { x: { cron: "0 8 * * *", tz: "Asia/Hong_Kong", job: "deep-dive" } },
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(Schema.decodeUnknown(SchedulesConfig)(raw)))).toBe(true)
  })

  it("rejects unknown timezone (M2 only supports Asia/Hong_Kong)", async () => {
    const raw = {
      schema_version: 1,
      schedules: { x: { cron: "0 8 * * *", tz: "America/New_York", job: "brief-and-send" } },
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(Schema.decodeUnknown(SchedulesConfig)(raw)))).toBe(true)
  })

  it("leaves enabled undefined when absent (not false)", async () => {
    const raw = {
      schema_version: 1,
      schedules: { x: { cron: "0 8 * * *", tz: "Asia/Hong_Kong", job: "brief-and-send" } },
    }
    const result = await Effect.runPromise(Schema.decodeUnknown(SchedulesConfig)(raw))
    expect(result.schedules.x.enabled).toBeUndefined()
  })
})

// --- Pure: buildDesiredRows ---

describe("buildDesiredRows", () => {
  const dist = "/abs/uber.js"
  const node = "/usr/bin/node"
  const vault = "/vault"

  it("namespaces rows under uber.* and applies HKT→UTC", () => {
    const cfg = {
      schema_version: 1,
      schedules: {
        morning_brief: {
          cron: "30 8 * * *" as string,
          tz: "Asia/Hong_Kong" as const,
          job: "brief-and-send" as const,
          enabled: true,
        },
      },
    }
    const rows = buildDesiredRows(cfg, vault, dist, node)
    expect([...rows.keys()]).toEqual(["uber.morning_brief"])
    const row = rows.get("uber.morning_brief")!
    expect(row.cron).toBe("30 0 * * *")
    expect(row.target_kind).toBe("exec")
    expect(row.cwd).toBe(vault)
    expect(row.timeout_secs).toBe(300)
    expect(row.enabled).toBe(true)
  })

  it("defaults enabled to true when omitted", () => {
    const cfg = {
      schema_version: 1,
      schedules: {
        x: { cron: "0 8 * * *" as string, tz: "Asia/Hong_Kong" as const, job: "brief-and-send" as const },
      },
    }
    expect(buildDesiredRows(cfg, vault, dist, node).get("uber.x")!.enabled).toBe(true)
  })
})

// --- Pure: diffSchedules ---

describe("diffSchedules", () => {
  const baseRow: KernelScheduleRow = {
    name: "uber.a",
    cron: "0 0 * * *",
    target_kind: "exec",
    command: ["/n", "/u.js", "run-daily"],
    cwd: "/v",
    env_keys: ["UBER_VAULT_DIR"],
    enabled: true,
    timeout_secs: 300,
  }

  it("creates rows missing from existing", () => {
    const desired = new Map([["uber.a", baseRow]])
    const diff = diffSchedules(desired, new Map())
    expect(diff.creates).toEqual([baseRow])
    expect(diff.updates).toEqual([])
    expect(diff.deletes).toEqual([])
    expect(diff.unchanged).toEqual([])
  })

  it("marks identical rows as unchanged", () => {
    const desired = new Map([["uber.a", baseRow]])
    const existing = new Map([["uber.a", baseRow]])
    const diff = diffSchedules(desired, existing)
    expect(diff.unchanged).toEqual(["uber.a"])
    expect(diff.creates).toEqual([])
    expect(diff.updates).toEqual([])
  })

  it("flags update when cron changes", () => {
    const desired = new Map([["uber.a", { ...baseRow, cron: "0 1 * * *" }]])
    const existing = new Map([["uber.a", baseRow]])
    const diff = diffSchedules(desired, existing)
    expect(diff.updates).toHaveLength(1)
    expect(diff.updates[0]!.cron).toBe("0 1 * * *")
    expect(diff.creates).toEqual([])
    expect(diff.unchanged).toEqual([])
  })

  it("flags update when command changes", () => {
    const desired = new Map([
      ["uber.a", { ...baseRow, command: ["/n", "/u.js", "report", "--send"] }],
    ])
    const existing = new Map([["uber.a", baseRow]])
    expect(diffSchedules(desired, existing).updates).toHaveLength(1)
  })

  it("deletes existing rows absent from desired", () => {
    const desired = new Map<string, KernelScheduleRow>()
    const existing = new Map([["uber.stale", baseRow]])
    expect(diffSchedules(desired, existing).deletes).toEqual(["uber.stale"])
  })
})

// --- scheduleSyncProgram: thin smoke tests only (file IO + apply orchestration) ---

describe("scheduleSyncProgram", () => {
  let vaultDir: string
  const originalFetch = globalThis.fetch
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ["UBER_VAULT_DIR", "UBER_DIST_PATH", "GCTRL_NODE_PATH", "GCTRL_KERNEL_URL"]

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "uber-sched-"))
    await mkdir(join(vaultDir, "directives"), { recursive: true })
    for (const k of envKeys) savedEnv[k] = process.env[k]
    process.env.UBER_VAULT_DIR = vaultDir
    process.env.UBER_DIST_PATH = "/abs/uber.js"
    process.env.GCTRL_NODE_PATH = "/usr/bin/node"
    process.env.GCTRL_KERNEL_URL = "http://kernel.test"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it("no-op when schedules.md is absent — kernel never called", async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("aborts on schema-invalid frontmatter without touching kernel", async () => {
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      "---\nschema_version: 1\nschedules:\n  bad:\n    cron: \"0 8 * * *\"\n    tz: America/New_York\n    job: brief-and-send\n---\n",
    )
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("aborts with config error when UBER_DIST_PATH is unset", async () => {
    delete process.env.UBER_DIST_PATH
    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("UBER_DIST_PATH")
  })

  it("aborts with config error when GCTRL_NODE_PATH is unset", async () => {
    delete process.env.GCTRL_NODE_PATH
    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("GCTRL_NODE_PATH")
  })

  it("issues DELETE then POST when applying an update; no calls when unchanged", async () => {
    // First run with an existing row that differs → expect DELETE + POST
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      [
        "---",
        "schema_version: 1",
        "schedules:",
        "  morning_brief:",
        "    cron: \"0 9 * * *\"",
        "    tz: Asia/Hong_Kong",
        "    job: brief-and-send",
        "---",
        "",
      ].join("\n"),
    )

    const stale: Record<string, unknown> = {
      name: "uber.morning_brief",
      cron: "30 0 * * *", // differs from desired (0 1 * * *)
      target_kind: "exec",
      command: ["/usr/bin/node", "/abs/uber.js", "run-daily"],
      cwd: vaultDir,
      env_keys: [
        "UBER_VAULT_DIR",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_PRIMARY_CHAT_ID",
        "DISCORD_NOTIFY_WEBHOOK_URL",
        "GCTRL_KERNEL_URL",
      ],
      enabled: true,
      timeout_secs: 300,
    }

    const calls: Array<string> = []
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      calls.push(method)
      if (method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify([stale]) }
      return { ok: true, status: method === "DELETE" ? 204 : 201, text: async () => "{}" }
    }) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    // DELETE must precede POST for the same name
    expect(calls).toEqual(["GET", "DELETE", "POST"])
  })

  it("propagates kernel_unreachable when kernel returns 500", async () => {
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      "---\nschema_version: 1\nschedules:\n  test:\n    cron: \"0 8 * * *\"\n    tz: Asia/Hong_Kong\n    job: brief-and-send\n---\n",
    )
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal server error",
    }) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
