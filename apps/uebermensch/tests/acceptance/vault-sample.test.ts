import { beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import {
  extractWikilinks,
  findYaml,
  loadVault,
  OBSIDIAN_UNSAFE,
  type LoadedVault,
} from "../helpers/vault.js"
import {
  BriefFrontmatter,
  EntityFrontmatter,
  ProfileYaml,
  SourceFrontmatter,
  SourcesYaml,
  ThesisFrontmatter,
  TopicFrontmatter,
  TopicsYaml,
} from "../helpers/schemas.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const VAULT_ROOT = resolve(__dirname, "../../vault.sample")

describe("vault.sample — structural contract", () => {
  let vault: LoadedVault

  beforeAll(async () => {
    vault = await loadVault(VAULT_ROOT)
  })

  it("loads at least the expected number of pages + YAMLs", () => {
    expect(vault.pages.length).toBeGreaterThanOrEqual(20)
    expect(vault.yamls.length).toBeGreaterThanOrEqual(3)
  })

  it("every markdown file under wiki/ or theses/ has frontmatter with slug + page_type", () => {
    const gated = vault.pages.filter((p) =>
      p.relPath.startsWith("wiki/") || p.relPath.startsWith("theses/") || p.relPath.startsWith("briefs/"),
    )
    for (const page of gated) {
      expect(page.frontmatter.slug, `missing slug in ${page.relPath}`).toBeTypeOf("string")
      expect(page.frontmatter.page_type, `missing page_type in ${page.relPath}`).toBeTypeOf("string")
    }
  })

  it("every filename stem equals its frontmatter slug (source pages allowed YYYY-MM-DD-- prefix)", () => {
    const gated = vault.pages.filter((p) =>
      p.relPath.startsWith("wiki/") || p.relPath.startsWith("theses/"),
    )
    for (const page of gated) {
      expect(page.stem, `stem/slug mismatch in ${page.relPath}`).toBe(page.frontmatter.slug)
    }
  })

  it("every slug is globally unique across the vault", () => {
    const seen = new Map<string, string>()
    for (const page of vault.pages) {
      const slug = page.frontmatter.slug
      if (typeof slug !== "string") continue
      const existing = seen.get(slug)
      if (existing) {
        throw new Error(`duplicate slug "${slug}" in ${page.relPath} and ${existing}`)
      }
      seen.set(slug, page.relPath)
    }
  })

  it("every filename is Obsidian-safe (no : ? * < > | \" \\ /)", () => {
    for (const page of vault.pages) {
      expect(
        OBSIDIAN_UNSAFE.test(page.stem),
        `Obsidian-unsafe filename: ${page.relPath}`,
      ).toBe(false)
    }
  })
})

describe("vault.sample — frontmatter schemas", () => {
  let vault: LoadedVault

  beforeAll(async () => {
    vault = await loadVault(VAULT_ROOT)
  })

  it("thesis pages conform to ThesisFrontmatter", () => {
    const theses = vault.pages.filter((p) => p.frontmatter.page_type === "thesis")
    expect(theses.length).toBeGreaterThanOrEqual(1)
    for (const page of theses) {
      expect(
        () => Schema.decodeUnknownSync(ThesisFrontmatter)(page.frontmatter),
        `bad thesis frontmatter: ${page.relPath}`,
      ).not.toThrow()
    }
  })

  it("entity pages conform to EntityFrontmatter", () => {
    const entities = vault.pages.filter((p) => p.frontmatter.page_type === "entity")
    expect(entities.length).toBeGreaterThan(0)
    for (const page of entities) {
      expect(
        () => Schema.decodeUnknownSync(EntityFrontmatter)(page.frontmatter),
        `bad entity frontmatter: ${page.relPath}`,
      ).not.toThrow()
    }
  })

  it("topic pages conform to TopicFrontmatter", () => {
    const topics = vault.pages.filter((p) => p.frontmatter.page_type === "topic")
    expect(topics.length).toBeGreaterThan(0)
    for (const page of topics) {
      expect(
        () => Schema.decodeUnknownSync(TopicFrontmatter)(page.frontmatter),
        `bad topic frontmatter: ${page.relPath}`,
      ).not.toThrow()
    }
  })

  it("source pages conform to SourceFrontmatter", () => {
    const sources = vault.pages.filter((p) => p.frontmatter.page_type === "source")
    expect(sources.length).toBeGreaterThan(0)
    for (const page of sources) {
      expect(
        () => Schema.decodeUnknownSync(SourceFrontmatter)(page.frontmatter),
        `bad source frontmatter: ${page.relPath}`,
      ).not.toThrow()
    }
  })

  it("brief pages conform to BriefFrontmatter", () => {
    const briefs = vault.pages.filter((p) => p.frontmatter.page_type === "brief")
    expect(briefs.length).toBeGreaterThanOrEqual(1)
    for (const page of briefs) {
      expect(
        () => Schema.decodeUnknownSync(BriefFrontmatter)(page.frontmatter),
        `bad brief frontmatter: ${page.relPath}`,
      ).not.toThrow()
    }
  })
})

describe("vault.sample — wikilink invariants", () => {
  let vault: LoadedVault

  beforeAll(async () => {
    vault = await loadVault(VAULT_ROOT)
  })

  it("every [[wikilink]] is a bare slug (no typed prefixes, no paths, no colons)", () => {
    const offenders: string[] = []
    for (const page of vault.pages) {
      for (const link of extractWikilinks(page.body)) {
        if (/[:\\/]/.test(link.target)) {
          offenders.push(`${page.relPath}: ${link.raw}`)
        }
      }
    }
    expect(offenders, `typed/path wikilinks found:\n${offenders.join("\n")}`).toHaveLength(0)
  })

  it("every [[wikilink]] resolves to a page stem somewhere in the vault", () => {
    const unresolved: string[] = []
    for (const page of vault.pages) {
      for (const link of extractWikilinks(page.body)) {
        if (!vault.byStem.has(link.target)) {
          unresolved.push(`${page.relPath}: [[${link.target}]]`)
        }
      }
    }
    expect(unresolved, `unresolved wikilinks:\n${unresolved.join("\n")}`).toHaveLength(0)
  })
})

describe("vault.sample — thesis + brief quality rules", () => {
  let vault: LoadedVault

  beforeAll(async () => {
    vault = await loadVault(VAULT_ROOT)
  })

  it("no thesis has an empty `disconfirming` list (lint rule `thesis-no-disconfirming`)", () => {
    const theses = vault.pages.filter((p) => p.frontmatter.page_type === "thesis")
    for (const page of theses) {
      const disconfirming = page.frontmatter.disconfirming
      expect(Array.isArray(disconfirming), `${page.relPath} missing disconfirming[]`).toBe(true)
      expect((disconfirming as unknown[]).length, `${page.relPath} empty disconfirming[]`).toBeGreaterThanOrEqual(1)
    }
  })

  it("each brief item section (H3) contains ≥1 wikilink citation (proxy for `brief-citation-coverage`)", () => {
    const briefs = vault.pages.filter((p) => p.frontmatter.page_type === "brief")
    expect(briefs.length).toBeGreaterThanOrEqual(1)

    for (const brief of briefs) {
      const itemSections = splitItemSections(brief.body)
      expect(itemSections.length, `${brief.relPath} has no ### item sections`).toBeGreaterThan(0)

      const uncited = itemSections.filter(
        (s) => extractWikilinks(s.body).length === 0,
      )
      const coverage = 1 - uncited.length / itemSections.length
      expect(
        coverage,
        `${brief.relPath} citation coverage ${(coverage * 100).toFixed(1)}% below 90% threshold; ` +
          `uncited sections: ${uncited.map((s) => s.heading).join(", ")}`,
      ).toBeGreaterThanOrEqual(0.9)
    }
  })
})

describe("vault.sample — yaml profile/topics/sources", () => {
  let vault: LoadedVault

  beforeAll(async () => {
    vault = await loadVault(VAULT_ROOT)
  })

  it("profile.yaml conforms to ProfileYaml", () => {
    const data = findYaml(vault, "profile.yaml")
    expect(data).toBeDefined()
    expect(() => Schema.decodeUnknownSync(ProfileYaml)(data)).not.toThrow()
  })

  it("profile.yaml has ≥1 enabled channel", () => {
    const data = findYaml(vault, "profile.yaml") as {
      delivery: { channels: Record<string, { enabled?: boolean }> }
    }
    const enabled = Object.values(data.delivery.channels).filter((c) => c?.enabled === true)
    expect(enabled.length).toBeGreaterThanOrEqual(1)
  })

  it("topics.yaml conforms to TopicsYaml", () => {
    const data = findYaml(vault, "topics.yaml")
    expect(data).toBeDefined()
    expect(() => Schema.decodeUnknownSync(TopicsYaml)(data)).not.toThrow()
  })

  it("sources.yaml conforms to SourcesYaml and every source.topics slug matches a topics.yaml entry", () => {
    const topicsData = findYaml(vault, "topics.yaml") as { topics: { slug: string }[] }
    const sourcesData = findYaml(vault, "sources.yaml")
    expect(sourcesData).toBeDefined()
    expect(() => Schema.decodeUnknownSync(SourcesYaml)(sourcesData)).not.toThrow()

    const knownTopics = new Set(topicsData.topics.map((t) => t.slug))
    const decoded = Schema.decodeUnknownSync(SourcesYaml)(sourcesData)
    for (const src of decoded.sources) {
      for (const t of src.topics) {
        expect(knownTopics.has(t), `source ${src.slug} references unknown topic "${t}"`).toBe(true)
      }
    }
  })

  it("every thesis's topics[] matches a topics.yaml entry", () => {
    const topicsData = findYaml(vault, "topics.yaml") as { topics: { slug: string }[] }
    const knownTopics = new Set(topicsData.topics.map((t) => t.slug))

    const theses = vault.pages.filter((p) => p.frontmatter.page_type === "thesis")
    for (const page of theses) {
      const topics = (page.frontmatter.topics ?? []) as string[]
      for (const t of topics) {
        expect(knownTopics.has(t), `${page.relPath} references unknown topic "${t}"`).toBe(true)
      }
    }
  })
})

interface ItemSection {
  heading: string
  body: string
}

function splitItemSections(markdown: string): ItemSection[] {
  const lines = markdown.split("\n")
  const sections: ItemSection[] = []
  let current: ItemSection | null = null
  for (const line of lines) {
    const match = /^###\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (current) sections.push(current)
      current = { heading: match[1], body: "" }
    } else if (current) {
      current.body += line + "\n"
    }
  }
  if (current) sections.push(current)
  return sections
}
