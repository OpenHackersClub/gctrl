# Uebermensch — Knowledge Base

> How Uebermensch extends `gctrl-kb` (see [kernel knowledgebase.md](../../../../vault/specs/architecture/kernel/knowledgebase.md)) with an investment-domain schema — page types, frontmatter, and lint rules tailored to research, theses, and market tracking.
>
> **Non-goal:** building a parallel wiki. We add page types + frontmatter + lint rules; the link graph, ingest pipeline, and storage are all kernel primitives.

## Design Principles

1. **Investment as a wiki problem.** A thesis is not a row in a database — it's a *living page* linked to companies, sectors, sources, and future synthesis updates. Everything else flows from this.
2. **One thesis, one page.** Each open thesis is one canonical page under `directives/theses/` (authored tier). Updates append synthesis pages under `input/wiki/synthesis/` linked back; the thesis page itself stays terse.
3. **Every claim cites.** A brief item MAY make no claim that's not backed by a `[[wikilink]]` to a source, entity, or synthesis page. The renderer enforces this.
4. **Sources are first-class.** Every external URL that informs a brief becomes a `Source` page. No "drive-by citations" — if it's worth citing, it's worth summarising.
5. **Kernel owns the graph.** Uebermensch adds schema (page types + lint), not storage.

## Page Types

