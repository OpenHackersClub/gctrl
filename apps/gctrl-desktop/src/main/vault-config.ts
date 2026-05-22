// First-launch vault picker + persistent vault choice. Obsidian-style:
// on cold launch the bundled kernel needs a vault root to watch, and asking
// the user via a native folder picker is the only path that works when the
// app is launched from the Dock with no shell env. Once chosen, the answer
// persists in `<userData>/vault-config.json` so subsequent launches skip the
// dialog. `GCTRL_BOARD_DIR` (when set) always wins — operators and
// contributors keep their existing escape hatch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const VAULT_CONFIG_FILENAME = "vault-config.json"

export type VaultConfig = {
  /** Absolute path to the vault root the kernel should watch. */
  readonly vaultPath: string
  /** ISO timestamp of when this config was written. Diagnostic only. */
  readonly configuredAt: string
}

/**
 * Folder picker port — narrow surface over Electron's
 * `dialog.showOpenDialog`. Returns the chosen absolute path, or `null` if
 * the user canceled. Wrapped as a port so tests don't have to mock the
 * entire `electron` module.
 */
export type VaultPicker = () => Promise<string | null>

export type ResolveVaultDeps = {
  /** `<userData>` from `app.getPath("userData")`. */
  readonly userDataPath: string
  /**
   * Where to send the kernel if neither env nor persisted config provides
   * a path AND the user cancels the picker. The current default is
   * `<userData>/vault/` (see `resolveKernelVaultDir`), which is empty on a
   * fresh install — same as today's behavior, so canceling is non-fatal.
   */
  readonly defaultVaultDir: string
  /** `process.env.GCTRL_BOARD_DIR`. Highest-priority override. */
  readonly envOverride: string | undefined
  /** Folder-picker port. Only invoked when env + persisted are both absent. */
  readonly picker: VaultPicker
  /** Optional structured logger; defaults to console. */
  readonly logger?: Pick<Console, "info" | "warn">
}

/**
 * Resolve the vault directory to hand the kernel sidecar. Resolution
 * order — first match wins:
 *
 *  1. `GCTRL_BOARD_DIR` env (operator escape hatch — never persisted).
 *  2. `<userData>/vault-config.json` (previous answer from this user).
 *  3. Native folder picker (first launch).
 *  4. `defaultVaultDir` fallback (user canceled — we DON'T persist the
 *     cancel; next launch asks again so the user isn't silently stuck
 *     on an empty vault).
 *
 * The persisted file is written only after the picker returns a path —
 * env-driven values stay ephemeral so flipping the env back unsets it.
 */
export async function resolveVaultDir(deps: ResolveVaultDeps): Promise<string> {
  const logger = deps.logger ?? console

  if (deps.envOverride && deps.envOverride.trim().length > 0) {
    logger.info(`[vault-config] using GCTRL_BOARD_DIR=${deps.envOverride}`)
    return deps.envOverride
  }

  const persisted = readVaultConfig(deps.userDataPath)
  if (persisted) {
    logger.info(`[vault-config] using persisted vault=${persisted.vaultPath}`)
    return persisted.vaultPath
  }

  const chosen = await deps.picker()
  if (chosen) {
    writeVaultConfig(deps.userDataPath, {
      vaultPath: chosen,
      configuredAt: new Date().toISOString(),
    })
    logger.info(`[vault-config] picker chose vault=${chosen}`)
    return chosen
  }

  logger.warn(
    `[vault-config] no vault chosen — falling back to ${deps.defaultVaultDir}. ` +
      `Next launch will prompt again.`,
  )
  return deps.defaultVaultDir
}

/** Read the persisted vault config, or `null` if absent / unreadable. */
export function readVaultConfig(userDataPath: string): VaultConfig | null {
  const file = path.join(userDataPath, VAULT_CONFIG_FILENAME)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as Partial<VaultConfig>
    if (typeof parsed.vaultPath !== "string" || parsed.vaultPath.length === 0) {
      return null
    }
    return {
      vaultPath: parsed.vaultPath,
      configuredAt: typeof parsed.configuredAt === "string" ? parsed.configuredAt : "",
    }
  } catch {
    // Corrupt / mid-write file. Returning null re-triggers the picker —
    // strictly better than crashing the app on launch.
    return null
  }
}

/** Persist the chosen vault path. Creates `<userData>/` if missing. */
export function writeVaultConfig(userDataPath: string, config: VaultConfig): void {
  mkdirSync(userDataPath, { recursive: true })
  const file = path.join(userDataPath, VAULT_CONFIG_FILENAME)
  writeFileSync(file, JSON.stringify(config, null, 2), "utf8")
}
