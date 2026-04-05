/**
 * gctl-board Cloudflare Worker entry point.
 *
 * Handles:
 *   - /api/* routes → board/inbox/team API (D1 backend, wired later)
 *   - Everything else → static assets (SPA with fallback routing)
 */

interface Env {
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Try serving static assets first
    const assetResponse = await env.ASSETS.fetch(request)

    // If asset found, return it
    if (assetResponse.status !== 404) {
      return assetResponse
    }

    // SPA fallback: for non-asset, non-API paths, serve index.html
    // Real asset requests (/assets/*) and API routes (/api/*) should 404 naturally
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/assets/")) {
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request))
    }

    return assetResponse
  },
} satisfies ExportedHandler<Env>
