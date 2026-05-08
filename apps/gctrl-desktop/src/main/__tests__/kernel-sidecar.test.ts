import { describe, expect, it, vi } from "vitest"

import {
  KernelSidecar,
  RESTART_BACKOFF_MS,
  type HealthCheck,
  type Scheduler,
  type SidecarConfig,
  type SidecarLogger,
  type SpawnedProcess,
  type Spawner,
} from "../kernel-sidecar"

const config: SidecarConfig = {
  binPath: "/abs/path/to/gctrl-kernel",
  port: 4318,
  dataDir: "/abs/path/to/data",
}

// Default fake: no external daemon → lifecycle proceeds to spawn. Tests that
// exercise the singleton path build their own controllable HealthCheck.
const noExternalDaemon: HealthCheck = async () => false

// Yield a microtask so the awaited probe inside `start()` has a chance to
// resolve before the test inspects state. The probe is fully synchronous in
// these tests (the fake resolves immediately), so a single microtask flush
// is enough.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void

const makeFakeSpawner = (): {
  spawner: Spawner
  spawnCount: () => number
  spawnedConfigs: () => readonly SidecarConfig[]
  triggerExit: (code: number, signal?: NodeJS.Signals | null) => void
  killSignals: () => readonly (NodeJS.Signals | undefined)[]
  lastPid: () => number | undefined
} => {
  const spawned: Array<{
    config: SidecarConfig
    pid: number
    exitHandler: ExitHandler
    killSignal?: NodeJS.Signals
  }> = []

  const spawner: Spawner = (cfg) => {
    const entry: {
      config: SidecarConfig
      pid: number
      exitHandler: ExitHandler
      killSignal?: NodeJS.Signals
    } = {
      config: cfg,
      pid: 1000 + spawned.length,
      exitHandler: () => {},
      killSignal: undefined,
    }
    spawned.push(entry)
    const proc: SpawnedProcess = {
      pid: entry.pid,
      kill: (signal) => {
        entry.killSignal = signal ?? "SIGTERM"
      },
      onExit: (handler) => {
        entry.exitHandler = handler
      },
    }
    return proc
  }

  return {
    spawner,
    spawnCount: () => spawned.length,
    spawnedConfigs: () => spawned.map((s) => s.config),
    triggerExit: (code, signal = null) => spawned[spawned.length - 1]!.exitHandler(code, signal),
    killSignals: () => spawned.map((s) => s.killSignal),
    lastPid: () => spawned[spawned.length - 1]?.pid,
  }
}

type ScheduledItem = { id: number; fn: () => void; ms: number }

const makeFakeScheduler = (): {
  scheduler: Scheduler
  pending: () => readonly ScheduledItem[]
  runAll: () => void
} => {
  const queue: ScheduledItem[] = []
  let nextId = 0

  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      const id = nextId++
      queue.push({ id, fn, ms })
      return id
    },
    clear: (handle) => {
      const idx = queue.findIndex((q) => q.id === handle)
      if (idx >= 0) queue.splice(idx, 1)
    },
  }

  return {
    scheduler,
    pending: () => [...queue],
    runAll: () => {
      const drained = queue.splice(0, queue.length)
      for (const item of drained) item.fn()
    },
  }
}

const silentLogger: SidecarLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe("KernelSidecar.start", () => {
  it("spawns once with the configured binary, port, and data directory", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()

    expect(fakeSpawner.spawnCount()).toBe(1)
    expect(fakeSpawner.spawnedConfigs()[0]).toEqual(config)
    expect(sidecar.state).toBe("running")
    expect(sidecar.currentPid).toBe(fakeSpawner.lastPid())
  })

  it("is a no-op when already running", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    await sidecar.start()
    await sidecar.start()

    expect(fakeSpawner.spawnCount()).toBe(1)
  })
})