Extends `WikiPageType` from [kernel domain-model § 2](../../../../vault/specs/architecture/domain-model.md#wikimeta--wikipagetype-specs-only) with one new variant (`Thesis`) and a documented convention for using the existing variants in an investment context.

| Type | Kernel variant | Folder | Role | Written by |
|------|---------------|--------|------|-----------|
| **Index** | `Index` | `input/wiki/index.md` | Catalog of all pages | `uber-ingest` LKM pass |
| **Log** | `Log` | `input/wiki/log.md` | Chronological audit | `uber-ingest` LKM pass |
| **Thesis** | `Thesis` *(new)* | `directives/theses/<slug>.md` | One open thesis | User (canonical); LLM (updates to body-below-frontmatter disallowed by default) |
| **Company** | `Entity` (role=company) | `input/wiki/entities/companies/<slug>.md` | One company — private or public | `uber-ingest` |
| **Person** | `Entity` (role=person) | `input/wiki/entities/people/<slug>.md` | One person — founder, analyst, operator | `uber-ingest` |
| **Org** | `Entity` (role=org) | `input/wiki/entities/orgs/<slug>.md` | One non-company org (regulator, lab, fund) | `uber-ingest` |
| **Sector** | `Topic` (role=sector) | `input/wiki/topics/sectors/<slug>.md` | One sector (AI infra, fintech, ...) | `uber-ingest` |
| **Macro-theme** | `Topic` (role=macro) | `input/wiki/topics/macro/<slug>.md` | One macro theme (rates, election cycle, ...) | `uber-ingest` |
| **Market** | `Topic` (role=market) | `input/wiki/topics/markets/<slug>.md` | One tradable instrument or prediction market | `driver-markets` ingest |
| **Source** | `Source` | `input/raw/<yyyy-mm-dd>--<slug>.md` | One external URL — LLM-digested: gist, key numbers, ≤3 essential quotes, our insights, open questions, access metadata. No raw text. See § Source body template below. | `uber-ingest` |
| **Synthesis** | `Synthesis` | `input/wiki/synthesis/<slug>.md` | Cross-cutting analysis | `uber-deepdive` |
| **Question** | `Question` | `input/wiki/questions/<slug>.md` | Filed query result worth keeping | `uber-curator` / user |

The `role` refinement lives in frontmatter (`entity_role: company|person|org`, `topic_role: sector|macro|market`) — the kernel `WikiPageType` stays as-is.

## Filesystem Layout

The wiki is one of the **generated subtrees** of the vault (see [profile.md § Vault Layout](profile.md#vault-layout)). It lives at `$UBER_VAULT_DIR/input/wiki/` — nested under `input/` (the CoS-curated reading root). Source pages — raw URL summaries before they roll up into wiki pages — live at `$UBER_VAULT_DIR/input/raw/`. Theses (the user's research stance) live in `$UBER_VAULT_DIR/directives/theses/`.

```
$UBER_VAULT_DIR/
  directives/
    theses/                           # authored tier — user owns theses (NOT under input/wiki/)
      llm-tooling-consolidation.md
      prediction-market-liquidity.md
  input/
    raw/                              # generated — driver-fetched / manually-pulled URL summaries
      2026-04-18--anthropic-news-claude-opus-4-7.md
      2026-04-17--sec-10k-msft-q3.md
    wiki/                             # generated — LLM-maintained knowledge graph
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
      synthesis/
        thesis-llm-tooling-update-2026-04-15.md
      questions/
        how-do-prediction-market-makers-profit.md
```

**Thesis location note:** theses live under `directives/theses/` (authored tier — the user writes them). The wiki has a `synthesis/` subtree under `input/wiki/synthesis/` for LLM-authored updates that *link to* thesis pages. A thesis's canonical page is NOT inside `input/wiki/`.

**Source location note:** raw source pages live under `input/raw/` (one file per ingested URL). They feed the curator's candidate set; entity/topic/synthesis pages in `input/wiki/` aggregate signal across many sources. A source page is NOT inside `input/wiki/`.

**Naming conventions:**

- Sources: `input/raw/YYYY-MM-DD--<domain-kebab>.md` — sortable by ingest date.
- Synthesis updates to a thesis: `input/wiki/synthesis/thesis-<slug>-update-<YYYY-MM-DD>.md` — parent link back to the thesis page.
- All other pages: `<kebab-case-slug>.md` (stem = slug).
- Filenames are Obsidian-safe — no `:`, `?`, `*`, `<`, `>`, `|`, `"`, `\`, `/` characters.

**Kernel integration:** `gctrl-kb` is configured with `context_root = $UBER_VAULT_DIR`, `wiki_subpath = "input/wiki"`, and `raw_subpath = "input/raw"` when running under the Uebermensch workspace. The kernel writes/reads wiki pages and raw source pages at these paths; no symlinks or duplicate copies.

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
digest_version: 1                  # Citation Mode v1; absent = pre-migration raw page
digested_at: 2026-04-18T12:09:00Z  # when the digest pass ran; absent if pending_digest
prompt_hash: sha256:...            # digest prompt version (separate from curator prompt_hash)
access: open                       # open | paywall | metered
quality:
  word_count: 842
  readability_used: true
  spam_score: 0.02
---
```

**Body** (Citation Mode v1 — replaces the pre-v1 raw markdown dump). Sections appear in this exact order; any may be empty (omit the heading) but none may be reordered:

- `## Gist` — 3–8 bullets; each one complete, citable claim **made by the source itself**. No hedging prose, no raw HTML. This is *what the source says*, not what we make of it.
- `## Key numbers` — bare numeric facts, verbatim or minimally paraphrased. Omit if none.
- `## Essential quotes` — ≤ 3 quotes, ≤ 30 words each, with attribution.
- `## Insights` — 2–6 bullets. **Our** synthesis: what's non-obvious, what tension does this source create with other sources or with active theses ([[<thesis-slug>]] wikilinks allowed here for internal cross-refs), what second-order implication does it have for current research interests. Distinct from Gist — Gist is the source's claims; Insights is what we read into them. Empty (`## Insights` heading + `_None._`) is acceptable when nothing rises above restatement.
- `## Questions` — 2–6 bullets. Open questions the source raises but does not answer: follow-up papers to ingest, hand-waves to verify, dependencies on data/code/scale we don't have, downstream things to track. Each question should be specific enough to drive a search query or a re-read. Empty (`## Questions` heading + `_None._`) is acceptable for purely-confirmatory sources.
- `## Access metadata` — fetched timestamp, extraction method, paywall flag, raw/post-extraction word counts. Written by the ingest pipeline; LLM does not invent these.

The Insights and Questions sections are **uebermensch-authored** at digest time and may be re-curated on subsequent ingestion passes (their content is not part of `content_hash`; see [briefing-pipeline.md § Render + Verify](briefing-pipeline.md#render--verify)). Gist / Key numbers / Essential quotes / Access metadata are stable across re-curations and contribute to `content_hash`.

Pre-v1 source pages (no `digest_version` key) are migrated by `gctrl uber vault migrate-citations` (see [briefing-pipeline.md § Migration: Citation Mode v1](briefing-pipeline.md)). Until migrated, they continue to render as raw text, with a one-line banner.

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
filed_from: cli                    # cli | inbox | chat | sinkin
answered: true
topics: [prediction-market]
sources_cited: [<source-slug>, ...]
---
```

## Wikilink Conventions

Inherits [kernel knowledgebase § Wikilink Format](../../../../vault/specs/architecture/kernel/knowledgebase.md#wikilink-format). Uebermensch keeps wikilinks **Obsidian-native** — every `[[slug]]` is the stem of a markdown file somewhere under the vault. Typed prefixes (`[[thesis:slug]]`, `[[market:slug]]`) are forbidden: Obsidian treats them as a literal page name with a colon in it and the resolver fails.

Rules:

1. **Every link is `[[slug]]` or `[[slug|display text]]`** — the pipe form supplies a rendered label without changing the target.
2. **Slugs are globally unique across all four roots** — `anthropic` is one page, `anthropic.md`, regardless of whether the file lives under `directives/`, `input/`, `output/`, or `action/`. The ingest pipeline rejects a new page whose slug collides.
3. **Page type is derived from the target's frontmatter `page_type`**, not from the link syntax. The renderer knows a link points at a thesis because the target file's frontmatter says so.
4. **Brief/Report/Synthesis bodies use two citation surfaces** (Citation Mode v1):
   - **Internal wiki** (theses, entities, topics, synthesis, questions) — cite inline with bare `[[slug]]`. The renderer converts to app deep links / bare URLs at channel-send time.
   - **External sources** (`page_type: source` under `input/raw/`) — cite with numeric `[n]` markers and list each in the page's `references[]` array, rendered as a `## References` footer. NEVER use `[[slug]]` for an external source from inside a brief/report/synthesis body — see [briefing-pipeline.md § Citation verification is strict](briefing-pipeline.md#citation-verification-is-strict).
5. **Cross-folder links resolve by stem** — `[[anthropic]]` resolves to `input/wiki/entities/companies/anthropic.md` regardless of where the linking file lives; Obsidian's resolver does the same.
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

Inherits the kernel ingest workflow (see [knowledgebase § Ingest](../../../../vault/specs/architecture/kernel/knowledgebase.md#1-ingest)) with one addition:

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
| `synthesis-unparented` | A synthesis page with missing/invalid `parent:` frontmatter AND `generator != "uber-sinkin"` | error |
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
| `brief-citation-coverage` | Last brief has < 90% of claims citing either a `[[slug]]` (internal wiki) or a `[n]` numeric reference (external source) | warn |
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
3. Updates `directives/theses/<slug>.md` frontmatter: `last_reviewed_at: <now>`.
4. Writes `uber_alerts` if `weakens:` count > `supports:` count AND conviction was `high` — prompts the user to re-review.

The deepdive MUST NOT edit the thesis body (body-below-frontmatter). Only the user may edit thesis content directly; the LLM contributes only via linked synthesis pages.

## kb-schema.md (shipped with profile)

Full schema is emitted into the vault at `$UBER_VAULT_DIR/kb-schema.md` by `gctrl uber vault init` — it's the single doc the `uber-ingest` LLM reads every ingest pass to know how to file pages. The user may edit this file (authored tier) to override classification rules.

The file encodes:

- All page types + filename conventions + required frontmatter (duplicates this doc's Frontmatter section in terse form).
- The investment-overlay step.
- The wikilink conventions (including typed prefixes).
- A checklist the LLM runs at end of every ingest.

Policy: the LLM MUST NOT silently invent new page types or frontmatter fields. New types land here first, then in the LLM's checklist. `gctrl kb lint --persona uber` flags any drift.

## Related

- [kernel knowledgebase.md](../../../../vault/specs/architecture/kernel/knowledgebase.md) — base KB design
- [domain-model.md § 6](domain-model.md#6-wiki-extensions-gctrl-kb) — new `Thesis` variant
- [briefing-pipeline.md](briefing-pipeline.md) — how candidate selection + citation resolution work
- [eval.md](eval.md) — lint results fuel eval scores
