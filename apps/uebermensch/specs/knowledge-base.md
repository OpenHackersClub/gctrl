# Uebermensch — Knowledge Base

> How Uebermensch extends `gctrl-kb` (see [kernel knowledgebase.md](../../../specs/architecture/kernel/knowledgebase.md)) with an investment-domain schema — page types, frontmatter, and lint rules tailored to research, theses, and market tracking.
>
> **Non-goal:** building a parallel wiki. We add page types + frontmatter + lint rules; the link graph, ingest pipeline, and storage are all kernel primitives.

## Design Principles

1. **Investment as a wiki problem.** A thesis is not a row in a database — it's a *living page* linked to companies, sectors, sources, and future synthesis updates. Everything else flows from this.
2. **One thesis, one page.** Each open thesis is one canonical page under `wiki/theses/`. Updates append synthesis pages linked back; the thesis page itself stays terse.
3. **Every claim cites.** A brief item MAY make no claim that's not backed by a `[[wikilink]]` to a source, entity, or synthesis page. The renderer enforces this.
4. **Sources are first-class.** Every external URL that informs a brief becomes a `Source` page. No "drive-by citations" — if it's worth citing, it's worth summarising.
5. **Kernel owns the graph.** Uebermensch adds schema (page types + lint), not storage.

## Page Types

