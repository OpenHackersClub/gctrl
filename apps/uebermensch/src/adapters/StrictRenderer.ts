import { Effect, Layer } from "effect"
import { CitationError } from "../errors.js"
import { citedSentences, claimSentences, extractLinks, isTypedPrefix } from "../lib/citations.js"
import {
  RendererService,
  type CuratedItem,
  type RenderInput,
  type RenderResult,
  type ReportRenderInput,
  type ReportRenderResult,
  type ReportSectionInput,
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

const verifySectionCitations = (
  section: ReportSectionInput,
  sectionIdx: number,
  vaultSlugs: ReadonlySet<string>,
): CitationError | null => {
  const links = extractLinks(section.summary_md)
  for (const link of links) {
    if (isTypedPrefix(link.target)) {
      return new CitationError({
        message: `section ${sectionIdx} (${section.interestSlug}): typed prefix forbidden in ${link.raw}`,
        kind: "typed_prefix",
        link: link.raw,
        itemIndex: sectionIdx,
      })
    }
    if (!vaultSlugs.has(link.target)) {
      return new CitationError({
        message: `section ${sectionIdx} (${section.interestSlug}): unresolved wikilink ${link.raw}`,
        kind: "unresolved",
        link: link.raw,
        itemIndex: sectionIdx,
      })
    }
  }
  return null
}

const renderReportFrontmatter = (
  input: ReportRenderInput,
  sectionCount: number,
  itemCount: number,
  citedClaims: number,
  totalClaims: number,
): string =>
  [
    "---",
    "page_type: report",
    `slug: report-${input.periodLabel}`,
    'kind: "weekly"',
    `period_label: "${input.periodLabel}"`,
    `period_start: "${input.periodStart}"`,
    `period_end: "${input.periodEnd}"`,
    `generator: "${input.generator}"`,
    `model: "${input.model}"`,
    `prompt_hash: "${input.promptHash}"`,
    `cost_usd: ${input.costUsd}`,
    `section_count: ${sectionCount}`,
    `item_count: ${itemCount}`,
    `cited_claims: ${citedClaims}`,
    `total_claims: ${totalClaims}`,
    `interests: ${yamlList(input.sections.map((s) => s.interestSlug))}`,
    "---",
  ].join("\n")

const renderReportSection = (section: ReportSectionInput): string => {
  const lines: Array<string> = []
  lines.push(`## ${section.interestTitle}`)
  lines.push("")
  if (section.interestQuestion) {
    lines.push(`> ${section.interestQuestion}`)
    lines.push("")
  }
  lines.push(section.summary_md.trim())
  if (section.items.length > 0) {
    lines.push("")
    section.items.forEach((item, idx) => {
      lines.push(`### ${idx + 1}. ${item.title}`)
      lines.push("")
      lines.push(item.summary_md.trim())
      if (item.suggested_action) {
        lines.push("")
        lines.push(`**Suggested action:** ${item.suggested_action.trim()}`)
      }
      lines.push("")
    })
  }
  return lines.join("\n").trimEnd()
}

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
  renderReport: (input) =>
    Effect.gen(function* () {
      let sIdx = 0
      for (const section of input.sections) {
        const sErr = verifySectionCitations(section, sIdx, input.vaultSlugs)
        if (sErr) return yield* Effect.fail(sErr)
        const candidateIds = new Set(section.candidates.map((c) => c.id))
        let iIdx = 0
        for (const item of section.items) {
          const err = verifyItemCitations(item, iIdx, input.vaultSlugs, candidateIds)
          if (err) return yield* Effect.fail(err)
          iIdx += 1
        }
        sIdx += 1
      }
      const body = input.sections.map(renderReportSection).join("\n\n")
      const totalClaims = claimSentences(body)
      const citedClaims = citedSentences(body)
      const itemCount = input.sections.reduce((n, s) => n + s.items.length, 0)
      const frontmatter = renderReportFrontmatter(
        input,
        input.sections.length,
        itemCount,
        citedClaims,
        totalClaims,
      )
      const markdown = `${frontmatter}\n\n# Weekly research report — ${input.periodLabel}\n\n_Period ${input.periodStart} → ${input.periodEnd}_\n\n${body}\n`
      const result: ReportRenderResult = {
        markdown,
        sectionCount: input.sections.length,
        itemCount,
        citedClaims,
        totalClaims,
      }
      return result
    }),
})
