import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleError } from "../src/errors.js"
import { hktCronToUtc, scheduleSyncProgram } from "../src/commands/schedule-sync.js"
import { SchedulesConfig } from "../src/schemas.js"

// --- HKT → UTC conversion unit tests ---

describe("hktCronToUtc", () => {
  it("subtracts 8 hours for a mid-day schedule", () => {
    expect(hktCronToUtc("30 8 * * *")).toBe("30 0 * * *")
  })

  it("handles evening schedule without day rollover", () => {
    expect(hktCronToUtc("59 23 * * *")).toBe("59 15 * * *")
  })

  it("handles hour exactly at 8 HKT (midnight UTC)", () => {
    expect(hktCronToUtc("0 8 * * *")).toBe("0 0 * * *")
  })

  it("wraps hour past midnight and shifts * DOW unchanged", () => {
    // HKT 06:00 → UTC 22:00 previous day; DOW=* stays *
    expect(hktCronToUtc("0 6 * * *")).toBe("0 22 * * *")
  })

  it("shifts specific DOW back when crossing midnight", () => {
    // HKT 01:00 Mon (1) → UTC 17:00 Sun (0)
    expect(hktCronToUtc("0 1 * * 1")).toBe("0 17 * * 0")
  })

  it("shifts DOW 0 (Sunday) back to Saturday (6)", () => {
    // HKT 01:00 Sun (0) → UTC 17:00 Sat (6)
    expect(hktCronToUtc("0 1 * * 0")).toBe("0 17 * * 6")
  })

  it("throws on invalid 4-field cron", () => {
    expect(() => hktCronToUtc("0 1 * *")).toThrow("invalid 5-field cron")
  })

  it("throws on non-numeric hour", () => {
    expect(() => hktCronToUtc("0 * * * *")).toThrow("cron hour field must be a numeric")
  })
})

// --- SchedulesConfig schema validation ---

