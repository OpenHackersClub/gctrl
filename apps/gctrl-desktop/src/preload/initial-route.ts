// Pure parser: extracts the `--gctrl-initial-route=<path>` flag from a list
// of argv entries. Mirrors `api-base.ts` — lives in its own module so it can
// be unit-tested without pulling in `electron`. Main injects this flag per
// window via `webPreferences.additionalArguments` so each window can boot the
// SPA on a different route (the packaged `file://` load makes
// `location.pathname` useless for this).

const FLAG = "--gctrl-initial-route="

export const parseInitialRoute = (argv: readonly string[]): string | undefined => {
  for (const arg of argv) {
    if (arg.startsWith(FLAG)) {
      const value = arg.slice(FLAG.length).trim()
      // Belt-and-braces: main already sanitized, but argv is attacker-adjacent.
      if (value.startsWith("/") && !value.startsWith("//")) return value
    }
  }
  return undefined
}
