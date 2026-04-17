# Application: researcher-agentic (Agentic Workflow Research Wiki)

A knowledge base application for studying agentic AI workflows, agent frameworks, orchestration patterns, and the emerging science of human+agent collaboration. Agents ingest papers, blog posts, framework docs, benchmark results, and conference talks — building a persistent wiki tracking the fast-moving landscape of agent tooling, patterns, and research.

## Architectural Position

researcher-agentic is a **native application** in the Unix layer model.

```
App (researcher-agentic) → Shell (HTTP API :4318) → Kernel (Storage, Telemetry, KB)
```

- **Depends on kernel primitives**: `gctrl-kb` (wiki operations), `gctrl-context` (source storage), `gctrl-net` (web crawling), Storage (DuckDB), Telemetry (session tracking)
- **Accesses kernel via HTTP API only** — never imports kernel crates directly
- **Table namespace**: `agentic_*` (benchmarks, framework comparisons — app-specific state beyond the wiki)
- **Shares wiki infrastructure** — uses `gctrl-kb` for the persistent knowledge graph

## Domain Model

### Page Types (extending WikiPageType)

| Page Type | Description | Example |
|-----------|-------------|---------|
| **Framework** (entity) | Agent framework profile — capabilities, architecture, tradeoffs | `entities/claude-code.md`, `entities/openai-codex.md` |
| **Pattern** (topic) | Orchestration or design pattern for agent systems | `topics/human-in-the-loop.md`, `topics/plan-then-execute.md` |
| **Concept** (topic) | Core idea or primitive in agentic AI | `topics/tool-use.md`, `topics/context-window-management.md` |
| **Researcher** (entity) | Key person or lab in the space | `entities/anthropic.md`, `entities/karpathy.md` |
| **Paper** (source) | Summary of an academic paper or technical report | `sources/react-prompting-2022.md` |
| **Post** (source) | Summary of a blog post, talk, or podcast | `sources/karpathy-kb-pattern-2026.md` |
| **Benchmark** (source) | Agent benchmark results and analysis | `sources/swe-bench-2026-q1.md` |
| **Comparison** (synthesis) | Framework/approach comparison with criteria matrix | `synthesis/codex-vs-claude-code.md` |
| **Thesis** (synthesis) | Evolving thesis on where agentic AI is heading | `synthesis/agent-os-convergence.md` |

### Source Types

| Source | Ingestion Method | Notes |
|--------|-----------------|-------|
| Academic papers | Dropped `.pdf` or `gctrl kb ingest --url` (arXiv) | ReAct, Toolformer, MRKL, etc. |
| Framework docs | `gctrl net crawl` → `gctrl kb ingest --crawl` | Official documentation sites |
| Blog posts | `gctrl net fetch` → `gctrl kb ingest` | Engineering blogs, research announcements |
| Benchmark results | Structured data + analysis | SWE-bench, HumanEval, GAIA |
| Conference talks | Transcription or summary | NeurIPS, ICLR, agent workshops |
| GitHub repos | `gctrl net fetch` README + key files | Framework source code analysis |
| gctrl's own telemetry | `gctrl-context` (kind: snapshot) | Dogfooding data — how our agents perform |

### App-Specific Tables

```sql
-- Framework comparison matrix (structured data beyond wiki prose)
CREATE TABLE IF NOT EXISTS agentic_frameworks (
    id              VARCHAR PRIMARY KEY,
    name            VARCHAR NOT NULL,
    entity_page_id  VARCHAR,            -- link to wiki entity page
    category        VARCHAR NOT NULL,   -- coding_agent, general_agent, orchestrator, sdk
    open_source     BOOLEAN,
    first_release   VARCHAR,            -- date
    latest_version  VARCHAR,
    key_features    JSON DEFAULT '[]',
    limitations     JSON DEFAULT '[]',
    updated_at      VARCHAR NOT NULL
);

-- Benchmark tracking (numerical results for comparison)
CREATE TABLE IF NOT EXISTS agentic_benchmarks (
    id              VARCHAR PRIMARY KEY,
    framework_id    VARCHAR NOT NULL,
    benchmark_name  VARCHAR NOT NULL,   -- swe-bench, humaneval, gaia, etc.
    score           REAL,
    date            VARCHAR NOT NULL,
    source_page_id  VARCHAR,            -- link to source wiki page
    notes           VARCHAR
);
```

## Schema (kb-schema.md for agentic research)