describe("SchedulesConfig schema", () => {
  it("parses a valid schedules config", async () => {
    const raw = {
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
    const result = await Effect.runPromise(Schema.decodeUnknown(SchedulesConfig)(raw))
    expect(result.schema_version).toBe(1)
    expect(result.schedules.morning_brief.cron).toBe("30 8 * * *")
    expect(result.schedules.morning_brief.enabled).toBe(true)
  })

  it("rejects unknown job value", async () => {
    const raw = {
      schema_version: 1,
      schedules: {
        test: { cron: "0 8 * * *", tz: "Asia/Hong_Kong", job: "deep-dive" },
      },
    }
    const exit = await Effect.runPromiseExit(Schema.decodeUnknown(SchedulesConfig)(raw))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("rejects unknown timezone", async () => {
    const raw = {
      schema_version: 1,
      schedules: {
        test: { cron: "0 8 * * *", tz: "America/New_York", job: "brief-and-send" },
      },
    }
    const exit = await Effect.runPromiseExit(Schema.decodeUnknown(SchedulesConfig)(raw))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("defaults enabled to absent (undefined), not false", async () => {
    const raw = {
      schema_version: 1,
      schedules: {
        test: { cron: "0 8 * * *", tz: "Asia/Hong_Kong", job: "brief-and-send" },
      },
    }
    const result = await Effect.runPromise(Schema.decodeUnknown(SchedulesConfig)(raw))
    expect(result.schedules.test.enabled).toBeUndefined()
  })
})

// --- scheduleSyncProgram integration tests (mock kernel) ---

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
    process.env.UBER_DIST_PATH = "/abs/path/uber.js"
    process.env.GCTRL_NODE_PATH = "/usr/local/bin/node"
    process.env.GCTRL_KERNEL_URL = "http://kernel.test"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it("no-op and prints message when schedules.md is absent", async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("aborts with ScheduleError when schema is invalid", async () => {
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      "---\nschema_version: 1\nschedules:\n  bad:\n    cron: \"0 8 * * *\"\n    tz: America/New_York\n    job: brief-and-send\n---\n",
    )
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
    // Kernel must not be touched
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("aborts with config error when UBER_DIST_PATH is not set", async () => {
    delete process.env.UBER_DIST_PATH
    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = exit.cause
      // The error should be a ScheduleError with kind=config
      expect(String(cause)).toContain("UBER_DIST_PATH")
    }
  })

  it("aborts with config error when GCTRL_NODE_PATH is not set", async () => {
    delete process.env.GCTRL_NODE_PATH
    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("GCTRL_NODE_PATH")
    }
  })

  it("POSTs new schedules to kernel and reports created count", async () => {
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      [
        "---",
        "schema_version: 1",
        "schedules:",
        "  morning_brief:",
        "    cron: \"30 8 * * *\"",
        "    tz: Asia/Hong_Kong",
        "    job: brief-and-send",
        "    enabled: true",
        "---",
        "",
        "# Schedules",
      ].join("\n"),
    )

    const postCalls: Array<{ url: string; body: unknown }> = []
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (method === "GET") {
        // Return empty existing list
        return { ok: true, status: 200, text: async () => JSON.stringify([]) }
      }
      if (method === "POST") {
        postCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
        return { ok: true, status: 201, text: async () => JSON.stringify({ ok: true }) }
      }
      return { ok: true, status: 200, text: async () => "{}" }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(postCalls).toHaveLength(1)
    const posted = postCalls[0]!.body as Record<string, unknown>
    expect(posted.name).toBe("uber.morning_brief")
    expect(posted.cron).toBe("30 0 * * *")  // HKT 08:30 → UTC 00:30
    expect(posted.target_kind).toBe("exec")
    expect(Array.isArray(posted.command)).toBe(true)
    expect((posted.command as string[])[0]).toBe("/usr/local/bin/node")
    expect((posted.command as string[])[1]).toBe("/abs/path/uber.js")
    expect((posted.command as string[])[2]).toBe("run-daily")
    expect(posted.cwd).toBe(vaultDir)
    expect(posted.timeout_secs).toBe(300)
  })

  it("DELETEs then POSTs when cron changes (diff logic)", async () => {
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

    const existingRow = {
      name: "uber.morning_brief",
      cron: "30 0 * * *",  // old cron differs
      target_kind: "exec",
      command: ["/usr/local/bin/node", "/abs/path/uber.js", "run-daily"],
      cwd: vaultDir,
      env_keys: ["UBER_VAULT_DIR", "TELEGRAM_BOT_TOKEN", "TELEGRAM_PRIMARY_CHAT_ID", "DISCORD_NOTIFY_WEBHOOK_URL", "GCTRL_KERNEL_URL"],
      enabled: true,
      timeout_secs: 300,
    }

    const deleteCalls: Array<string> = []
    const postCalls: Array<unknown> = []
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify([existingRow]) }
      }
      if (method === "DELETE") {
        deleteCalls.push(String(url))
        return { ok: true, status: 204, text: async () => "" }
      }
      if (method === "POST") {
        postCalls.push(JSON.parse(String(init?.body ?? "{}")))
        return { ok: true, status: 201, text: async () => JSON.stringify({ ok: true }) }
      }
      return { ok: true, status: 200, text: async () => "{}" }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]).toContain("uber.morning_brief")
    expect(postCalls).toHaveLength(1)
    const posted = postCalls[0] as Record<string, unknown>
    expect(posted.cron).toBe("0 1 * * *")  // HKT 09:00 → UTC 01:00
  })

  it("DELETEs rows absent from desired set", async () => {
    // schedules.md has no entries but kernel has an existing uber row
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      "---\nschema_version: 1\nschedules: {}\n---\n",
    )

    const existingRow = {
      name: "uber.stale",
      cron: "0 0 * * *",
      target_kind: "exec",
      command: ["/usr/local/bin/node", "/abs/path/uber.js", "run-daily"],
      cwd: vaultDir,
      env_keys: [],
      enabled: true,
      timeout_secs: 300,
    }

    const deleteCalls: Array<string> = []
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (method === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify([existingRow]) }
      }
      if (method === "DELETE") {
        deleteCalls.push(String(url))
        return { ok: true, status: 204, text: async () => "" }
      }
      return { ok: true, status: 200, text: async () => "{}" }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]).toContain("uber.stale")
  })

  it("marks unchanged rows without touching kernel", async () => {
    // Prepare a schedule that already matches exactly
    await writeFile(
      join(vaultDir, "directives/schedules.md"),
      [
        "---",
        "schema_version: 1",
        "schedules:",
        "  morning_brief:",
        "    cron: \"30 8 * * *\"",
        "    tz: Asia/Hong_Kong",
        "    job: brief-and-send",
        "    enabled: true",
        "---",
        "",
      ].join("\n"),
    )

    const existingRow = {
      name: "uber.morning_brief",
      cron: "30 0 * * *",
      target_kind: "exec",
      command: ["/usr/local/bin/node", "/abs/path/uber.js", "run-daily"],
      cwd: vaultDir,
      env_keys: ["UBER_VAULT_DIR", "TELEGRAM_BOT_TOKEN", "TELEGRAM_PRIMARY_CHAT_ID", "DISCORD_NOTIFY_WEBHOOK_URL", "GCTRL_KERNEL_URL"],
      enabled: true,
      timeout_secs: 300,
    }

    const mutateCalls: Array<string> = []
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (method !== "GET") mutateCalls.push(method)
      return { ok: true, status: 200, text: async () => JSON.stringify([existingRow]) }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(scheduleSyncProgram)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(mutateCalls).toHaveLength(0)
  })

  it("fails with kernel_unreachable when kernel returns 500", async () => {
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
