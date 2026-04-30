import { describe, expect, it, vi } from "vitest"

import {
  KernelSidecar,
  RESTART_BACKOFF_MS,
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
  it("spawns once with the configured binary, port, and data directory", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()

    expect(fakeSpawner.spawnCount()).toBe(1)
    expect(fakeSpawner.spawnedConfigs()[0]).toEqual(config)
    expect(sidecar.state).toBe("running")
    expect(sidecar.currentPid).toBe(fakeSpawner.lastPid())
  })

  it("is a no-op when already running", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    sidecar.start()
    sidecar.start()

    expect(fakeSpawner.spawnCount()).toBe(1)
  })
})

describe("KernelSidecar watchdog", () => {
  it("schedules a restart on unexpected exit using the first backoff value", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    fakeSpawner.triggerExit(1)

    expect(sidecar.state).toBe("restartQueued")
    expect(fakeScheduler.pending()).toHaveLength(1)
    expect(fakeScheduler.pending()[0]!.ms).toBe(RESTART_BACKOFF_MS[0])
  })

  it("respawns when the restart timer fires", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    fakeSpawner.triggerExit(1)
    fakeScheduler.runAll()

    expect(fakeSpawner.spawnCount()).toBe(2)
    expect(sidecar.state).toBe("running")
  })

  it("uses an increasing backoff for successive crashes, capped at the last value", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    const recordedDelays: number[] = []

    sidecar.start()
    // Crash repeatedly; expect each backoff to match the schedule, with the
    // tail extending at the cap.
    for (let i = 0; i < RESTART_BACKOFF_MS.length + 2; i++) {
      fakeSpawner.triggerExit(1)
      const next = fakeScheduler.pending()[0]
      expect(next).toBeDefined()
      recordedDelays.push(next!.ms)
      fakeScheduler.runAll()
    }

    const cap = RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]!
    expect(recordedDelays.slice(0, RESTART_BACKOFF_MS.length)).toEqual([...RESTART_BACKOFF_MS])
    expect(recordedDelays.slice(RESTART_BACKOFF_MS.length)).toEqual([cap, cap])
  })
})

describe("KernelSidecar.stop", () => {
  it("sends SIGTERM to the running process and transitions to stopped", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    sidecar.stop()
    // Fake spawner records the kill signal but does not auto-fire exit;
    // simulate a process that exits promptly on SIGTERM by triggering it.
    fakeSpawner.triggerExit(0, "SIGTERM")

    expect(fakeSpawner.killSignals()[0]).toBe("SIGTERM")
    expect(sidecar.state).toBe("stopped")
  })

  it("does not schedule a restart after stop, even on subsequent exit events", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    sidecar.stop()
    fakeSpawner.triggerExit(0, "SIGTERM")

    expect(fakeScheduler.pending()).toHaveLength(0)
    expect(fakeSpawner.spawnCount()).toBe(1)
  })

  it("cancels a queued restart when stop is called between crash and respawn", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    fakeSpawner.triggerExit(1)
    expect(fakeScheduler.pending()).toHaveLength(1)

    sidecar.stop()

    expect(fakeScheduler.pending()).toHaveLength(0)
    expect(sidecar.state).toBe("stopped")

    // Even if a stale timer somehow fired, the sidecar must not respawn.
    fakeScheduler.runAll()
    expect(fakeSpawner.spawnCount()).toBe(1)
  })

  it("is a no-op when called from idle or stopped", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    expect(() => sidecar.stop()).not.toThrow()
    expect(sidecar.state).toBe("stopped")

    sidecar.start()
    sidecar.stop()
    fakeSpawner.triggerExit(0, "SIGTERM")
    expect(() => sidecar.stop()).not.toThrow()
    expect(sidecar.state).toBe("stopped")
  })
})

describe("KernelSidecar duplicate / stale exit defense", () => {
  it("ignores a duplicate exit event after the lifecycle has already stopped", () => {
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
      logger: silentLogger,
    })

    sidecar.start()
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
  it("allows start() to spawn again after stop, with the backoff counter reset", () => {
    const fakeSpawner = makeFakeSpawner()
    const fakeScheduler = makeFakeScheduler()
    const sidecar = new KernelSidecar(config, {
      spawner: fakeSpawner.spawner,
      scheduler: fakeScheduler.scheduler,
      logger: silentLogger,
    })

    sidecar.start()
    fakeSpawner.triggerExit(1)
    fakeScheduler.runAll()
    fakeSpawner.triggerExit(1) // second crash → second backoff
    expect(fakeScheduler.pending()[0]!.ms).toBe(RESTART_BACKOFF_MS[1])

    sidecar.stop()
    sidecar.start()
    fakeSpawner.triggerExit(1)

    expect(fakeScheduler.pending()[0]!.ms).toBe(RESTART_BACKOFF_MS[0])
  })
})

describe("KernelSidecar logging", () => {
  it("logs warnings on unexpected exit and info on graceful shutdown", () => {
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
      logger,
    })

    sidecar.start()
    fakeSpawner.triggerExit(1)
    expect(logger.warn).toHaveBeenCalled()

    fakeScheduler.runAll()
    sidecar.stop()
    fakeSpawner.triggerExit(0, "SIGTERM")
    expect(logger.info).toHaveBeenCalled()
  })
})
