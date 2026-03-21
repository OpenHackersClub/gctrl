# GroundCtrl — Product Requirements Document

> **GroundCtrl is an operating system for human+agent teams to build software projects.** The "kernel" is the local daemon; the "filesystem" is DuckDB + R2; the "scheduler" is the capacity engine; the "process manager" is guardrails. Every developer runs their own ground control station locally; together, the stations form a distributed mission control network.
>
> Or, in product terms: **Langfuse observability + Notion knowledge workspace + custom Claude Code skills — but local-first, running entirely on your machine.**
>
> See [local-ccli.md](../strategy/local-ccli.md) for executive summary, pillars overview, and target audience.

## 4. System Architecture

The system operates on a **Local-First + Cloud-Sync** model.

```
┌──────────────────────────────────────────────────────────────────┐
│  Developer Machine                                                │
│                                                                   │
│  ┌──────────┐    ┌──────────────────────────────────────────┐    │
│  │ Claude   │───▶│              GroundCtrl Daemon                   │    │
│  │ Code     │    │                                            │    │
│  ├──────────┤    │  ┌───────────┐  ┌──────────────────────┐  │    │
│  │ Aider    │───▶│  │ Guardrails│  │ Unified DevOps CLI   │  │    │
│  ├──────────┤    │  │ Engine    │  │ (gh/aws/pulumi/slack) │  │    │
│  │ OpenDevin│───▶│  └───────────┘  └──────────────────────┘  │    │
│  ├──────────┤    │  ┌───────────┐  ┌──────────────────────┐  │    │
│  │ Custom   │───▶│  │ MITM Proxy│  │ OTel + Eval Engine   │  │    │
│  │ Agents   │    │  │ (network) │  │                      │  │    │
│  └──────────┘    │  └───────────┘  └──────────────────────┘  │    │
│                  │  ┌────────────────────────────────────────┐│    │
│                  │  │ Capacity & Project Intelligence Engine ││    │
│                  │  │ (issue sync, throughput, forecasting)  ││    │
│                  │  └────────────────────────────────────────┘│    │
│                  │         │              │            │       │    │
│                  │    ┌────▼──────────────▼────────────▼──┐   │    │
│                  │    │      DuckDB (local store)          │   │    │
│                  │    │  traces │ traffic │ events │ tasks │   │    │
│                  │    └──────────────┬─────────────────────┘   │    │
│                  │                   │ R2 Sync Engine          │    │
│                  │                   │ (WAL export + Parquet)  │    │
│                  └──────────────────┬┘────────────────────────┘    │
│                                     │                              │
└─────────────────────────────────────┼──────────────────────────────┘
                                      │ S3-compatible API
                        ┌─────────────▼──────────────┐
                        │    Cloudflare R2 Bucket     │
                        │                             │
                        │  /{workspace}/traces/*.pq   │
                        │  /{workspace}/traffic/*.pq  │
                        │  /{workspace}/events/*.pq   │
                        │  /{workspace}/evals/*.pq    │
                        │  /{workspace}/capacity/*.pq │
                        │  /_manifests/{device}.json  │
                        └─────────────┬──────────────┘
                                      │
               ┌──────────────────────▼──────────────────────┐
               │     Cloudflare Workers + D1 + Analytics     │
               │                                              │
               │  ┌─────────┐ ┌──────────┐ ┌──────────────┐ │
               │  │ Team    │ │ Project  │ │ Org-wide     │ │
               │  │ Dash    │ │ Planning │ │ AI Adoption  │ │
               │  │ (Pages) │ │ & Forecast│ │ Metrics      │ │
               │  └─────────┘ └──────────┘ └──────────────┘ │
               │                                              │
               │  D1 (relational) │ R2 (analytical/bulk)     │
               │  ◄──── Linear / GitHub Issues / Notion ────► │
               └──────────────────────────────────────────────┘
```

### 4.1. The Local Daemon

Runs in the background on the developer's machine.

* **MITM Proxy** (`gctl net proxy`) — Transparent HTTP proxy that intercepts all agent traffic to LLM APIs and external services. Logs to `traffic.jsonl`. Enables network-level guardrails.
* **Command Gateway** — All DevOps operations route through `gctl` (not bare `gh`, `aws`, `pulumi`). This creates a single audit log and enforcement point.
* **OTel Receiver** (`gctl otel`) — Accepts OTLP spans over HTTP, stores in DuckDB with full span hierarchy, session tracking, and cost attribution.
* **Eval Engine** (planned) — Runs prompt/agent evaluations locally, stores results alongside traces for correlation.
* **Capacity Engine** (planned) — Ingests issue tracker data (Linear, GitHub Issues, Notion), correlates with execution telemetry, produces throughput metrics and delivery forecasts.
* **Local DuckDB** — Embedded analytical DB for traces, traffic logs, GitHub events, eval results, and project/task data. Works fully offline.
* **R2 Sync Engine** — Asynchronous sync of local DuckDB data to Cloudflare R2 as Parquet files. See Section 4.4.

### 4.2. Tech Stack (Rust)

Already implemented in the prototype:

