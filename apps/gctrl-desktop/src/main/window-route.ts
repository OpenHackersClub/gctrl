// Validates SPA routes the renderer may ask main to open a new window at
// (`open-window` IPC). The route round-trips through
// `webPreferences.additionalArguments` into the preload bridge, so it must be
// a plain app path — never a URL, scheme, or anything shell-expandable.

const ROUTE_RE = /^\/[A-Za-z0-9\-_/.]*$/
const MAX_ROUTE_LENGTH = 512

/**
 * Returns the route when it is a safe SPA path (`/projects/BACK`,
 * `/inbox/threads/<uuid>`, ...), `undefined` otherwise. `/` and empty input
 * also map to `undefined` — "open the default window".
 */
export const sanitizeWindowRoute = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined
  const route = input.trim()
  if (route === "" || route === "/") return undefined
  // `//host` is protocol-relative — a URL, not a route.
  if (route.startsWith("//")) return undefined
  if (route.length > MAX_ROUTE_LENGTH) return undefined
  if (!ROUTE_RE.test(route)) return undefined
  return route
}
