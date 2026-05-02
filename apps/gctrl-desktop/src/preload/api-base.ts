// Pure parser: extracts the `--gctrl-api-base=<url>` flag from a list of argv
// entries. Lives in its own module so it can be unit-tested without pulling
// in `electron`. The main process injects this flag via
// `webPreferences.additionalArguments` (see `main/index.ts`).

const FLAG = "--gctrl-api-base="

export const parseApiBase = (argv: readonly string[]): string | undefined => {
  for (const arg of argv) {
    if (arg.startsWith(FLAG)) {
      const value = arg.slice(FLAG.length).trim()
      if (value.length > 0) return value
    }
  }
  return undefined
}