| Layer | Choice |
|-------|--------|
| **Language** | Rust (2021 edition) |
| **Async Runtime** | `tokio` (full) |
| **Web Framework** | `axum` 0.8 (OTel receiver, webhook listener) |
| **CLI** | `clap` (derive macros), plugin architecture |
| **HTTP Client** | `reqwest` 0.12 |
| **MITM Proxy** | `hudsucker` 0.24 (auto-CA generation) |
| **Web Crawling** | `spider` 2.0 + `dom_smoothie` (readability) |
| **Storage** | `duckdb` 1.0 (bundled, embedded) |
| **Cloud Sync** | `rust-s3` or `aws-sdk-s3` (R2 is S3-compatible) |
| **Export Format** | Apache Parquet via `arrow` + `parquet` crates |
| **AWS** | `aws-sdk-*` 1.0 (STS, ECS, CloudWatch) |
| **Serialization** | `serde` + `serde_json` |

Feature-gated compilation: `network`, `proxy`, `otel`, `gh-events`, `slack`, `r2-sync` — only compile what you need.

### 4.3. The Cloud Platform (Cloudflare Stack)

Fully built on Cloudflare for simplicity, global edge performance, and zero egress fees from R2.

| Layer | Cloudflare Service | Role |
|-------|-------------------|------|
| **Object Storage** | R2 | Parquet files for traces, traffic, events, evals, capacity data. Zero egress. S3-compatible API. |
| **Relational DB** | D1 (SQLite at edge) | Users, teams, workspaces, projects, permissions, issue metadata |
| **API** | Workers | Serverless API for dashboard, webhooks, issue tracker sync |
| **Frontend** | Pages | Dashboard SPA for team visibility, project planning, evals |
| **Auth** | Access / Zero Trust | SSO, team-based access control |
| **Cron / Triggers** | Workers Cron | Periodic aggregation, forecast recalculation, stale issue detection |
| **Notifications** | Workers + Queues | Alert delivery (Slack, email) for budget breaches, risk signals |

### 4.4. R2 Sync Engine (Local → Cloud)

The sync engine is the bridge between local-first DuckDB and the Cloudflare cloud layer. Design principles: **offline-first, eventually consistent, conflict-free, minimal bandwidth**.

#### How it works

```
1. Local writes happen to DuckDB (zero latency, always available)

2. Sync daemon batches new rows into Parquet files (every N minutes or N rows):
   DuckDB → COPY TO '*.parquet' → upload to R2

3. Each device writes to its own partition:
   r2://gctl-data/{workspace_id}/{device_id}/traces/2026-03-22T14:00.parquet

4. Manifest file tracks sync state:
   r2://gctl-data/_manifests/{device_id}.json
   {
     "device_id": "alice-macbook",
     "last_sync": "2026-03-22T14:05:00Z",
     "tables": {
       "traces": { "last_row_id": 4821, "last_file": "..." },
       "traffic": { "last_row_id": 12044, "last_file": "..." }
     }
   }

5. Cloud Workers read Parquet directly from R2 for queries
   (or materialize into D1 for relational joins)
```

#### Sync modes

| Mode | Trigger | Use Case |
|------|---------|----------|
| **Periodic** | Every 5 min (configurable) | Default background sync |
| **On-session-end** | Agent session completes | Ensure completed work is synced promptly |
| **Manual** | `gctl sync push` | Developer forces immediate sync |
| **Pull** | `gctl sync pull` | Pull team data from R2 into local DuckDB for offline queries |

#### Conflict resolution

No conflicts by design — each device writes to its own R2 prefix. The cloud layer merges by reading all device partitions. This is an **append-only, partition-per-device** model:

```
r2://gctl-data/workspace-123/
  ├── alice-macbook/
  │   ├── traces/2026-03-22T10:00.parquet
  │   ├── traces/2026-03-22T14:00.parquet
  │   └── traffic/2026-03-22T10:00.parquet
  ├── bob-desktop/
  │   ├── traces/2026-03-22T11:00.parquet
  │   └── traffic/2026-03-22T11:00.parquet
  └── claude-bot-1/   ← autonomous agents are devices too
      └── traces/2026-03-22T09:00.parquet
```

#### Why R2?

* **Zero egress fees** — Dashboard reads from R2 are free. Critical when multiple team members query frequently.
* **S3-compatible API** — Rust crates (`aws-sdk-s3`, `rust-s3`) work out of the box. No custom SDK needed.
* **Global edge** — R2 is distributed across Cloudflare's network. Low latency for globally distributed teams.
* **Parquet native** — Columnar format means Workers can read only the columns needed (e.g., cost data without full prompt text).
* **Cloudflare ecosystem** — Tight integration with Workers, D1, Pages. No cross-cloud data transfer.
* **Cost** — R2 storage is $0.015/GB/month with no egress. A team of 10 developers generating ~100MB/day of traces = ~$0.45/month.

#### Data lifecycle

```
gctl sync status
┌─────────────┬──────────┬────────────┬────────────┐
│ Table       │ Local    │ Synced     │ Pending    │
├─────────────┼──────────┼────────────┼────────────┤
│ traces      │ 4,821    │ 4,500      │ 321 rows   │
│ traffic     │ 12,044   │ 12,044     │ 0 rows     │
│ events      │ 892      │ 890        │ 2 rows     │
│ evals       │ 47       │ 47         │ 0 rows     │
└─────────────┴──────────┴────────────┴────────────┘
Last sync: 3 min ago │ Next: 2 min │ R2 bucket: gctl-data
```

* **Local retention:** Configurable TTL (default 30 days). Old data pruned from DuckDB after sync confirmed.
* **R2 retention:** Configurable per workspace (default 90 days). Lifecycle rules auto-delete old Parquet files.
* **Compaction:** Workers cron job periodically merges small Parquet files per workspace into larger ones (reduces R2 read overhead).