describe("KernelSidecar watchdog", () => {
  it("schedules a restart on unexpected exit using the first backoff value", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    fakeSpawner.triggerExit(1)

    expect(sidecar.state).toBe("restartQueued")
    expect(fakeScheduler.pending()).toHaveLength(1)
    expect(fakeScheduler.pending()[0]!.ms).toBe(RESTART_BACKOFF_MS[0])
  })

  it("respawns when the restart timer fires", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    fakeSpawner.triggerExit(1)
    fakeScheduler.runAll()
    // Timer-fired restart re-probes asynchronously; flush the probe before
    // asserting state.
    await flushMicrotasks()

    expect(fakeSpawner.spawnCount()).toBe(2)
    expect(sidecar.state).toBe("running")
  })

  it("uses an increasing backoff for successive crashes, capped at the last value", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    const recordedDelays: number[] = []

    await sidecar.start()
    // Crash repeatedly; expect each backoff to match the schedule, with the
    // tail extending at the cap.
    for (let i = 0; i < RESTART_BACKOFF_MS.length + 2; i++) {
      fakeSpawner.triggerExit(1)
      const next = fakeScheduler.pending()[0]
      expect(next).toBeDefined()
      recordedDelays.push(next!.ms)
      fakeScheduler.runAll()
      await flushMicrotasks()
    }

    const cap = RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]!
    expect(recordedDelays.slice(0, RESTART_BACKOFF_MS.length)).toEqual([...RESTART_BACKOFF_MS])
    expect(recordedDelays.slice(RESTART_BACKOFF_MS.length)).toEqual([cap, cap])
  })
})

describe("KernelSidecar.stop", () => {
  it("sends SIGTERM to the running process and transitions to stopped", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    sidecar.stop()
    // Fake spawner records the kill signal but does not auto-fire exit;
    // simulate a process that exits promptly on SIGTERM by triggering it.
    fakeSpawner.triggerExit(0, "SIGTERM")

    expect(fakeSpawner.killSignals()[0]).toBe("SIGTERM")
    expect(sidecar.state).toBe("stopped")
  })

  it("does not schedule a restart after stop, even on subsequent exit events", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    sidecar.stop()
    fakeSpawner.triggerExit(0, "SIGTERM")

    expect(fakeScheduler.pending()).toHaveLength(0)
    expect(fakeSpawner.spawnCount()).toBe(1)
  })

  it("cancels a queued restart when stop is called between crash and respawn", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    fakeSpawner.triggerExit(1)
    expect(fakeScheduler.pending()).toHaveLength(1)

    sidecar.stop()

    expect(fakeScheduler.pending()).toHaveLength(0)
    expect(sidecar.state).toBe("stopped")

    // Even if a stale timer somehow fired, the sidecar must not respawn.
    fakeScheduler.runAll()
    await flushMicrotasks()
    expect(fakeSpawner.spawnCount()).toBe(1)
  })

  it("is a no-op when called from idle or stopped", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    expect(() => sidecar.stop()).not.toThrow()
    expect(sidecar.state).toBe("stopped")

    await sidecar.start()
    sidecar.stop()
    fakeSpawner.triggerExit(0, "SIGTERM")
    expect(() => sidecar.stop()).not.toThrow()
    expect(sidecar.state).toBe("stopped")
  })
})

describe("KernelSidecar duplicate / stale exit defense", () => {
  it("ignores a duplicate exit event after the lifecycle has already stopped", async () => {
    // Real OS exit fires once per process, but the SpawnedProcess interface is
    // adapter-specific — a buggy adapter that wraps `child.on("exit", h)` could
    // fire twice if multiple listeners are registered. Without a guard, the
    // second fire (post-stop) would fall through to the unexpected-exit branch
    // and resurrect the sidecar. Verify the lifecycle no-ops on the duplicate.
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    fakeSpawner.triggerExit(1) // first (real) exit → restartQueued
    sidecar.stop() // clears timer → stopped
    expect(sidecar.state).toBe("stopped")

    fakeSpawner.triggerExit(1) // duplicate / stale fire on the same process

    expect(sidecar.state).toBe("stopped")
    expect(fakeScheduler.pending()).toHaveLength(0)
    expect(fakeSpawner.spawnCount()).toBe(1)
  })
})