Extends `WikiPageType` from [kernel domain-model § 2](../../../specs/architecture/domain-model.md#wikimeta--wikipagetype-specs-only) with one new variant (`Thesis`) and a documented convention for using the existing variants in an investment context.

| Type | Kernel variant | Folder | Role | Written by |
|------|---------------|--------|------|-----------|
| **Index** | `Index` | `wiki/index.md` | Catalog of all pages | `uber-ingest` LKM pass |
| **Log** | `Log` | `wiki/log.md` | Chronological audit | `uber-ingest` LKM pass |
| **Thesis** | `Thesis` *(new)* | `wiki/theses/<slug>.md` | One open thesis | User (canonical); LLM (updates to body-below-frontmatter disallowed by default) |
| **Company** | `Entity` (role=company) | `wiki/entities/companies/<slug>.md` | One company — private or public | `uber-ingest` |
| **Person** | `Entity` (role=person) | `wiki/entities/people/<slug>.md` | One person — founder, analyst, operator | `uber-ingest` |
| **Org** | `Entity` (role=org) | `wiki/entities/orgs/<slug>.md` | One non-company org (regulator, lab, fund) | `uber-ingest` |
| **Sector** | `Topic` (role=sector) | `wiki/topics/sectors/<slug>.md` | One sector (AI infra, fintech, ...) | `uber-ingest` |
| **Macro-theme** | `Topic` (role=macro) | `wiki/topics/macro/<slug>.md` | One macro theme (rates, election cycle, ...) | `uber-ingest` |
| **Market** | `Topic` (role=market) | `wiki/topics/markets/<slug>.md` | One tradable instrument or prediction market | `driver-markets` ingest |
| **Source** | `Source` | `wiki/sources/<yyyy-mm-dd>--<slug>.md` | One external URL summary | `uber-ingest` |
| **Synthesis** | `Synthesis` | `wiki/synthesis/<slug>.md` | Cross-cutting analysis | `uber-deepdive` |
| **Question** | `Question` | `wiki/questions/<slug>.md` | Filed query result worth keeping | `uber-curator` / user |

The `role` refinement lives in frontmatter (`entity_role: company|person|org`, `topic_role: sector|macro|market`) — the kernel `WikiPageType` stays as-is.

## Filesystem Layout

The wiki is the **generated tier** of the vault (see [profile.md § Vault Layout](profile.md#vault-layout)). It lives directly under `$UBER_VAULT_DIR/wiki/` — the same directory the user opens in Obsidian.

```
$UBER_VAULT_DIR/
  theses/                             # authored tier — NOT under wiki/ (user owns theses)
    llm-tooling-consolidation.md
    prediction-market-liquidity.md
  wiki/                               # generated tier — LLM-maintained
    index.md
    log.md
    entities/
      companies/
        anthropic.md
        cursor.md
        kalshi.md
      people/
        dario-amodei.md
        andrej-karpathy.md
      orgs/
        fasb.md
        sec.md
    topics/
      sectors/
        ai-infra.md
        prediction-markets.md
      macro/
        us-rates-path.md
      markets/
        kalshi-inxw-26.md
        poly-us-2024.md
    sources/
      2026-04-18--anthropic-news-claude-opus-4-7.md
      2026-04-17--sec-10k-msft-q3.md
    synthesis/
      thesis-llm-tooling-update-2026-04-15.md
    questions/
      how-do-prediction-market-makers-profit.md
```

**Thesis location note:** theses live at vault root under `theses/` (authored tier — the user writes them). The wiki has a `synthesis/` subtree for LLM-authored updates that *link to* thesis pages. A thesis's canonical page is NOT inside `wiki/`.

**Naming conventions:**

- Sources: `YYYY-MM-DD--<domain-kebab>.md` — sortable by ingest date.
- Synthesis updates to a thesis: `thesis-<slug>-update-<YYYY-MM-DD>.md` — parent link back to the thesis page.
- All other pages: `<kebab-case-slug>.md` (stem = slug).
- Filenames are Obsidian-safe — no `:`, `?`, `*`, `<`, `>`, `|`, `"`, `\`, `/` characters.

**Kernel integration:** `gctrl-kb` is configured with `context_root = $UBER_VAULT_DIR` and `wiki_subpath = "wiki"` when running under the Uebermensch workspace. The kernel writes/reads wiki pages at this path; no symlinks or duplicate copies.

## Frontmatter Schemas

Every page MUST have frontmatter satisfying the page-type's schema. Common fields apply to all pages; page-type specific fields below.

### Common (all page types)

```yaml
---
page_type: thesis|entity|topic|source|synthesis|question|index|log
slug: <kebab-case-slug>          # stable identifier; matches filename minus .md
title: "Human-readable title"
updated_at: 2026-04-18T08:30:00+08:00
confidence: high|medium|low       # optional — authoring confidence
---
```

### Thesis

```yaml
---
page_type: thesis
slug: llm-tooling-consolidation
title: "LLM coding tools consolidate around Claude + open-source runners"
topics: [ai-dev-workflows, ai-infra-open-source]    # profile topic slugs
stance: long|short|watch|avoid
conviction: high|medium|low
opened_at: 2026-02-01
last_reviewed_at: 2026-04-10
owner_profile: vincent            # profile identity; multi-user installs disambiguate
watchlist: [claude-code, cursor, aider, codex]
horizon_months: 18                # review cadence target
disconfirming:
  - "..."
sources: [<source-page-slug>, ...]  # initial evidence set
---
```

### Company / Person / Org (entity_role refinement)

```yaml
---
page_type: entity
slug: anthropic
title: "Anthropic"
entity_role: company              # company | person | org
ticker: null                       # public ticker if applicable
domain: anthropic.com
aliases: ["ANTH"]
sector: ai-infra                   # topic slug
watched_by_thesis: [llm-tooling-consolidation]
sources: [<source-page-slug>, ...]
---
```

### Sector / Macro-theme / Market (topic_role refinement)

```yaml
---
page_type: topic
slug: ai-infra
title: "AI Infrastructure"
topic_role: sector                 # sector | macro | market
parent: null
related_theses: [llm-tooling-consolidation]
watchlist: [anthropic, nvidia, cloudflare]
---
```

**Market-specific** extra fields:

```yaml
---
page_type: topic
slug: kalshi-inxw-26
title: "Kalshi INXW-26 — S&P 500 Week 26"
topic_role: market
venue: kalshi                      # kalshi | polymarket | cboe | ...
market_id: INXW-26
linked_thesis: [us-rates-path]
---
```

### Source

```yaml
---
page_type: source
slug: 2026-04-18--anthropic-news-claude-opus-4-7
title: "Anthropic — Introducing Claude Opus 4.7"
url: https://www.anthropic.com/news/claude-opus-4-7
domain: anthropic.com
published_at: 2026-04-18T12:00:00Z
fetched_at: 2026-04-18T12:07:32Z
authors: ["Anthropic"]
topics: [ai-dev-workflows]
entities: [anthropic]
content_hash: sha256:...           # hash of the fetched markdown; change-detection
quality:
  word_count: 842
  readability_used: true
  spam_score: 0.02
---
```

### Synthesis

```yaml
---
page_type: synthesis
slug: thesis-llm-tooling-update-2026-04-15
title: "LLM tooling thesis — April update"
parent: llm-tooling-consolidation  # MUST be a thesis slug
updated_at: 2026-04-15T07:00:00+08:00
covers_period:
  from: 2026-03-15
  to: 2026-04-15
sources_cited: [<source-slug>, ...]
prompt_hash: sha256:...            # curator or deepdive prompt version
generator: uber-deepdive
---
```

### Question

```yaml
---
page_type: question
slug: how-do-prediction-market-makers-profit
title: "How do prediction-market makers profit?"
asked_at: 2026-04-10T22:14:00+08:00
filed_from: cli                    # cli | inbox | chat
answered: true
topics: [prediction-market]
sources_cited: [<source-slug>, ...]
---
```

## Wikilink Conventions

Inherits [kernel knowledgebase § Wikilink Format](../../../specs/architecture/kernel/knowledgebase.md#wikilink-format). Uebermensch keeps wikilinks **Obsidian-native** — every `[[slug]]` is the stem of a markdown file somewhere under the vault. Typed prefixes (`[[thesis:slug]]`, `[[market:slug]]`) are forbidden: Obsidian treats them as a literal page name with a colon in it and the resolver fails.

Rules:

1. **Every link is `[[slug]]` or `[[slug|display text]]`** — the pipe form supplies a rendered label without changing the target.
2. **Slugs are globally unique within the vault** — `anthropic` is one page, `anthropic.md`, wherever it lives under the vault. The ingest pipeline rejects a new page whose slug collides.
3. **Page type is derived from the target's frontmatter `page_type`**, not from the link syntax. The renderer knows a link points at a thesis because the target file's frontmatter says so.
4. **Brief items MUST cite via `[[slug]]`** — not via raw URL. The renderer converts to app deep links / bare URLs at channel-send time.
5. **Cross-folder links resolve by stem** — `[[anthropic]]` resolves to `wiki/entities/companies/anthropic.md` regardless of where the linking file lives; Obsidian's resolver does the same.
6. **No relative paths in links** — `[[../wiki/entities/companies/anthropic]]` breaks as soon as a file moves. Use bare stems.

The curator prompt is instructed to cite with bare slugs only; the renderer's citation verifier rejects any link containing `:`, `/`, or `\`.

## Link Types (kb_links.link_type)

Inherits the kernel set: `reference`, `parent`, `prerequisite`, `refines`, `contradicts`. Adds two Uebermensch-specific types:

| Link type | Source → Target | Semantics |
|-----------|-----------------|-----------|
| `supports` | synthesis → thesis | Synthesis page supports the thesis |
| `weakens` | synthesis → thesis | Synthesis page weakens the thesis (lowers conviction) |

Both are authored by `uber-deepdive`, not by the user. They fuel the "conviction drift" signal surfaced in the eval dashboard.

## Ingest Pipeline Extensions

Inherits the kernel ingest workflow (see [knowledgebase § Ingest](../../../specs/architecture/kernel/knowledgebase.md#1-ingest)) with one addition:

**Investment overlay step** (between "extract entities" and "update index"):

1. For each new entity with `entity_role: company`:
   - Check if ticker/domain already resolves to a sector page; if not, infer sector from LLM extraction.
2. For each new source:
   - If its topics intersect an open thesis's topics → add a `reference` link from the source → thesis.
   - If the source's domain is in `profile.avoid` patterns → tag the source with `quality.spam_score ≥ 0.8` and skip it from brief candidates.
3. Update any market page whose `linked_thesis` includes a thesis touched by this source.

The overlay is a prompted pass in `uber-ingest` — not kernel code. It runs against the profile loaded at ingest time; if the profile changes mid-ingest (unlikely), the ingest MUST complete against the starting profile to avoid split-brain.

## Lint Rules

Runs as `gctrl kb lint --persona uber`. Surfaces via app eval dashboard + inbox alert when rules flip from OK to FAIL.

### Structural

| Rule | FAIL condition | Severity |
|------|----------------|----------|
| `thesis-has-sources` | A thesis page with 0 backlinks from synthesis pages older than 30 days | warn |
| `thesis-review-stale` | `last_reviewed_at` older than `horizon_months / 6` | warn |
| `source-cited-once` | A source page never cited by any synthesis or brief | info |
| `orphan-company` | A company page with 0 inbound links | info |
| `synthesis-unparented` | A synthesis page with missing/invalid `parent:` frontmatter | error |
| `market-without-thesis` | A market page with empty `linked_thesis` | warn |
| `contradicts-unresolved` | A `contradicts` link sits between two pages with matching `updated_at` within 7 days | warn |

### Quality

| Rule | FAIL condition | Severity |
|------|----------------|----------|
| `thesis-no-disconfirming` | Thesis page lacks non-empty `disconfirming:` list | error |
| `source-low-quality` | `quality.word_count < 50` OR `quality.spam_score > 0.6` | warn |
| `source-paywall-notice` | Source domain in paywall list AND no fallback summary | info |
| `stale-topic` | Topic page not updated while >5 sources tagging it have landed | warn |

### Brief-specific

| Rule | FAIL condition | Severity |
|------|----------------|----------|
| `brief-citation-coverage` | Last brief has < 90% of claims citing a wiki page | warn |
| `brief-same-source-reuse` | > 40% of a brief's items cite the same source | warn |
| `brief-thesis-dominance` | > 60% of a brief's items link one thesis (echo chamber) | info |

Lint policy: **warn** flips a wiki health indicator in the app; **error** blocks the next brief until resolved; **info** is logged.

## Scrape Quality Gates

Before a page enters `brief candidate` set, it MUST pass:

1. `quality.word_count ≥ 50` (tunable per source driver).
2. `quality.readability_used == true` OR `raw.source_trusted` is true.
3. `published_at` within the brief window (default 24h).
4. Source domain has 7-day success-rate > 50% (see [eval.md § Scrape Health](eval.md#scrape-health)).

Failed pages still persist — they just don't feed curator candidate selection. The scrape-health dashboard (`gctrl uber scrape-health`) reports domain-level stats.

## Wiki → Brief Candidate Query

The candidate query shape (pseudocode; implementation in `KbPort.queryRecent`):

```
SELECT ce.id, ce.updated_at, kp.page_type, kp.source_ids
FROM context_entries ce
JOIN kb_pages kp ON kp.entry_id = ce.id
LEFT JOIN kb_links src_link ON src_link.target_id = ce.id
WHERE
  ce.updated_at >= :since
  AND kp.page_type IN ('source', 'synthesis', 'question')
  AND (
    ce.id IN (
      SELECT target_id FROM kb_links
      WHERE source_id IN (SELECT id FROM context_entries WHERE slug = ANY(:topic_slugs))
    )
    OR ce.frontmatter->>'topics' ?| :topic_slugs
  )
  AND (ce.frontmatter->'quality'->>'spam_score')::float < 0.6
ORDER BY ce.updated_at DESC
LIMIT :cap;
```

The curator then ranks + filters this set against profile weights + avoid list (see [briefing-pipeline.md](briefing-pipeline.md)).

## Deepdive Pipeline (Thesis Updates)

Runs monthly per thesis (or on-demand via `gctrl uber deepdive <slug>`).

1. Query: all pages with any link to the thesis, `updated_at >= last_reviewed_at - 7d`.
2. `uber-deepdive` persona synthesises a new synthesis page `thesis-<slug>-update-<date>.md`:
   - `parent: <thesis-slug>`
   - `supports:` / `weakens:` links to the thesis based on the analysis.
   - Cites ≥ 3 sources newly collected since the last update.
3. Updates `theses/<slug>.md` frontmatter: `last_reviewed_at: <now>`.
4. Writes `uber_alerts` if `weakens:` count > `supports:` count AND conviction was `high` — prompts the user to re-review.

The deepdive MUST NOT edit the thesis body (body-below-frontmatter). Only the user may edit thesis content directly; the LLM contributes only via linked synthesis pages.

## kb-schema.md (shipped with profile)

Full schema ships under `apps/uebermensch/vault.sample/kb-schema.md` — it's the single doc the `uber-ingest` LLM reads every ingest pass to know how to file pages. Vault may override with a local `$UBER_VAULT_DIR/kb-schema.md` (authored tier).

The file encodes:

- All page types + filename conventions + required frontmatter (duplicates this doc's Frontmatter section in terse form).
- The investment-overlay step.
- The wikilink conventions (including typed prefixes).
- A checklist the LLM runs at end of every ingest.

Policy: the LLM MUST NOT silently invent new page types or frontmatter fields. New types land here first, then in the LLM's checklist. `gctrl kb lint --persona uber` flags any drift.

## Related

- [kernel knowledgebase.md](../../../specs/architecture/kernel/knowledgebase.md) — base KB design
- [domain-model.md § 6](domain-model.md#6-wiki-extensions-gctrl-kb) — new `Thesis` variant
- [briefing-pipeline.md](briefing-pipeline.md) — how candidate selection + citation resolution work
- [eval.md](eval.md) — lint results fuel eval scores
