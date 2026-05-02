import { Context } from "effect"

/**
 * The three deployment modes uebermensch can operate in:
 *
 * - `local-kernel`  (default) — all LLM calls go through the gctrl kernel's
 *   /api/llm/* routes.  The kernel owns caching, cost tracking, and secret
 *   injection.  This is the dogfood path and the only mode tested end-to-end
 *   today.
 *
 * - `local-direct`  — LLM calls go directly to the Anthropic SDK (or another
 *   provider) without the kernel hop.  Useful for isolated local runs when the
 *   kernel daemon is intentionally absent.  Adapter not yet wired (slice 7).
 *
 * - `cloud-only`    — everything routes through Cloudflare AI Gateway; no
 *   local daemon required.  Intended for hosted / CI deployments.  Adapter not
 *   yet wired (slice 7).
 *
 * Commands continue to compose their own layers today.  Once the direct and
 * cloud adapters land, slice 7 will replace per-command `llmKind` flag logic
 * with a single `buildModeLayer(mode)` factory that reads `ModeConfig`.
 */
export type Mode = "local-kernel" | "local-direct" | "cloud-only"

export const MODES: ReadonlyArray<Mode> = ["local-kernel", "local-direct", "cloud-only"]

export interface ModeConfigShape {
  readonly mode: Mode
}

export class ModeConfig extends Context.Tag("uebermensch/ModeConfig")<
  ModeConfig,
  ModeConfigShape
>() {}

/**
 * Read `UBER_MODE` from the environment, validate it against the known set of
 * modes, and return the resolved value.  Falls back to `"local-kernel"` when
 * the variable is absent or empty.  Exits with an actionable error message when
 * an unrecognised value is supplied — catching the typo at startup is far
 * cheaper than a confusing failure mid-pipeline.
 */
export const resolveMode = (): Mode => {
  const raw = process.env.UBER_MODE
  if (!raw || raw.trim() === "") return "local-kernel"
  const trimmed = raw.trim() as Mode
  if ((MODES as ReadonlyArray<string>).includes(trimmed)) return trimmed
  throw new Error(
    `UBER_MODE="${raw}" is not a valid mode. Accepted values: ${MODES.join(", ")}`,
  )
}