### 4.5. R2 as Dual-Purpose Store: Analytics + Agent Knowledge

R2 is not just for analytics Parquet files — it is equally suited as the backing store for **agent-consumable markdown content**. The `gctl net crawl` and `gctl net fetch` features already convert web content to markdown locally. R2 unifies both workloads in one bucket, serving two fundamentally different access patterns from one storage layer.

#### The two data planes

```
r2://gctl-data/{workspace}/
  │
  ├── analytics/                    ← PARQUET (columnar, append-only)
  │   ├── {device}/traces/*.parquet
  │   ├── {device}/traffic/*.parquet
  │   ├── {device}/events/*.parquet
  │   ├── {device}/evals/*.parquet
  │   └── {device}/capacity/*.parquet
  │
  └── knowledge/                    ← MARKDOWN (document, mutable)
      ├── crawls/
      │   ├── docs.anthropic.com/
      │   │   ├── _index.json         ← site manifest (pages, last crawl, staleness)
      │   │   ├── getting-started.md
      │   │   ├── tool-use.md
      │   │   └── agents.md
      │   ├── docs.cloudflare.com/
      │   │   ├── _index.json
      │   │   ├── r2/overview.md
      │   │   └── workers/api.md
      │   └── internal-wiki/
      │       ├── _index.json
      │       └── onboarding.md
      ├── context/
      │   ├── CLAUDE.md               ← shared team prompt configs
      │   ├── runbooks/deploy.md      ← operational runbooks
      │   └── architecture.md         ← system design docs
      └── snapshots/
          ├── issues-2026-03-22.md    ← periodic issue tracker snapshots
          └── prs-open-2026-03-22.md  ← open PR summaries
```

#### Why R2 works for both

