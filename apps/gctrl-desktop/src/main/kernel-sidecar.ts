// Lifecycle manager for the gctrl-kernel sidecar process.
//
// This module owns the rules — when to spawn, when to restart, when to stop —
// without owning the side-effects. The actual `child_process` spawn and the
// real `setTimeout` are injected via the `Spawner` and `Scheduler` ports so the
// behavior is unit-testable without launching processes or sleeping in tests.
//
// Production wiring (Electron main process) will live in a sibling module that
// supplies a `Spawner` backed by `node:child_process.execFile` and a
// `Scheduler` backed by `globalThis.setTimeout` / `clearTimeout`.

export const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 60000] as const

export type SidecarConfig = {
  readonly binPath: string
  readonly port: number
  readonly dataDir: string
  readonly env?: Readonly<Record<string, string>>
}

export type SpawnedProcess = {
  readonly pid: number | undefined
  kill(signal?: NodeJS.Signals): void
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export type Spawner = (config: SidecarConfig) => SpawnedProcess

export type SchedulerHandle = unknown

export type Scheduler = {
  setTimeout(fn: () => void, ms: number): SchedulerHandle
  clear(handle: SchedulerHandle): void
}

export type SidecarLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type SidecarState =
  | "idle"
  | "running"
  | "restartQueued"
  | "stopping"
  | "stopped"

export type SidecarDeps = {
  readonly spawner: Spawner
  readonly scheduler: Scheduler
  readonly logger?: SidecarLogger
}

const noopLogger: SidecarLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export class KernelSidecar {
  private _state: SidecarState = "idle"
  private _process: SpawnedProcess | undefined
  private _backoffIndex = 0
  private _pendingRestart: SchedulerHandle | undefined
  private readonly _logger: SidecarLogger

  constructor(
    private readonly config: SidecarConfig,
    private readonly deps: SidecarDeps,
  ) {
    this._logger = deps.logger ?? noopLogger
  }

  get state(): SidecarState {
    return this._state
  }

  get currentPid(): number | undefined {
    return this._process?.pid
  }

  start(): void {
    if (
      this._state === "running" ||
      this._state === "restartQueued" ||
      this._state === "stopping"
    ) {
      return
    }
    // Coming from idle or stopped: fresh launch. Reset backoff so a new
    // start() after an explicit stop() doesn't inherit a previous flap.
    this._backoffIndex = 0
    this._spawn()
  }

  stop(): void {
    // Always cancel a queued restart, regardless of state — a stale timer
    // firing after stop must never resurrect the sidecar.
    if (this._pendingRestart !== undefined) {
      this.deps.scheduler.clear(this._pendingRestart)
      this._pendingRestart = undefined
    }

    if (this._state === "stopping" || this._state === "stopped") return

    if (this._state === "idle") {
      this._state = "stopped"
      return
    }

    if (this._state === "restartQueued") {
      // Process has already exited; only the timer was holding state.
      this._state = "stopped"
      return
    }

    // running
    this._state = "stopping"
    this._process?.kill("SIGTERM")
  }

  private _spawn(): void {
    const proc = this.deps.spawner(this.config)
    this._process = proc
    this._state = "running"
    proc.onExit((code, signal) => this._onExit(code, signal))
  }

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this._process = undefined

    if (this._state === "stopping") {
      this._state = "stopped"
      this._logger.info(
        `kernel sidecar stopped gracefully (code=${code ?? "null"} signal=${signal ?? ""})`,
      )
      return
    }

    // Unexpected exit — schedule a restart with bounded backoff.
    this._logger.warn(
      `kernel sidecar exited unexpectedly (code=${code ?? "null"} signal=${signal ?? ""}); scheduling restart`,
    )
    const delay =
      RESTART_BACKOFF_MS[Math.min(this._backoffIndex, RESTART_BACKOFF_MS.length - 1)]!
    this._backoffIndex += 1
    this._state = "restartQueued"
    this._pendingRestart = this.deps.scheduler.setTimeout(() => {
      this._pendingRestart = undefined
      // Defensive: if stop() ran between scheduling and firing, do not respawn.
      if (this._state !== "restartQueued") return
      this._spawn()
    }, delay)
  }
}
