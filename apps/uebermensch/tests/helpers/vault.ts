import { readdir, readFile } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import matter from "gray-matter"
import YAML from "yaml"

export interface VaultPage {
  /** absolute path */
  path: string
  /** path relative to vault root, e.g. "wiki/entities/orgs/iran.md" */
  relPath: string
  /** filename stem (no extension) */
  stem: string
  frontmatter: Record<string, unknown>
  body: string
}

export interface VaultYaml {
  path: string
  relPath: string
  data: unknown
}

export interface LoadedVault {
  root: string
  pages: VaultPage[]
  yamls: VaultYaml[]
  /** map: slug → VaultPage (one entry per page with frontmatter.slug) */
  bySlug: Map<string, VaultPage>
  /** map: stem → VaultPage (for stem-based wikilink resolution per KB spec) */
  byStem: Map<string, VaultPage>
}

export async function loadVault(root: string): Promise<LoadedVault> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const pages: VaultPage[] = []
  const yamls: VaultYaml[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const entryDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path?: string }).path
      ?? root
    const abs = join(entryDir, entry.name)
    const rel = relative(root, abs)
    const ext = extname(entry.name).toLowerCase()

    if (ext === ".md") {
      const raw = await readFile(abs, "utf8")
      const parsed = matter(raw)
      pages.push({
        path: abs,
        relPath: rel,
        stem: basename(entry.name, ".md"),
        frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
        body: parsed.content,
      })
    } else if (ext === ".yaml" || ext === ".yml") {
      const raw = await readFile(abs, "utf8")
      yamls.push({
        path: abs,
        relPath: rel,
        data: YAML.parse(raw),
      })
    }
  }

  const bySlug = new Map<string, VaultPage>()
  const byStem = new Map<string, VaultPage>()
  for (const page of pages) {
    byStem.set(page.stem, page)
    const slug = page.frontmatter.slug
    if (typeof slug === "string" && slug.length > 0) {
      bySlug.set(slug, page)
    }
  }

  return { root, pages, yamls, bySlug, byStem }
}

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g
const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g

export interface Wikilink {
  /** the entire `[[…]]` match */
  raw: string
  /** the stem/slug target before any `|` */
  target: string
  /** optional display label after `|` */
  label?: string
}

/**
 * Extract [[wikilinks]] that Obsidian would actually render as links.
 * Skips content inside fenced code blocks and inline code spans (Obsidian
 * renders `[[slug]]` inside backticks as literal text, not as a link).
 */
export function extractWikilinks(markdown: string): Wikilink[] {
  const stripped = markdown.replace(FENCED_CODE, "").replace(INLINE_CODE, "")
  const links: Wikilink[] = []
  for (const match of stripped.matchAll(WIKILINK_PATTERN)) {
    const [raw, body] = match
    const pipeIdx = body.indexOf("|")
    const target = (pipeIdx === -1 ? body : body.slice(0, pipeIdx)).trim()
    const label = pipeIdx === -1 ? undefined : body.slice(pipeIdx + 1).trim()
    links.push({ raw, target, label })
  }
  return links
}

/** Obsidian-forbidden filename chars per profile.md § Obsidian-friendliness invariants */
export const OBSIDIAN_UNSAFE = /[:?*<>|"\\/]/

export function findYaml(vault: LoadedVault, relPath: string): unknown {
  const found = vault.yamls.find((y) => y.relPath === relPath)
  return found?.data
}

export function findPage(vault: LoadedVault, relPath: string): VaultPage | undefined {
  return vault.pages.find((p) => p.relPath === relPath)
}