```markdown
# Agentic Research Wiki — Schema

## Page Conventions

### Framework Pages (entities/)
Required frontmatter: category, open_source, url, latest_version
Required sections: ## Overview, ## Architecture, ## Key Features, ## Limitations, ## Benchmarks, ## Sources
Every framework page must link to the patterns it implements.
Benchmark section must cite source pages with dates.

### Pattern Pages (topics/)
Required frontmatter: maturity (emerging|established|deprecated)
Required sections: ## Description, ## When to Use, ## Frameworks, ## Tradeoffs, ## Examples
Must link to all frameworks that implement this pattern.
Include code examples where possible (TypeScript or Python).

### Concept Pages (topics/)
Required sections: ## Definition, ## Why It Matters, ## Related Concepts, ## Open Questions
Must link to at least 2 related concepts.

### Paper Pages (sources/)
Required frontmatter: authors, year, venue, arxiv_id
Required sections: ## Key Idea, ## Method, ## Results, ## Implications for Practitioners
After ingesting a paper, update framework and pattern pages it relates to.

### Comparison Pages (synthesis/)
Required sections: ## Criteria, ## Matrix, ## Analysis, ## Recommendation
Matrix should be a markdown table with frameworks as rows, criteria as columns.
Must cite sources for every claim in the matrix.

## Ingest Workflow (Agentic-Specific)
1. Paper: ingest → create source page → update framework pages (if mentioned) → update pattern pages (if novel pattern) → update concept pages → log
2. Framework docs: crawl → ingest all pages → create/update framework entity → extract patterns implemented → update pattern pages → log
3. Benchmark: ingest results → create source page → update framework pages (## Benchmarks) → update comparison pages → log
4. Always check: does this source change our thesis on any topic? If yes, update synthesis pages.

## Lint Rules
- Every framework must have at least one benchmark result sourced
- Pattern pages without framework links are orphaned patterns — flag
- Papers older than 2 years should have a "still relevant?" note
- Thesis pages without recent evidence (>3 months) flagged as stale
- Framework pages without version updates in 6 months flagged for refresh

## Meta: Dogfooding
This wiki is itself an agentic workflow. Track:
- Cost per ingest (via gctrl telemetry)
- Pages touched per source (measure synthesis effort)
- Query quality over time (are answers improving?)
- Wiki health metrics (orphan rate, link density, freshness)
```

## Shell Commands

```sh
# Agentic research commands (thin wrappers around gctrl kb)
gctrl agentic ingest-paper --url https://arxiv.org/abs/2210.03629 --title "ReAct"
gctrl agentic ingest-docs --crawl docs.anthropic.com
gctrl agentic framework claude-code                # Show framework wiki page
gctrl agentic pattern human-in-the-loop            # Show pattern page
gctrl agentic compare claude-code openai-codex     # Generate/show comparison
gctrl agentic benchmarks --framework claude-code   # Show benchmark results
gctrl agentic thesis "agent OS convergence"        # Query wiki for thesis
gctrl agentic lint                                  # Agentic-specific lint
```

## Example Workflow

```
Human: "Crawl the Claude Code docs and integrate into the wiki"

Agent:
1. gctrl net crawl https://docs.anthropic.com/claude-code --depth 3 --max-pages 100
2. gctrl kb ingest --crawl docs.anthropic.com
3. Creates: wiki/sources/claude-code-docs-crawl.md (crawl summary)
4. Updates: wiki/entities/claude-code.md (## Architecture, ## Key Features, ## Limitations)
5. Creates: wiki/topics/hook-system.md (new pattern discovered in docs)
6. Updates: wiki/topics/tool-use.md (Claude Code's tool implementation)
7. Updates: wiki/topics/context-window-management.md (compaction strategy)
8. Updates: wiki/synthesis/codex-vs-claude-code.md (new data points)
9. Updates: wiki/index.md, wiki/log.md
```

```
Human: "How do coding agents handle context window limits?"

Agent:
1. Reads wiki/index.md → finds: topics/context-window-management.md, entities/claude-code.md, entities/openai-codex.md, entities/cursor.md
2. Reads those pages + follows links to related patterns
3. Synthesizes answer with citations
4. Files as: wiki/synthesis/context-management-strategies.md (worth keeping)
5. Updates index.md and log.md
```

## Cross-App Potential

Both researcher apps share the same kernel and shell infrastructure:

```
researcher-market ──┐
                    ├──→ gctrl-kb (wiki) → gctrl-context (storage) → Kernel
researcher-agentic ─┘
```

Each app has its own wiki namespace (separate `wiki/` directories or tag-based separation), its own schema, and its own domain tables. But they share:
- The same `gctrl kb` CLI and HTTP API
- The same wikilink format and link graph
- The same ingest/query/lint operations
- The same file watcher for reactive imports
- The same web crawling pipeline (`gctrl-net`)
- Cross-wiki linking is possible (e.g., an agentic research page linking to a market data source about AI companies)
