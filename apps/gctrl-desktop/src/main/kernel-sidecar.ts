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

// Compile-time guarantee the schedule is non-empty: `_onExit` indexes into
// this array, and `as const []` would silently produce `undefined * delay`.
type _NonEmptyBackoff = typeof RESTART_BACKOFF_MS extends readonly [number, ...number[]]
  ? true
  : never
const _backoffNonEmpty: _NonEmptyBackoff = true
void _backoffNonEmpty

export type SidecarConfig = {
  readonly binPath: string
  readonly port: number
  readonly dataDir: string
  /**
   * Vault root the kernel watches for `*.md` issue files. Forwarded as
   * `--board-dir`; the kernel auto-registers a `default` mount here on
   * first boot when `gctrl_vault_mounts` is empty so the file watcher
   * starts indexing without any UI flow.
   */
  readonly vaultDir?: string
  readonly env?: Readonly<Record<string, string>>
}

export type SpawnedProcess = {
  readonly pid: number | undefined
  kill(signal?: NodeJS.Signals): void
  /**
   * Register a one-shot exit handler.
   *
   * Contract: the handler fires AT MOST ONCE per `SpawnedProcess`. Adapters
   * MUST guard against the underlying runtime emitting `exit` more than once
   * for the same process — this lifecycle treats a second `_onExit` as a
   * no-op only when state is `stopped`/`idle`; for other states a duplicate
   * call would corrupt the state machine.
   */
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export type Spawner = (config: SidecarConfig) => SpawnedProcess

// `node:timers` returns `NodeJS.Timeout` (Node) or `number` (browser). The
// production scheduler in PR-2 wraps `globalThis.setTimeout`, so this matches
// what `ReturnType<typeof setTimeout>` produces in a node-types context.
export type SchedulerHandle = NodeJS.Timeout | number

export type Scheduler = {
  setTimeout(fn: () => void, ms: number): SchedulerHandle
  clear(handle: SchedulerHandle): void
}

/**
 * Probe an existing daemon on the configured host/port. Returns `true` when a
 * gctrl daemon is already responding to `/health`, in which case the lifecycle
 * defers to it instead of spawning the bundled binary — the singleton check
 * that lets a brew/cargo `gctrld` (or a prior session that survived an app
 * restart) keep ownership of `:4318` and the DuckDB writer lock without two
 * processes racing.
 *
 * Implementations MUST tolerate timeouts and connection errors by resolving
 * `false` rather than rejecting; a probe failure means "no external daemon",
 * not "abort startup".
 */
export type HealthCheck = (config: SidecarConfig) => Promise<boolean>

export type SidecarLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type SidecarState =
  | "idle"
  | "probing"
  | "running"
  | "external"
  | "restartQueued"
  | "stopping"
  | "stopped"

export type SidecarDeps = {
  readonly spawner: Spawner
  readonly scheduler: Scheduler
  readonly healthCheck: HealthCheck
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
  // Monotonic counter — incremented at the start of every `_probeAndSpawn`.
  // Each probe captures the epoch it was issued under and refuses to act if
  // a newer probe has been queued by the time it resolves. Without this, a
  // start → stop → start sequence with a slow probe would let the first
  // probe's verdict mutate the lifecycle for the second start (state is
  // `probing` again, so the freshness guard alone is not enough).
  private _probeEpoch = 0
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

  /**
   * Spawn the sidecar — but only after probing for an existing daemon on the
   * configured port. If something is already answering `/health`, the
   * lifecycle defers to it (state `external`) rather than racing for the port
   * and the DuckDB writer lock.
   *
   * - From `idle` or `stopped`: probes, then either spawns or transitions to
   *   `external`. Backoff counter resets so a `start()` after explicit
   *   `stop()` does not inherit a previous flap.
   * - From `probing`, `running`, `restartQueued`, `external`, `stopping`:
   *   no-op (idempotent).
   *
   * Composing `start()` over an in-flight `stop()` intentionally requires
   * explicit serialization — callers must await graceful shutdown
   * (state transitions to `stopped` on `_onExit`) and call `start()` again.
   *
   * Returns a Promise that resolves once the probe completes and the
   * lifecycle has decided to spawn or defer. Callers that don't care can
   * ignore the return value with `void sidecar.start()`.
   */
  async start(): Promise<void> {
    if (
      this._state === "probing" ||
      this._state === "running" ||
      this._state === "restartQueued" ||
      this._state === "external" ||
      this._state === "stopping"
    ) {
      return
    }
    this._backoffIndex = 0
    await this._probeAndSpawn()
  }

  stop(): void {
    // Always cancel a queued restart, regardless of state — a stale timer
    // firing after stop must never resurrect the sidecar.
    if (this._pendingRestart !== undefined) {
      this.deps.scheduler.clear(this._pendingRestart)
      this._pendingRestart = undefined
    }

    if (this._state === "stopping" || this._state === "stopped") return

    if (this._state === "idle" || this._state === "external") {
      // `external` means we never owned a process — there's nothing to kill.
      this._state = "stopped"
      return
    }

    if (this._state === "probing") {
      // The probe is in-flight. Mark stopped now; when the promise resolves,
      // `_probeAndSpawn` checks state and bails before spawning.
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

  private async _probeAndSpawn(): Promise<void> {
    this._state = "probing"
    const epoch = ++this._probeEpoch
    let externalAlive = false
    try {
      externalAlive = await this.deps.healthCheck(this.config)
    } catch {
      // Defensive: the HealthCheck contract says implementations should
      // resolve false on failure, but if a buggy adapter rejects, treat the
      // same as "no external daemon" and proceed to spawn.
      externalAlive = false
    }

    // A newer probe has been issued (e.g. stop → start while we awaited).
    // The lifecycle is now driven by that probe; ours is stale data.
    if (this._probeEpoch !== epoch) return

    // stop() may have run while the probe was in flight. Honor it.
    if (this._state !== "probing") return

    if (externalAlive) {
      this._state = "external"
      this._logger.info(
        `external gctrl daemon detected on :${this.config.port} — bundled kernel sidecar will not spawn`,
      )
      return
    }

    this._spawn()
  }

  private _spawn(): void {
    const proc = this.deps.spawner(this.config)
    this._process = proc
    this._state = "running"
    proc.onExit((code, signal) => this._onExit(code, signal))
  }

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Defense against late / duplicate exit events. If we're already in a
    // terminal post-stop state, a stale fire from a prior process MUST NOT
    // queue a phantom restart. Without this guard a delayed OS exit event
    // arriving after `stop()` would fall through to the unexpected-exit
    // branch below and resurrect the sidecar.
    if (this._state === "stopped" || this._state === "idle") {
      this._process = undefined
      return
    }

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
      // Re-probe before respawning. Covers the "another daemon came up
      // between crashes" path — typically the user starting `gctrld serve`
      // by hand to debug, or a brew/cargo install grabbing :4318 while the
      // bundled kernel was flapping.
      void this._probeAndSpawn()
    }, delay)
  }
}
