import { Effect, Layer, Schema } from "effect"
import { LlmError } from "../errors.js"
import type { CandidateRef } from "../lib/candidates.js"
import { sha256 } from "../lib/hash.js"
import { LlmService, type BriefRequest } from "../services/LlmService.js"
import type { CuratedItem } from "../services/RendererService.js"

const MODEL = "claude-opus-4-7"
const INPUT_COST_PER_MTOK = 5.0
const OUTPUT_COST_PER_MTOK = 25.0
const MAX_CANDIDATE_EXCERPT = 2000
const DEFAULT_MAX_TOKENS = 16000

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "")

const excerptOf = (body: string, max: number): string => {
  const trimmed = body.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

const candidateBlock = (c: CandidateRef): string => {
  const fm = c.page.frontmatter
  const title = (fm.title as string | undefined) ?? c.page.stem
  const topics = ((fm.topics as ReadonlyArray<string> | undefined) ?? []).join(", ")
  const url = (fm.url as string | undefined) ?? ""
  const lines: Array<string> = [
    `- id: ${c.id}`,
    `  stem: ${c.page.stem}`,
    `  title: ${title}`,
    `  topics: [${topics}]`,
  ]
  if (url) lines.push(`  url: ${url}`)
  lines.push(`  score: ${c.score.toFixed(3)}`)
  lines.push(`  excerpt: |`)
  const excerptBody = excerptOf(c.page.body, MAX_CANDIDATE_EXCERPT)
  for (const line of excerptBody.split("\n")) lines.push(`    ${line}`)
  return lines.join("\n")
}

const SYSTEM_PROMPT = `You are uebermensch-curator, a chief-of-staff curator that produces a daily brief from a set of wiki pages.

OUTPUT CONTRACT:
- Output MUST be a single JSON object wrapped in a triple-backtick json fenced block. No prose outside the fence.
- Shape: { "items": CuratedItem[], "topicsCovered": string[], "thesesCovered": string[] }
- CuratedItem: {
    "kind": "news" | "update" | "action" | "alert",
    "title": string,
    "summary_md": string,
    "topic": string | null,
    "thesis": string | null,
    "source_candidate_ids": string[],
    "suggested_action": string | null
  }

CITATION RULES (strict — brief generation will FAIL if violated):
- Every \`[[link]]\` in \`summary_md\` MUST match a candidate's \`stem\` field exactly.
- Do NOT use typed-prefix links like \`[[source:x]]\` or \`[[thesis:x]]\` — bare stems only.
- \`source_candidate_ids\` MUST be a subset of the provided candidate \`id\` values (e.g. "cand-0000"). Never fabricate.

CURATION RULES:
- \`summary_md\` is 2–5 sentences of substantive, concrete content derived from the candidate excerpts. No hedging.
- Each item must cite at least one source via a \`[[stem]]\` link AND list the corresponding id in \`source_candidate_ids\`.
- Merge near-duplicate candidates into one item referencing multiple sources.
- \`topic\` is the single most relevant topic slug from the profile, or null.
- Produce at most \`maxItems\` items; prefer high-scored, topic-aligned candidates.
- If there are no usable candidates, return \`{ "items": [], "topicsCovered": [], "thesesCovered": [] }\`.`

const buildUserPrompt = (req: BriefRequest): string => {
  const lines: Array<string> = []
  lines.push(`date: ${req.date}`)
  lines.push(`profile: ${req.profileName}`)
  lines.push(`maxItems: ${req.maxItems}`)
  lines.push(`topics: [${req.topics.join(", ")}]`)
  lines.push(`theses: [${req.thesesSlugs.join(", ")}]`)
  lines.push("")
  lines.push("candidates:")
  for (const c of req.candidates) lines.push(candidateBlock(c))
  lines.push("")
  lines.push("Return ONLY a fenced ```json block with the schema above.")
  return lines.join("\n")
}

const ItemSchema = Schema.Struct({
  kind: Schema.Literal("news", "update", "action", "alert"),
  title: Schema.String,
  summary_md: Schema.String,
  topic: Schema.NullOr(Schema.String),
  thesis: Schema.NullOr(Schema.String),
  source_candidate_ids: Schema.Array(Schema.String),
  suggested_action: Schema.NullOr(Schema.String),
})

const LlmOutputSchema = Schema.Struct({
  items: Schema.Array(ItemSchema),
  topicsCovered: Schema.Array(Schema.String),
  thesesCovered: Schema.Array(Schema.String),
})

type AnthropicResponse = {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
  readonly model?: string
}

const extractJson = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return null
  return text.slice(start, end + 1)
}

