import { Effect, Layer } from "effect"
import { CitationError } from "../errors.js"
import { citedSentences, claimSentences, extractLinks, isTypedPrefix } from "../lib/citations.js"
import {
  RendererService,
  type CuratedItem,
  type InterestReportRenderInput,
  type InterestReportRenderResult,
  type RenderInput,
  type RenderResult,
  type ReportIndexRenderInput,
  type ReportIndexRenderResult,
} from "../services/RendererService.js"

const verifyItemCitations = (
  item: CuratedItem,
  idx: number,
  vaultSlugs: ReadonlySet<string>,
  candidateIds: ReadonlySet<string>,
): CitationError | null => {
  for (const src of item.source_candidate_ids) {
    if (!candidateIds.has(src)) {
      return new CitationError({
        message: `item ${idx}: fabricated source candidate id: ${src}`,
        kind: "fabricated_source",
        link: src,
        itemIndex: idx,
      })
    }
  }
  const links = extractLinks(item.summary_md)
  for (const link of links) {
    if (isTypedPrefix(link.target)) {
      return new CitationError({
        message: `item ${idx}: typed prefix forbidden in ${link.raw}`,
        kind: "typed_prefix",
        link: link.raw,
        itemIndex: idx,
      })
    }
    if (!vaultSlugs.has(link.target)) {
      return new CitationError({
        message: `item ${idx}: unresolved wikilink ${link.raw}`,
        kind: "unresolved",
        link: link.raw,
        itemIndex: idx,
      })
    }
  }
  return null
}

const yamlList = (items: ReadonlyArray<string>): string =>
  items.length === 0 ? "[]" : `[${items.join(", ")}]`

const renderFrontmatter = (
  input: RenderInput,
  itemCount: number,
  citedClaims: number,
  totalClaims: number,
): string =>
  [
    "---",
    "page_type: brief",
    `slug: brief-${input.date}`,
    'kind: "daily"',
    `generated_for: "${input.date}"`,
    `generator: "${input.generator}"`,
    `model: "${input.model}"`,
    `prompt_hash: "${input.promptHash}"`,
    `cost_usd: ${input.costUsd}`,
    `item_count: ${itemCount}`,
    `cited_claims: ${citedClaims}`,
    `total_claims: ${totalClaims}`,
    `topics: ${yamlList(input.topicsCovered)}`,
    `theses: ${yamlList(input.thesesCovered)}`,
    "---",
  ].join("\n")

const renderItem = (item: CuratedItem, idx: number): string => {
  const lines: Array<string> = []
  lines.push(`## ${idx + 1}. ${item.title}`)
  lines.push("")
  lines.push(item.summary_md.trim())
  if (item.suggested_action) {
    lines.push("")
    lines.push(`**Suggested action:** ${item.suggested_action.trim()}`)
  }
  return lines.join("\n")
}

const verifyAnalysisCitations = (
  analysis_md: string,
  interestSlug: string,
  vaultSlugs: ReadonlySet<string>,
): CitationError | null => {
  const links = extractLinks(analysis_md)
  for (const link of links) {
    if (isTypedPrefix(link.target)) {
      return new CitationError({
        message: `analysis (${interestSlug}): typed prefix forbidden in ${link.raw}`,
        kind: "typed_prefix",
        link: link.raw,
        itemIndex: -1,
      })
    }
    if (!vaultSlugs.has(link.target)) {
      return new CitationError({
        message: `analysis (${interestSlug}): unresolved wikilink ${link.raw}`,
        kind: "unresolved",
        link: link.raw,
        itemIndex: -1,
      })
    }
  }
  return null
}

const interestReportSlug = (periodLabel: string, interestSlug: string): string =>
  `${periodLabel}--${interestSlug}`

const renderInterestReportFrontmatter = (
  input: InterestReportRenderInput,
  slug: string,
  itemCount: number,
  citedClaims: number,
  totalClaims: number,
): string =>
  [
    "---",
    "page_type: report",
    `slug: report-${slug}`,
    'kind: "weekly"',
    `period_label: "${input.periodLabel}"`,
    `period_start: "${input.periodStart}"`,
    `period_end: "${input.periodEnd}"`,
    `interest_slug: "${input.interestSlug}"`,
    `interest_title: "${input.interestTitle.replace(/"/g, '\\"')}"`,
    `generator: "${input.generator}"`,
    `model: "${input.model}"`,
    `prompt_hash: "${input.promptHash}"`,
    `cost_usd: ${input.costUsd}`,
    `item_count: ${itemCount}`,
    `cited_claims: ${citedClaims}`,
    `total_claims: ${totalClaims}`,
    `topics: ${yamlList(input.interestTopics)}`,
    "---",
  ].join("\n")

