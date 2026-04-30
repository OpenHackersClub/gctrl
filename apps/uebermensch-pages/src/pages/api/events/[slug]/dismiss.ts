import type { APIRoute } from "astro"
import { dismissSuggestion } from "../../../../lib/events.ts"

export const prerender = false

export const POST: APIRoute = async ({ params, locals, redirect }) => {
  const slug = String(params.slug ?? "")
  const env = (locals as { runtime: { env: { VAULT: R2Bucket } } }).runtime.env
  const result = await dismissSuggestion(env.VAULT, slug)
  const msg = `${result.ok ? "✓" : "✗"} ${slug}: ${result.message}`
  return redirect(`/events/?msg=${encodeURIComponent(msg)}`, 303)
}