describe("KernelSidecar restart after stop", () => {
  it("allows start() to spawn again after stop, with the backoff counter reset", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger: silentLogger,
    })

    await sidecar.start()
    fakeSpawner.triggerExit(1)
    fakeScheduler.runAll()
    await flushMicrotasks()
    fakeSpawner.triggerExit(1) // second crash → second backoff
    expect(fakeScheduler.pending()[0]!.ms).toBe(RESTART_BACKOFF_MS[1])

    sidecar.stop()
    await sidecar.start()
    fakeSpawner.triggerExit(1)

    expect(fakeScheduler.pending()[0]!.ms).toBe(RESTART_BACKOFF_MS[0])
  })
})

describe("KernelSidecar logging", () => {
  it("logs warnings on unexpected exit and info on graceful shutdown", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const logger: SidecarLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: noExternalDaemon,
      logger,
    })

    await sidecar.start()
    fakeSpawner.triggerExit(1)
    expect(logger.warn).toHaveBeenCalled()

    fakeScheduler.runAll()
    await flushMicrotasks()
    sidecar.stop()
    fakeSpawner.triggerExit(0, "SIGTERM")
    expect(logger.info).toHaveBeenCalled()
  })
})

describe("KernelSidecar singleton (external daemon already running)", () => {
  it("defers to an external daemon — no spawn, state goes to external", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const externalAlive: HealthCheck = async () => true
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: externalAlive,
      logger: silentLogger,
    })

    await sidecar.start()

    expect(fakeSpawner.spawnCount()).toBe(0)
    expect(sidecar.state).toBe("external")
  })

  it("logs the deferral with the configured port so the user knows why we didn't spawn", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const logger: SidecarLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: async () => true,
      logger,
    })

    await sidecar.start()

    expect(logger.info).toHaveBeenCalled()
    const message = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(message).toContain(":4318")
    expect(message).toContain("not spawn")
  })

  it("treats a probe that throws as 'no external daemon' and proceeds to spawn", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const buggyProbe: HealthCheck = async () => {
      throw new Error("network error during probe")
    }
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: buggyProbe,
      logger: silentLogger,
    })

    await sidecar.start()

    expect(fakeSpawner.spawnCount()).toBe(1)
    expect(sidecar.state).toBe("running")
  })

  it("re-probes before each watchdog respawn — defers when an external daemon shows up between crashes", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    let externalAlive = false
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: async () => externalAlive,
      logger: silentLogger,
    })

    await sidecar.start()
    expect(sidecar.state).toBe("running")
    expect(fakeSpawner.spawnCount()).toBe(1)

    // Crash the bundled kernel; user (or brew) brings up `gctrld` between
    // the crash and the restart timer firing.
    fakeSpawner.triggerExit(1)
    expect(sidecar.state).toBe("restartQueued")
    externalAlive = true

    fakeScheduler.runAll()
    await flushMicrotasks()

    // No second spawn; lifecycle has yielded to the external daemon.
    expect(fakeSpawner.spawnCount()).toBe(1)
    expect(sidecar.state).toBe("external")
  })

  it("stop() during an in-flight probe lands in stopped without spawning", async () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    let releaseProbe: ((alive: boolean) => void) | undefined
    const slowProbe: HealthCheck = () =>
      new Promise<boolean>((resolve) => {
        releaseProbe = resolve
      })
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      healthCheck: slowProbe,
      logger: silentLogger,
    })

    const startPromise = sidecar.start()
    expect(sidecar.state).toBe("probing")

    sidecar.stop()
    expect(sidecar.state).toBe("stopped")

    // Probe finally resolves; lifecycle MUST NOT respawn or transition.
    releaseProbe?.(false)
    await startPromise

    expect(fakeSpawner.spawnCount()).toBe(0)
    expect(sidecar.state).toBe("stopped")
  })
})