const renderReportIndexFrontmatter = (
  input: ReportIndexRenderInput,
  interestCount: number,
): string =>
  [
    "---",
    "page_type: report_index",
    `slug: report-${input.periodLabel}`,
    'kind: "weekly_index"',
    `period_label: "${input.periodLabel}"`,
    `period_start: "${input.periodStart}"`,
    `period_end: "${input.periodEnd}"`,
    `generator: "${input.generator}"`,
    `model: "${input.model}"`,
    `total_cost_usd: ${input.totalCostUsd}`,
    `interest_count: ${interestCount}`,
    `interests: ${yamlList(input.entries.map((e) => e.interestSlug))}`,
    "---",
  ].join("\n")

export const StrictRendererLive = Layer.succeed(RendererService, {
  render: (input) =>
    Effect.gen(function* () {
      const candidateIds = new Set(input.candidates.map((c) => c.id))
      let idx = 0
      for (const item of input.items) {
        const err = verifyItemCitations(item, idx, input.vaultSlugs, candidateIds)
        if (err) return yield* Effect.fail(err)
        idx += 1
      }
      const fullBody = input.items.map(renderItem).join("\n\n")
      const totalClaims = claimSentences(fullBody)
      const citedClaims = citedSentences(fullBody)
      const frontmatter = renderFrontmatter(input, input.items.length, citedClaims, totalClaims)
      const markdown = `${frontmatter}\n\n# Daily brief — ${input.date}\n\n${fullBody}\n`
      const result: RenderResult = {
        markdown,
        itemCount: input.items.length,
        citedClaims,
        totalClaims,
      }
      return result
    }),
  renderInterestReport: (input) =>
    Effect.gen(function* () {
      const aErr = verifyAnalysisCitations(
        input.analysis_md,
        input.interestSlug,
        input.vaultSlugs,
      )
      if (aErr) return yield* Effect.fail(aErr)
      const candidateIds = new Set(input.candidates.map((c) => c.id))
      let iIdx = 0
      for (const item of input.items) {
        const err = verifyItemCitations(item, iIdx, input.vaultSlugs, candidateIds)
        if (err) return yield* Effect.fail(err)
        iIdx += 1
      }

      const slug = interestReportSlug(input.periodLabel, input.interestSlug)
      const bodyParts: Array<string> = []
      const analysis = input.analysis_md.trim()
      if (analysis.length > 0) bodyParts.push(analysis)
      if (input.items.length > 0) {
        const itemLines: Array<string> = ["## Evidence"]
        input.items.forEach((item, idx) => {
          itemLines.push("")
          itemLines.push(`### ${idx + 1}. ${item.title}`)
          itemLines.push("")
          itemLines.push(item.summary_md.trim())
          if (item.suggested_action) {
            itemLines.push("")
            itemLines.push(`**Suggested action:** ${item.suggested_action.trim()}`)
          }
        })
        bodyParts.push(itemLines.join("\n"))
      }
      const body = bodyParts.join("\n\n")
      const totalClaims = claimSentences(body)
      const citedClaims = citedSentences(body)
      const frontmatter = renderInterestReportFrontmatter(
        input,
        slug,
        input.items.length,
        citedClaims,
        totalClaims,
      )
      const header = `# ${input.interestTitle} — ${input.periodLabel}`
      const periodLine = `_Period ${input.periodStart} → ${input.periodEnd}_`
      const questionLine = input.interestQuestion
        ? `> ${input.interestQuestion}\n\n`
        : ""
      const markdown = `${frontmatter}\n\n${header}\n\n${periodLine}\n\n${questionLine}${body}\n`
      const result: InterestReportRenderResult = {
        markdown,
        slug,
        itemCount: input.items.length,
        citedClaims,
        totalClaims,
      }
      return result
    }),
  renderReportIndex: (input) =>
    Effect.sync(() => {
      const frontmatter = renderReportIndexFrontmatter(input, input.entries.length)
      const lines: Array<string> = []
      lines.push(`# Weekly research reports — ${input.periodLabel}`)
      lines.push("")
      lines.push(`_Period ${input.periodStart} → ${input.periodEnd}_`)
      lines.push("")
      if (input.entries.length === 0) {
        lines.push("_No interests had substantive signal this week._")
      } else {
        for (const entry of input.entries) {
          const link = entry.publicUrl
            ? `[${entry.interestTitle}](${entry.publicUrl})`
            : `[[${entry.reportSlug}|${entry.interestTitle}]]`
          lines.push(`## ${link}`)
          lines.push("")
          if (entry.interestQuestion) {
            lines.push(`> ${entry.interestQuestion}`)
            lines.push("")
          }
          if (entry.headline) {
            lines.push(entry.headline.trim())
            lines.push("")
          }
          lines.push(`_${entry.itemCount} item(s)_`)
          lines.push("")
        }
      }
      const markdown = `${frontmatter}\n\n${lines.join("\n").trimEnd()}\n`
      const result: ReportIndexRenderResult = {
        markdown,
        slug: input.periodLabel,
        interestCount: input.entries.length,
      }
      return result
    }),
})
