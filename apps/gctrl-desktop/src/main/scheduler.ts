// Production scheduler: thin wrapper around Node's `setTimeout`/`clearTimeout`.
// Tests use the fake scheduler in `__tests__/kernel-sidecar.test.ts` instead.

import type { Scheduler } from "./kernel-sidecar"

export const createScheduler = (): Scheduler => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (handle) => {
    // The lifecycle stores handles as opaque values; cast back to the
    // node-types signature to satisfy `clearTimeout`.
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0])
  },
})