| Dimension | Analytics (Parquet) | Agent Knowledge (Markdown) | R2 Fit |
|-----------|-------------------|--------------------------|--------|
| **Access pattern** | Scan columns across many rows | Fetch single documents by path | R2 handles both — columnar reads via byte-range requests, doc reads via simple GET |
| **Write pattern** | Append-only, batched | Overwrite on re-crawl, occasional updates | R2 supports both PUT (overwrite) and multipart upload (large batch) |
| **Read frequency** | Dashboard queries (periodic) | Agent context loading (per-session) | Zero egress means neither pattern costs more at scale |
| **Size per object** | 1-50 MB (batched Parquet) | 1-500 KB (single markdown page) | R2 has no minimum object size penalty unlike S3 IA/Glacier |
| **Concurrency** | Multiple dashboards reading | Multiple agents reading same docs | R2 is eventually consistent, fine for both (agents don't need strong consistency on docs) |
| **Caching** | Workers cache hot Parquet ranges | Workers/CDN cache hot markdown | Cloudflare CDN in front of R2 — automatic edge caching for frequently-read docs |
| **Versioning** | Immutable Parquet files (timestamp-partitioned) | Mutable markdown (overwrite on re-crawl) | R2 supports object versioning — enable for knowledge/ prefix to track doc changes over time |

#### Agent knowledge workflow

```
1. Developer crawls docs locally:
   gctl net crawl https://docs.anthropic.com --depth 3

2. Markdown stored locally:
   ~/.local/share/gctl/spider/docs.anthropic.com/*.md

3. Sync to R2 for team-wide access:
   gctl sync push --include knowledge
   → uploads to r2://gctl-data/{workspace}/knowledge/crawls/docs.anthropic.com/

4. Any team member's agent can pull:
   gctl sync pull --include knowledge
   → downloads to local spider cache

5. Agents consume markdown as context:
   gctl net compact docs.anthropic.com
   → concatenates into single LLM-ready document (gitingest-style)
```

#### Shared agent context via R2

The `knowledge/context/` prefix stores team-wide agent configuration — shared CLAUDE.md files, runbooks, architecture docs — that every developer's agent should have access to:

```
gctl context push ./CLAUDE.md
  → r2://gctl-data/{workspace}/knowledge/context/CLAUDE.md

gctl context push ./docs/deploy-runbook.md --as runbooks/deploy.md
  → r2://gctl-data/{workspace}/knowledge/context/runbooks/deploy.md

gctl context pull
  → downloads all team context to ~/.local/share/gctl/context/
```

This means a new team member's agent immediately has access to:
- Crawled documentation for all libraries the team uses
- Shared prompt configs and CLAUDE.md conventions
- Operational runbooks for deploy, incident response, etc.
- Architecture docs that inform agent decision-making

#### Issue/PR snapshots for agent context

The capacity engine (Pillar 4) periodically snapshots issue tracker and PR state as markdown, synced to R2:

```
gctl project snapshot --format markdown
  → knowledge/snapshots/issues-2026-03-22.md
  → knowledge/snapshots/prs-open-2026-03-22.md
```

Agents can load these snapshots as context to understand:
- What issues are in flight and who's working on them
- What PRs need review and their current status
- What the team is focused on this sprint

This bridges the gap between project management tools (Linear, GitHub Issues) and agent context windows — agents don't need API access to issue trackers, they just read markdown snapshots from R2.

#### Why not separate stores?

| Alternative | Problem |
|-------------|---------|
| **S3 for Parquet + R2 for markdown** | Cross-cloud egress costs. Two billing accounts. Two auth systems. |
| **R2 for Parquet + D1 for markdown** | D1 has a 10MB row limit and isn't designed for document storage. Markdown files vary wildly in size. |
| **R2 for Parquet + KV for markdown** | KV has a 25MB value limit (fine for markdown) but no prefix listing, no versioning, no lifecycle rules. Can't browse a crawled site's directory structure. |
| **Separate R2 buckets** | Unnecessary operational overhead. One bucket with prefix-based separation (`analytics/` vs `knowledge/`) is simpler, and Workers can apply different caching/access rules per prefix. |

**One R2 bucket, two prefixes, two data planes.** Analytics is Parquet, append-only, device-partitioned. Knowledge is markdown, mutable, domain-organized. Both benefit from zero egress, S3 compatibility, and Cloudflare edge caching. The simplicity of a single storage layer that serves both structured analytics and unstructured agent context is the architectural win.

#### Cost model (combined)

```
Analytics:  10 devs × 100MB/day × 30 days = 30 GB     → $0.45/month
Knowledge:  50 crawled sites × 5MB avg    = 250 MB     → $0.004/month
Context:    shared docs + snapshots        = ~50 MB     → $0.001/month
                                                 Total: ~$0.46/month

Compare: S3 equivalent with egress for dashboard reads = $5-15/month
```

## 5. Pillar 1: Guardrails

### 5.1. Permission Enforcement

Agents operate within an **allowlist model**. GroundCtrl enforces what commands an agent can execute:

```json
// .claude/settings.local.json — already implemented
{
  "permissions": {
    "allow": [
      "Bash(./target/release/gctl:*)",
      "Bash(git commit:*)",
      "Bash(cargo build:*)"
    ]
  }
}
```

All DevOps operations must go through `gctl` — this is the enforcement boundary. An agent cannot `gh pr merge` directly; it must use `gctl gh pr merge`, which can apply additional policy checks.

### 5.2. Network Control (MITM Proxy)

The proxy (`gctl net proxy`) provides network-level guardrails:

* **Domain Allowlisting** — Restrict which external APIs/hosts agents can reach.
* **Request Logging** — Every HTTP request logged with method, URL, status, size, duration to `traffic.jsonl`.
* **Rate Limiting** — Throttle requests to prevent runaway agents from hammering APIs.
* **Traffic Analytics** — `gctl net stats/daily/analytics` to audit all network activity.

### 5.3. Cost Limits & Circuit Breakers

* **Session Budget** — Halt agent execution if a session exceeds a configurable token/dollar threshold (e.g., "Pause if session > $5.00").
* **Loop Detection** — Flag when an agent calls the same file/command repeatedly without progress (Error Loop Frequency metric).
* **Diff Size Gate** — Alert or pause if an agent produces an unusually large diff (potential runaway refactor).

### 5.4. Git Safety

* **Branch Protection** — Enforce feature branches; block direct pushes to main/master.
* **Force Push Prevention** — Block `--force` pushes through the CLI layer.
* **Diff Capture** — Snapshot git state before/after agent execution for rollback capability.

### 5.5. Agent Data Access Layer (`gctl query`)

Claude Code and other agents **cannot read DuckDB binary files** via their built-in file reading tools. The Read tool only handles text/image formats. This means the local DuckDB — full of traces, traffic logs, eval results, project data — is invisible to agents unless GroundCtrl explicitly exposes it.

This is a design constraint that becomes a **feature**: GroundCtrl controls what data agents can see, how much of it, and in what format. The agent never gets raw database access — it gets curated, guardrailed query results.

#### `gctl query` — general-purpose agent data interface

```
gctl query <domain> <question-or-sql> [--format table|json|markdown|csv]
                                       [--limit 100]
                                       [--output .tmp/result.md]
```

Three access modes, from safest to most powerful:

**1. Pre-built queries (existing)** — Named commands with fixed schemas:
```
gctl otel sessions                     → list recent agent sessions
gctl otel analytics                    → p50/p95 latency, cost/model
gctl capacity status --team backend    → workload overview
gctl project health --milestone v2.0   → risk dashboard
gctl net stats                         → traffic summary
```
These are the primary interface. Safe, fast, output designed for agent consumption.

**2. Natural language queries (planned)** — Agent describes what it wants, GroundCtrl translates to SQL:
```
gctl query traces "sessions where cost > $2 in the last 7 days"
gctl query capacity "which developer closed the most issues last week"
gctl query traffic "top 10 domains by request count today"
```
GroundCtrl validates the generated SQL against a read-only allowlist of tables/columns before execution. Prevents agents from reading sensitive columns (e.g., raw prompt text) unless explicitly permitted.

**3. Raw SQL (opt-in, power users)** — Direct DuckDB SQL, gated behind a config flag:
```
gctl query sql "SELECT agent_name, SUM(cost_usd) FROM spans
                WHERE created_at > now() - INTERVAL '7 days'
                GROUP BY agent_name ORDER BY 2 DESC"
  --format markdown --output .tmp/agent-costs.md
```
Disabled by default. Enabled via `config.toml`:
```toml
[query]
allow_raw_sql = true          # default: false
max_rows = 1000               # prevent unbounded result sets
blocked_columns = ["raw_prompt", "raw_response"]  # redact sensitive data
read_only = true              # always — no writes via query interface
```

#### Output for agent consumption

The `--output` flag writes results to a file that Claude Code can then read with the Read tool:

```
# Agent workflow:
# 1. Bash: gctl query traces "failed sessions today" --format markdown --output .tmp/failed-sessions.md
# 2. Read: .tmp/failed-sessions.md
# 3. Agent now has structured data in its context window
```

The `--format markdown` mode is optimized for LLM consumption — tables with headers, not raw JSON. The `--format json` mode is available for structured parsing.

#### Why not just install the `duckdb` CLI?

| Approach | Problem |
|----------|---------|
| **`duckdb` CLI directly** | No guardrails. Agent can read raw prompts, responses, secrets. No query limits. No audit log. Requires separate install. |
| **MCP server for DuckDB** | Heavy setup. Requires running a persistent server. Another process to manage. |
| **Export to CSV/JSON then Read** | Manual, slow. No caching. Agent must know DuckDB schema to request the right export. |
| **`gctl query` (this approach)** | Guardrailed. Column-level redaction. Read-only. Audit logged. Output formatted for agents. Installed with GroundCtrl. Zero config for safe mode. |

#### Agent self-awareness

This query layer enables a powerful pattern: **agents that understand their own performance**.

```
# An agent checking its own cost before continuing:
gctl query traces "my current session cost"
→ Session sess-4821: $1.87 (14.2k tokens, 23 tool calls)

# An agent learning from past failures on similar tasks:
gctl query evals "failed runs on tasks tagged 'auth'" --limit 5 --format markdown
→ Table of 5 failed sessions with failure reasons

# An agent checking if it's in a loop:
gctl query traces "repeated tool calls in current session"
→ WARNING: read_file called 8 times on src/auth.rs in last 5 minutes
```

Combined with guardrails (Section 5.3), this creates a feedback loop: the agent can detect it's stuck or expensive and adjust its approach — or the guardrail engine can halt it.

#### R2 knowledge access via query

The query interface also bridges to the R2 knowledge layer (Section 4.5):

```
# List available crawled documentation:
gctl query knowledge "list crawled sites"
→ docs.anthropic.com (142 pages, crawled 2026-03-20)
→ docs.cloudflare.com (89 pages, crawled 2026-03-21)

# Search across crawled docs:
gctl query knowledge "cloudflare r2 lifecycle rules"
→ Matches in: docs.cloudflare.com/r2/buckets/object-lifecycles.md (lines 12-34)

# Load a specific doc into context:
gctl net compact docs.anthropic.com/tool-use --output .tmp/tool-use.md
```

The local spider cache and R2-synced knowledge are both searchable through the same interface. If a doc is cached locally, it reads from disk. If not, it pulls from R2.

## 6. Pillar 2: Unified DevOps CLI

All agent-initiated infrastructure operations go through GroundCtrl's plugin system:

```
gctl<plugin> <command> [args/flags]
  ├── gh         GitHub: issues, PRs, runs, dispatch, repos
  ├── aws        AWS: status, CloudWatch logs, ECS services/tasks/deploys
  ├── pulumi     IaC: stack status, preview, outputs
  ├── signoz     Observability: alerts, services, traces, logs
  ├── slack      Notifications: send Block Kit messages
  ├── net        Network: crawl, fetch, proxy, traffic analytics
  ├── otel       Telemetry: OTLP receiver, trace/span queries
  ├── gh-events  GitHub event streaming & analytics
  ├── eval       Evals: define suites, run benchmarks, compare configs
  ├── capacity   Capacity: throughput, forecasts, workload balance
  ├── project    Project: issue sync, milestone tracking, risk alerts
  └── query      Data: agent-safe DuckDB queries, knowledge search
```

### Why route everything through GroundCtrl?

1. **Single audit log** — Every operation is recorded, attributable to an agent + session.
2. **Caching** — TTL-based response cache (120s reads, 30s CI checks) with auto-invalidation after writes. Prevents agents from hammering APIs.
3. **Consistent interface** — Agents don't need to know the quirks of `gh` vs `aws` vs `pulumi` CLIs.
4. **Policy enforcement** — The CLI layer can check permissions, budgets, and policies before executing.
5. **Offline resilience** — Cached data available when network is unreliable.

## 7. Pillar 3: Observe & Eval

### 7.1. Telemetry & Trace Capture

* **OTLP Receiver** — `gctl otel` accepts OpenTelemetry spans over HTTP (port 4318).
* **Data Captured per Span:** trace_id, session_id, agent_name, model, input/output tokens, cost (USD), tool calls, execution results, status, duration.
* **Storage:** DuckDB with full span hierarchy. Queryable via `gctl otel sessions/traces/spans/analytics`.
* **Langfuse-inspired schema:** Session → Trace → Span model, with cost attribution at every level.

### 7.2. Token & Cost Analytics

* Aggregated spend per developer, per team, per repository, per agent, per model.
* `gctl otel analytics` — p50/p95/p99 latencies, cost per agent/model/project.
* Alerting thresholds tied to guardrails (Section 5.3).

### 7.3. Context Indexing

* Link traces to git diffs — capture file changes produced during a specific trace span.
* Index terminal output (errors/warnings) that prompted agent actions.
* Semantic search over trace context (e.g., "Find the trace where Claude updated the auth middleware").

### 7.4. Evals & Prompt Analytics (For Developers)

Unlike Langfuse/Braintrust which evaluate production chatbot quality, GroundCtrl evaluates **developer agent effectiveness**. Inspired by [OpenAI Agents SDK evals](https://developers.openai.com/cookbook/examples/agents_sdk/evaluate_agents) but adapted for coding agents.

#### What we evaluate

| Metric | What it measures | How |
|--------|-----------------|-----|
| **Task Completion Rate** | Did the agent actually solve the issue? | Compare agent output against expected state (test pass, lint clean, issue closed) |
| **Code Acceptance Rate** | % of agent-generated code that gets committed vs. reverted | Track diffs through git history post-session |
| **Cost Efficiency** | Tokens/dollars spent per successful task | Correlate cost spans with completion outcomes |
| **Tool Call Accuracy** | Did the agent call the right tools in the right order? | Score tool call sequences against known-good patterns |
| **Error Loop Frequency** | How often the agent retries the same failing approach | Detect repeated identical tool calls within a span |
| **Time-to-Resolution** | Wall clock time from issue assignment to PR merge | Correlate GitHub events with trace timestamps |
| **Prompt Effectiveness** | Which system prompts / CLAUDE.md configs yield better outcomes | A/B compare sessions with different prompt configurations |

#### Eval workflow

```
1. Define eval suite:
   gctl eval create --name "auth-refactor" \
     --criteria "tests pass" "no lint errors" "PR approved"

2. Run agent with eval tracking:
   gctl eval run --suite "auth-refactor" --agent "claude-code" \
     --prompt-config ./claude-md-v2.md

3. Agent executes normally (traces captured via OTel)

4. Eval engine scores the session:
   gctl eval results --suite "auth-refactor"
   ┌────────────┬──────────┬───────┬──────────┬────────┐
   │ Run        │ Agent    │ Score │ Cost     │ Time   │
   ├────────────┼──────────┼───────┼──────────┼────────┤
   │ run-001    │ claude   │ 3/3   │ $1.24    │ 4m 12s │
   │ run-002    │ aider    │ 2/3   │ $0.87    │ 6m 30s │
   └────────────┴──────────┴───────┴──────────┴────────┘

5. Compare prompt configs:
   gctl eval compare --suite "auth-refactor" \
     --config-a ./claude-md-v1.md --config-b ./claude-md-v2.md
```

#### Prompt analytics

* **Prompt versioning** — Track which CLAUDE.md / system prompt was active during each session. Hash + store prompt content alongside traces.
* **A/B comparison** — Compare agent performance across prompt configs: cost, completion rate, tool call patterns, error loops.
* **Prompt drift detection** — Alert when a prompt config change correlates with degraded agent performance.
* **Token budget analysis** — Which parts of the prompt consume the most context? Are there sections that never influence tool calls?

#### Dataset generation (from real sessions)

```
gctl eval dataset create --from-sessions "last 7 days" \
  --filter "completed=true" --output ./evals/dataset.jsonl
```

Convert real agent sessions into replayable eval datasets — ground truth from actual developer workflows, not synthetic benchmarks.

### 7.5. GitHub Integration

* **PR Enrichment** — GitHub App auto-comments on PRs with agent summary (tokens, cost, trace link, eval score).
* **Session Sharing** — Secure shareable links to agent traces for team review.
* **Event Capture** — Webhook listener + polling for GitHub events, stored in DuckDB for correlation with agent traces.

## 8. Pillar 4: Developer Capacity

Traditional capacity planning treats developers as interchangeable units with gut-feel velocity estimates. In an AI-augmented world, the unit of work is a **developer+agent pair**, and GroundCtrl has the execution data to measure actual capacity — not estimate it.

### 8.1. Throughput Measurement

GroundCtrl correlates three data sources to produce real throughput metrics:

```
GitHub Events (issues, PRs, reviews)
        +
OTel Traces (agent sessions, tool calls, cost)
        +
Git History (commits, diffs, file churn)
        =
Measured Throughput per Developer+Agent Pair
```

| Metric | Definition | Source |
|--------|-----------|--------|
| **Issues Closed / Week** | Completed work items per developer | GitHub Events |
| **Agent-Assisted %** | Fraction of closed issues that had agent sessions | OTel + GH correlation |
| **Effective Cost per Issue** | Total tokens + compute + developer time per issue | OTel cost + GH timestamps |
| **Code Churn Rate** | % of agent-generated lines modified within 7 days | Git diff tracking |
| **Review Turnaround** | Time from PR open to first review | GH Events |
| **Cycle Time** | Issue created → PR merged | GH Events + OTel |
| **Agent Leverage Ratio** | Lines shipped per $ spent on agent tokens | OTel + Git |

### 8.2. Workload Modeling

```
gctl capacity status --team "backend"
┌──────────────┬────────┬───────────┬──────────┬────────────────┐
│ Developer    │ Active │ In Review │ Blocked  │ Agent Sessions │
├──────────────┼────────┼───────────┼──────────┼────────────────┤
│ alice        │ 3      │ 1         │ 0        │ 12 today       │
│ bob          │ 2      │ 3         │ 1        │ 4 today        │
│ carol        │ 1      │ 0         │ 0        │ 8 today        │
│ ── agents ── │        │           │          │                │
│ claude-bot-1 │ 1      │ 2         │ 0        │ autonomous     │
│ claude-bot-2 │ 0      │ 1         │ 0        │ autonomous     │
└──────────────┴────────┴───────────┴──────────┴────────────────┘

Utilization: 78% │ Bottleneck: review queue (4 PRs > 24h)
```

Key capabilities:
* **WIP Limits** — Alert when a developer has too many concurrent issues (context-switching tax).
* **Review Queue Health** — Surface PRs waiting > N hours for review. Identify review bottlenecks.
* **Blocked Work Detection** — Cross-reference issue labels/status with agent activity. Flag issues where no agent sessions have occurred in > 48h.
* **Autonomous Agent Tracking** — Treat headless agents (running in CI or on dedicated machines) as capacity units alongside human developers.

### 8.3. Forecasting & Burndown

```
gctl capacity forecast --milestone "v2.0" --team "backend"

Milestone: v2.0 (due: 2026-04-15)
  Total issues: 24 │ Closed: 14 │ Remaining: 10

  Measured throughput (last 14 days):
    Team: 4.2 issues/week (human+agent)
    Range: 3.1 – 5.8 (p20–p80)

  Forecast:
    Optimistic (p80):  2026-03-28  ✓ on track
    Expected (p50):    2026-04-02  ✓ on track
    Pessimistic (p20): 2026-04-11  ⚠ tight

  Risk factors:
    - 3 issues have no agent sessions yet (cold start)
    - Review queue averaging 18h (slowing cycle time)
    - Bob at 100% utilization (no slack for surprises)
```

* **Data-driven estimates** — Forecasts based on measured throughput, not story points.
* **Confidence intervals** — Show range, not a single date. Based on variance in recent throughput.
* **Risk surfacing** — Automatically flag issues that haven't been started, reviewers who are bottlenecks, developers at capacity.
* **Agent scaling scenarios** — "What if we add 2 more autonomous agents to this milestone?"

### 8.4. Developer Effectiveness Profiles

Per-developer analytics (opt-in, privacy-respecting):

* **Peak Productivity Windows** — When does this developer+agent pair produce the most accepted code? (Helps with meeting scheduling, focus time.)
* **Agent Adoption Curve** — Track how a developer's agent usage evolves over time. Are they delegating more? Are acceptance rates improving?
* **Skill-Task Matching** — Which types of issues (bug fix, feature, refactor, docs) does this developer+agent pair handle most efficiently?
* **Context Switch Cost** — Measured drop in throughput when working on > N concurrent issues.

## 9. Pillar 5: Project Intelligence

Project intelligence connects issue trackers to execution telemetry, turning project management from status-update theater into measured reality.

### 9.1. Issue Tracker Integration

```
gctl project sync --source linear --project "BACKEND"
gctl project sync --source github --repo "org/api-server"
gctl project sync --source notion --database "Sprint Board"
```

Bidirectional sync:
* **Ingest** — Pull issues, milestones, labels, assignments, status changes into DuckDB.
* **Enrich** — Write back agent summaries, cost data, eval scores to issue comments/fields.
* **Correlate** — Link every issue to its agent sessions, traces, PRs, and diffs.

### 9.2. Issue-to-Execution Mapping

Every issue gets an execution profile:

```
gctl project issue view BACKEND-142

Issue: BACKEND-142 "Add rate limiting to /api/users"
Status: In Review │ Assignee: alice │ Priority: High

Execution:
  Sessions: 3 (2 by alice+claude, 1 by autonomous-bot)
  Total cost: $2.47 (18.4k tokens)
  Time invested: 1h 24m (agent), ~45m (human review)
  PRs: #891 (open, 2 approvals, CI passing)

  Session timeline:
    03-18 14:22  alice+claude  45m  $1.12  initial implementation
    03-18 16:05  alice+claude  22m  $0.87  address review feedback
    03-19 09:00  auto-bot      17m  $0.48  fix flaky test

Eval: 3/3 criteria met (tests pass, lint clean, <p95 latency)
```

### 9.3. Estimation Calibration

GroundCtrl builds a historical model of how long different types of work actually take:

```
gctl project estimates --team "backend" --last "90 days"

Issue Type      │ Estimated │ Actual (p50) │ Actual (p80) │ Accuracy
────────────────┼───────────┼──────────────┼──────────────┼──────────
Bug fix         │ 2h        │ 1.1h         │ 2.8h         │ ±45%
Feature (S)     │ 4h        │ 2.3h         │ 5.1h         │ ±38%
Feature (M)     │ 2d        │ 1.4d         │ 3.2d         │ ±52%
Refactor        │ 1d        │ 0.6d         │ 1.8d         │ ±41%
Docs            │ 1h        │ 0.3h         │ 0.8h         │ ±62%

Insight: Agent-assisted estimates are 40% more accurate than
         pre-agent baselines. Docs tasks are over-estimated 3x
         (agents handle them efficiently).

Recommendation: Reduce doc estimates to 30m. Increase Feature (M)
                buffer — high variance suggests hidden complexity.
```

* **Automatic sizing** — Suggest issue size based on similar completed work.
* **Agent impact factor** — How much does agent assistance reduce actual time for each category?
* **Estimation drift** — Alert when estimates are consistently off by > 50%.

### 9.4. Risk & Health Dashboard

```
gctl project health --milestone "v2.0"

🟢 On Track    │ 14/24 issues closed
⚠️  Risks:
  - BACKEND-155: assigned 5 days ago, no agent sessions (stalled?)
  - BACKEND-160: 4 agent sessions, all failed eval (complexity?)
  - Review bottleneck: 6 PRs waiting > 24h (carol is sole reviewer)
  - Cost trending 30% above budget ($142 of $200 spent, 58% done)

📊 Velocity trend:
  Week -2: 5.0 issues/week
  Week -1: 3.8 issues/week  ← drop after alice OOO
  This week: 4.1 issues/week (projected)
```

* **Stale Issue Detection** — Issues assigned but with no agent sessions or commits.
* **Complexity Signals** — Issues with multiple failed eval runs or high error loop frequency.
* **Reviewer Load Balancing** — Identify when review work is concentrated on too few people.
* **Budget Tracking** — Total agent token cost against milestone budget.
* **Velocity Anomalies** — Automatic detection of throughput drops with likely causes.

### 9.5. Sprint Planning Assistance

```
gctl project plan-sprint --team "backend" --capacity "3 devs + 2 agents" \
  --duration "2 weeks"

Available capacity: ~12.6 issues (based on measured throughput)

Recommended sprint (priority-ordered, fits capacity):
  ✓ BACKEND-170  [High]   Add webhook retry     ~0.8 issues
  ✓ BACKEND-171  [High]   Fix auth token leak    ~0.5 issues
  ✓ BACKEND-172  [High]   Rate limit dashboard   ~1.2 issues
  ✓ BACKEND-165  [Med]    Migrate to v2 schema   ~2.1 issues
  ✓ BACKEND-168  [Med]    Add audit logging       ~1.0 issues
  ✓ BACKEND-173  [Low]    Update API docs         ~0.3 issues
  ── buffer ──                                     ~6.7 issues slack

  Estimated cost: $89 (tokens) + 42h (human time)

  ⚠ BACKEND-165 has high variance — consider splitting or
    assigning to developer with schema migration experience.
```

* **Capacity-aware planning** — Recommends sprint scope based on measured team throughput, not guesses.
* **Agent-assignable detection** — Flag issues that are good candidates for autonomous agent execution (low complexity, clear acceptance criteria, good test coverage).
* **Dependency awareness** — Surface blocked/blocking relationships between issues.
* **Buffer recommendation** — Suggest slack based on historical variance.

## 10. Data Model

### Execution Layer
* **`Workspace`**: Top-level billing and team entity.
* **`User`**: Developer running the agent.
* **`Project`**: Maps to a GitHub Repository.
* **`Session`**: Continuous block of agent work (e.g., "Implement login page").
* **`Trace`**: Individual back-and-forth interaction within a Session.
* **`Span`**: Granular unit within a Trace (tool call, LLM request, etc.).
* **`Diff`**: Code changes associated with a specific Trace.
* **`TrafficRecord`**: HTTP request/response metadata from the MITM proxy.

### Eval Layer
* **`EvalSuite`**: Named collection of evaluation criteria.
* **`EvalRun`**: A scored agent session against an EvalSuite.
* **`PromptConfig`**: Versioned snapshot of system prompt / CLAUDE.md content.

### Capacity & Project Layer
* **`Team`**: Group of developers + agents with shared capacity.
* **`Issue`**: Synced from Linear/GitHub/Notion. Enriched with execution data.
* **`Milestone`**: Collection of issues with a target date and budget.
* **`Sprint`**: Time-boxed work period with planned issues and measured throughput.
* **`CapacitySnapshot`**: Point-in-time measurement of team throughput, utilization, and queue depth.
* **`EstimateModel`**: Historical calibration data for issue type → actual effort mapping.
* **`ExecutionProfile`**: Per-issue aggregation of sessions, cost, time, eval scores, and PRs.

## 11. Security & Privacy

* **PII/Secret Redaction:** The daemon MUST scrub API keys, passwords, and `.env` variables before syncing trace data to the cloud.
* **Opt-in Cloud Sync:** Developers can flag sessions as "Local Only" for sensitive work.
* **Data Retention:** Configurable TTL for trace data (e.g., 30 days).
* **Proxy CA Isolation:** MITM proxy CA cert is per-machine, never shared.
* **Capacity Data Privacy:** Individual developer metrics are visible only to the developer by default. Team-level aggregates available to managers. Org-level aggregates to leadership. No individual productivity rankings.

## 12. Agent Integration

### 12.1. Claude Code

* **Hooks** — Pre/post tool execution hooks push span events to the daemon.
* **Permission Allowlists** — `settings.local.json` restricts all DevOps to `gctl` commands.
* **Cost Attribution** — Proxy captures every Anthropic API call with token counts.
* **Git Context** — File system watcher captures diffs during sessions.
* **Issue Context** — Agent sessions auto-tagged with issue ID from branch name or commit message.

### 12.2. Open Code (Open-Source Agents)

* **Agent-Agnostic Proxy** — Any agent can be traced by routing traffic through `localhost:8080`. Zero code changes.
* **OTel SDK** — Agents in any language can emit OTLP spans directly to `gctl otel`.
* **Standardized Semantic Conventions** — `ai.tool.name`, `ai.model.id`, `ai.tokens.input` — any agent emitting these is first-class.
* **Eval Compatibility** — Same eval suites work across agents, enabling head-to-head comparison.
* **Capacity Integration** — Autonomous agents register as capacity units, their throughput measured the same way as human+agent pairs.

### 12.3. Key Insight

GroundCtrl operates at the **protocol level** (HTTP proxy + OTLP + CLI gateway), not the agent level. This means it works with any agent that speaks HTTP or emits OTel spans — today and in the future. The guardrails, telemetry, evals, and capacity planning are orthogonal to the agent implementation.

The unique value proposition: **GroundCtrl is the only tool that connects what was planned (issues) → what was executed (agent traces) → what was delivered (PRs/commits) → what it cost (tokens/$) in a single data pipeline.** No other tool in the market stitches these layers together for developer+agent teams.

