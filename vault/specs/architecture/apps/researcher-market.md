# Application: researcher-market (Stock Market Research Wiki)

A knowledge base application for studying the stock market. Agents ingest earnings reports, SEC filings, analyst notes, market data, and news — incrementally building a persistent wiki of companies, sectors, macro themes, and investment theses. Humans direct research, ask questions, and curate sources. The LLM does the synthesis, cross-referencing, and bookkeeping.

## Architectural Position

researcher-market is a **native application** in the Unix layer model.

```
App (researcher-market) → Shell (HTTP API :4318) → Kernel (Storage, Telemetry, KB)
```

- **Depends on kernel primitives**: `gctrl-kb` (wiki operations), `gctrl-context` (source storage), `gctrl-net` (web crawling), Storage (DuckDB), Telemetry (session tracking)
- **Accesses kernel via HTTP API only** — never imports kernel crates directly
- **Table namespace**: `market_*` (watchlists, portfolios, alerts — app-specific state beyond the wiki)
- **Shares wiki infrastructure** — uses `gctrl-kb` for the persistent knowledge graph; does not maintain its own wiki layer

## Domain Model

### Page Types (extending WikiPageType)

| Page Type | Description | Example |
|-----------|-------------|---------|
| **Company** (entity) | Single company profile — fundamentals, history, thesis | `entities/nvidia.md` |
| **Sector** (entity) | Industry sector overview — companies, trends, dynamics | `entities/semiconductors.md` |
| **Person** (entity) | Key executive, fund manager, analyst | `entities/jensen-huang.md` |
| **Macro Theme** (topic) | Cross-sector thesis — interest rates, AI capex, reshoring | `topics/ai-infrastructure-cycle.md` |
| **Earnings** (source) | Summary of a quarterly earnings report | `sources/nvda-q1-2026.md` |
| **Filing** (source) | Summary of an SEC filing (10-K, 10-Q, 8-K, proxy) | `sources/nvda-10k-2025.md` |
| **Analysis** (synthesis) | Cross-company comparison, sector deep-dive, thesis evolution | `synthesis/gpu-moat-analysis.md` |
| **Signal** (synthesis) | Notable data point or event with cross-references | `synthesis/nvda-guidance-raise-q1-2026.md` |

### Source Types

| Source | Ingestion Method | Notes |
|--------|-----------------|-------|
| Earnings transcripts | `gctrl kb ingest --url` or dropped `.md` | Seeking Alpha, company IR pages |
| SEC filings | `gctrl kb ingest --url` (EDGAR) | 10-K, 10-Q, 8-K, proxy statements |
| Analyst reports | Dropped `.md` or `.pdf` | Third-party research |
| News articles | `gctrl net fetch` → `gctrl kb ingest` | Financial news, press releases |
| Market data | Structured data files (CSV/JSON) | Price history, fundamentals |
| Podcast/video notes | Manual transcription or summary | Interviews, conference calls |

### App-Specific Tables

```sql
-- Watchlists: user-curated lists of companies to track
CREATE TABLE IF NOT EXISTS market_watchlists (
    id          VARCHAR PRIMARY KEY,
    name        VARCHAR NOT NULL,
    description VARCHAR,
    company_ids JSON DEFAULT '[]',     -- list of entity page IDs
    created_at  VARCHAR NOT NULL,
    updated_at  VARCHAR NOT NULL
);

-- Price alerts / event triggers
CREATE TABLE IF NOT EXISTS market_alerts (
    id              VARCHAR PRIMARY KEY,
    company_id      VARCHAR NOT NULL,   -- entity page ID
    alert_type      VARCHAR NOT NULL,   -- earnings_date, filing, price_target, thesis_change
    condition       JSON NOT NULL,
    active          BOOLEAN DEFAULT TRUE,
    last_triggered  VARCHAR,
    created_at      VARCHAR NOT NULL
);
```

## Schema (kb-schema.md for market research)

```markdown
# Market Research Wiki — Schema

## Page Conventions

### Company Pages (entities/)
Required frontmatter: ticker, exchange, sector, market_cap_range
Required sections: ## Overview, ## Thesis, ## Key Metrics, ## Sources
Every company page must link to its sector page.
Thesis section must cite sources with dates — no unsourced claims.

### Earnings Pages (sources/)
Required frontmatter: ticker, quarter, fiscal_year, date
Required sections: ## Key Numbers, ## Guidance, ## Notable Quotes, ## Implications
After ingesting earnings, update the company page's ## Key Metrics and ## Thesis.

### Sector Pages (entities/)
Required sections: ## Companies, ## Dynamics, ## Macro Exposure
Must link to all company pages in the sector.
Update when a new company is added or a macro theme shifts.

### Macro Theme Pages (topics/)
Required sections: ## Thesis, ## Affected Sectors, ## Key Data Points, ## Evolution
Each data point must have a date and source citation.
Flag when new data contradicts the current thesis direction.

## Ingest Workflow (Market-Specific)
1. Earnings: ingest transcript → create source page → update company page (metrics, thesis, guidance) → update sector page if material → log
2. Filing: ingest filing → create source page → update company page (risk factors, legal) → log
3. News: ingest article → update relevant entity pages → flag if thesis-impacting → log
4. Always check for contradictions with current thesis before updating

## Lint Rules
- Every company in a watchlist must have a company page
- Earnings pages older than 2 quarters should be marked as historical
- Thesis sections without recent source citations (>6 months) flagged as stale
```

## Shell Commands

```sh
# Market-specific commands (thin wrappers around gctrl kb)
gctrl market ingest-earnings --ticker NVDA --url https://...
gctrl market ingest-filing --ticker NVDA --filing 10-K --url https://...
gctrl market company NVDA                  # Show company wiki page
gctrl market sector semiconductors          # Show sector page
gctrl market thesis "AI infrastructure"     # Query wiki for thesis
gctrl market watchlist list                 # List watchlists
gctrl market watchlist add NVDA --list core # Add company to watchlist
gctrl market lint                           # Market-specific lint (stale thesis, missing earnings)
```

## Example Workflow

```
Human: "Ingest NVIDIA Q1 2026 earnings transcript"

Agent:
1. gctrl net fetch https://seekingalpha.com/article/nvda-q1-2026-transcript
2. gctrl kb ingest --source sources/nvda-q1-2026-transcript.md
3. Creates: wiki/sources/nvda-q1-2026.md (earnings summary)
4. Updates: wiki/entities/nvidia.md (## Key Metrics, ## Thesis, ## Guidance)
5. Updates: wiki/entities/semiconductors.md (sector dynamics)
6. Updates: wiki/topics/ai-infrastructure-cycle.md (data center capex guidance)
7. Flags: Guidance raise contradicts previous thesis on margin compression
8. Updates: wiki/index.md, wiki/log.md