const llmErr = (kind: LlmError["kind"], message: string): LlmError =>
  new LlmError({ kind, message })

const classifyKernelStatus = (status: number): LlmError["kind"] => {
  if (status === 503) return "unavailable"
  if (status === 429) return "rate_limited"
  if (status === 400 || status === 401 || status === 403) return "invalid"
  if (status >= 500) return "unavailable"
  return "invalid"
}

const postMessages = (body: unknown): Effect.Effect<AnthropicResponse, LlmError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${kernelBase()}/api/llm/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) {
        throw llmErr(
          classifyKernelStatus(res.status),
          `kernel /api/llm/messages HTTP ${res.status}: ${text.slice(0, 500)}`,
        )
      }
      return text.length > 0 ? (JSON.parse(text) as AnthropicResponse) : ({} as AnthropicResponse)
    },
    catch: (e) =>
      e instanceof LlmError
        ? e
        : llmErr("unavailable", `kernel /api/llm/messages fetch failed: ${String(e)}`),
  })

export const KernelLlmLive = Layer.succeed(LlmService, {
  name: () => `kernel-llm@${MODEL}`,
  generateBrief: (req) =>
    Effect.gen(function* () {
      const userPrompt = buildUserPrompt(req)
      const promptHash = sha256(`${SYSTEM_PROMPT}\n---\n${userPrompt}`)
      const body = {
        model: MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }
      const res = yield* postMessages(body)
      const textBlock = (res.content ?? []).find(
        (b): b is { type: string; text: string } =>
          b.type === "text" && typeof b.text === "string",
      )
      if (!textBlock) {
        return yield* Effect.fail(llmErr("invalid", "kernel response missing text content block"))
      }
      const raw = extractJson(textBlock.text)
      if (raw === null) {
        return yield* Effect.fail(
          llmErr("invalid", "kernel response text did not contain a JSON object"),
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        return yield* Effect.fail(
          llmErr("invalid", `kernel response JSON parse failed: ${String(e)}`),
        )
      }
      const decoded = yield* Schema.decodeUnknown(LlmOutputSchema)(parsed).pipe(
        Effect.mapError((e) =>
          llmErr("invalid", `kernel response schema mismatch: ${String(e)}`),
        ),
      )
      const costUsd =
        ((res.usage?.input_tokens ?? 0) * INPUT_COST_PER_MTOK +
          (res.usage?.output_tokens ?? 0) * OUTPUT_COST_PER_MTOK) /
        1_000_000
      const items: ReadonlyArray<CuratedItem> = decoded.items.map((i) => ({
        kind: i.kind,
        title: i.title,
        summary_md: i.summary_md,
        topic: i.topic,
        thesis: i.thesis,
        source_candidate_ids: i.source_candidate_ids,
        suggested_action: i.suggested_action,
      }))
      return {
        items,
        topicsCovered: decoded.topicsCovered,
        thesesCovered: decoded.thesesCovered,
        promptHash,
        costUsd,
        model: res.model ?? MODEL,
      }
    }),
})

export const _internal = {
  buildUserPrompt,
  extractJson,
  kernelBase,
  LlmOutputSchema,
  SYSTEM_PROMPT,
  MODEL,
}
