// Typed client for the kernel's macOS power (prevent-sleep / "caffeinate")
// capability — `GET`/`POST /api/macos/power`. Pure: no `electron` import, so
// the tray controller can be unit-tested with an injected `fetch`.

export type SleepPreventionKind = "display" | "system"

export interface PowerStatus {
  /** Whether the kernel build can actually hold a power assertion. */
  readonly supported: boolean
  /** Whether an assertion is currently held (the Mac won't idle-sleep). */
  readonly active: boolean
  /** Which assertion type is held / would be held. */
  readonly kind: SleepPreventionKind
  /** Reason surfaced in `pmset -g assertions`. */
  readonly reason: string
}

export type PowerResult =
  | { readonly ok: true; readonly status: PowerStatus }
  | { readonly ok: false; readonly error: string }

type FetchLike = typeof fetch

export const POWER_PATH = "/api/macos/power"

const errString = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Read the current prevent-sleep state from the kernel. */
export const fetchPowerStatus = async (
  apiBase: string,
  fetchImpl: FetchLike = fetch,
): Promise<PowerResult> => {
  try {
    const res = await fetchImpl(`${apiBase}${POWER_PATH}`)
    if (!res.ok) return { ok: false, error: `power status HTTP ${res.status}` }
    const status = (await res.json()) as PowerStatus
    return { ok: true, status }
  } catch (err) {
    return { ok: false, error: errString(err) }
  }
}

/** Toggle the prevent-sleep assertion via the kernel. */
export const setPreventSleep = async (
  apiBase: string,
  opts: { enable: boolean; kind?: SleepPreventionKind; reason?: string },
  fetchImpl: FetchLike = fetch,
): Promise<PowerResult> => {
  try {
    const res = await fetchImpl(`${apiBase}${POWER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enable: opts.enable,
        kind: opts.kind,
        reason: opts.reason,
      }),
    })
    if (!res.ok) return { ok: false, error: `set power HTTP ${res.status}` }
    const status = (await res.json()) as PowerStatus
    return { ok: true, status }
  } catch (err) {
    return { ok: false, error: errString(err) }
  }
}
