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
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
