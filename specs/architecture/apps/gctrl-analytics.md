# Application: gctrl-analytics (Usage, OTel & Network Dashboard)

gctrl-analytics is the **observability web application** for gctrl — a unified dashboard for all past and live agent-spawn sessions, usage, OTel traces, cost/latency analytics, and network traffic routed through the kernel proxy. It visualizes activity from both **internal agents** (scheduled/spawned by us through the kernel) and **external agents** (Claude Code, Codex, ad-hoc scripts, humans) that push telemetry through the OTel receiver or route traffic through the kernel proxy.

It is the second native application after `gctrl-board`, and the primary place humans go to ask "what has been happening on this machine / in this workspace?".

## Architectural Position

gctrl-analytics is a **native application** in the Unix layer model — same position as `gctrl-board`.

```
App (gctrl-analytics) → Kernel HTTP API (:4318) → Kernel (storage, otel, proxy, scheduler)
```

- **Depends on the kernel** — reads data via HTTP API only. MUST NOT access DuckDB directly or import kernel crates.
- **Never depended on by the shell or kernel** — removing the app breaks nothing below it.
- **Has its own web server** — Cloudflare Worker facade serving a React SPA, separate port from kernel `:4318`. Mirrors `gctrl-board`'s deployment shape.
- **Shell command surface**: `gctrl analytics ...` commands already exist in `shell/gctl-shell/src/commands/analytics.ts` and cover the CLI surface. This app is **UI-only** — it does not add new shell commands.

See [os.md — Dependency Direction](../os.md).

## Scope

### In scope

1. **Sessions** — all past and live agent-spawn sessions (internal + external), with live status, trace tree, cost, linked issue, and an Activity view mode (list / timeline / heatmap).
2. **Prompts** — what agents are being asked, which prompt templates recur, and how they perform (cost, eval score, failure modes).
3. **Evals** — score trends, alert rule status, pass/fail by agent/model — the regression-monitoring surface.
4. **Usage** — provider spend (Anthropic, OpenAI, …), tool/util usage (Claude Code, Codex, …), proxied network traffic (requires kernel `proxy` Phase 2), and performance percentiles in one combined "where are resources going?" tab.
5. **Contributions** — commits, PRs, and issues closed by agents, joined back to the originating session.
6. **Agent attribution** — distinguish **internal** (scheduled via kernel Scheduler / spawned by our apps) vs **external** (pushed OTel from outside, e.g. a developer running `claude` locally against the OTel receiver) across all surfaces above.

### Out of scope

- Issue/task tracking — owned by `gctrl-board`.
- Agent evaluation / scoring UI — covered by `gctrl-eval` (planned).
- Write operations against sessions/spans — read-only app. Scoring and tagging stay in the shell.
- Multi-tenant billing or access control — single-operator assumption (same as rest of gctrl).

## Reuse vs. New

| Need | Reuse existing | New work required |
|------|----------------|-------------------|
| Usage overview, cost, latency, spans, scores, daily, alerts | `GET /api/analytics/*` | — |
| Session list, detail, spans, trace tree, cost breakdown, loops | `GET /api/sessions/*` | — |
| Activity view (timeline / heatmap) | `GET /api/sessions` (time-bucketed client-side) | — |
| Prompts tab (instance list, grouping) | Span query by span-type | Light route: `GET /api/sessions/{id}/prompts` + `GET /api/prompts?group_by=fingerprint` |
| Network traffic (domains, bytes, status) | — | Kernel `proxy` Phase 2 + `GET /api/net/*` routes |
| Contributions tab | `driver-github` PR/commit data | `session.contribution_links` table + `GET /api/contributions?since=...` |
| Internal vs. external attribution | `session.agent_kind` (partial) | Add `session.spawn_source: internal \| external` field + filter params |
| Live sessions | — | SSE endpoints `GET /api/sessions/stream` and `GET /api/sessions/{id}/stream` (core, M1) |
| Claude Code JSONL fidelity for external sessions | — | Deferred: `driver-claude-code` watcher (see [Deferred / Future](#deferred--future)) |

**Principle**: no new analytics logic in the app. The app is a **presentation layer**. Any new aggregation or attribution belongs in the kernel so the CLI benefits too.

## Kernel Dependencies

Kernel changes this app needs. Each is useful beyond the app and should land as independent kernel work.

### 1. `session.spawn_source` field

Today `Session` records `agent_name` and `agent_kind` (e.g. `ClaudeCode`). It does not record **how** the session was started — whether the kernel Scheduler spawned it or whether an external process pushed OTel in.

Proposal: add `spawn_source: SpawnSource` where `SpawnSource = Internal | External`.

- `Internal` — session was created by the kernel Scheduler or an app calling `POST /api/sessions` with a spawn token.
- `External` — session was created implicitly on first OTel span ingestion (OTLP receiver), no kernel spawn record.

Emit as a filter on `/api/sessions?spawn_source=internal` and roll up in `/api/analytics?spawn_source=...`.

### 2. `/api/net/*` routes

Once `gctrl-proxy` Phase 2 lands (hudsucker MITM + traffic logging), expose:

- `GET /api/net/overview` — total requests, bytes up/down, distinct domains, window.
- `GET /api/net/domains?since=...&top=N` — top domains by requests / bytes.
- `GET /api/net/traffic?since=...&host=...&limit=...` — recent requests, with `session_id` + `spawn_source` when derivable from the proxy's per-process attribution.
- `GET /api/net/daily?days=N` — daily request and byte trends.

Per-session attribution requires the proxy to tag traffic with the originating session (via env-injected header or PID→session mapping). Until that exists, network traffic shows as "unattributed" with host/process-level grouping only — still useful.

### 3. `GET /api/prompts` + `GET /api/sessions/{id}/prompts`

Light-weight routes backing the Prompts tab:

- `GET /api/sessions/{id}/prompts` — ordered list of prompt turns for a session.
- `GET /api/prompts?group_by=fingerprint&since=...` — prompt instances grouped by normalized-text hash, with counts, avg cost, and linked sessions.

No new storage — these are query-shape conveniences over the existing span table (filter by span type = `prompt` / `user_turn`).

### 4. `GET /api/contributions` + `session.contribution_links`

Backing the Contributions tab. When an agent creates a PR/commit during a session, the kernel records a link row (via `driver-github` callbacks on `pr create` / `git push`). The route aggregates these joined against GitHub-side state (PR status, lines changed).

- `session.contribution_links` — `(session_id, kind: commit | pr | issue, ref, created_at)`.
- `GET /api/contributions?since=...&agent=...` — list with drill-through fields.

## Dashboards

The SPA has **six top-level tabs**. Each tab accepts the same global filters: `time range`, `spawn_source` (all / internal / external), `agent_kind`, `workspace`.

Organizing principle: **Session is the spine** — every other surface is either a slice of session data (prompts, evals, activity, usage) or a downstream artifact (contributions). Tabs are organized by the question the operator is asking, not by the underlying table:

| Tab | Question it answers | Primary entity |
|-----|---------------------|----------------|
| Overview | "What happened in the last N hours?" | Rollup across all pillars |
| Sessions | "What ran / is running, and what did it do step-by-step?" | Session + Activity view |
| Prompts | "What are agents being asked, and which prompts actually work?" | Prompt template + instance |
| Evals | "Is quality drifting? Which rules are firing?" | Eval rule + score |
| Usage | "What is this costing and which providers/tools/domains are burning it?" | Provider, tool, proxied domain |
| Contributions | "What did agents actually ship?" | Commit, PR, issue |

**Drill path is one-directional toward Session**: every row on every tab links back to a Session detail pane. Contribution → PR → Session → Prompt → Span → Eval.

### 1. Overview

Single-page rollup answering "what happened in the last N hours/days". Samples one metric from every other tab so operators can see the shape of the system without clicking in.

- KPI row: live sessions now, total sessions (window), tokens, cost, distinct agents, top-3 proxied domains.
- Split bar: internal vs. external — sessions, cost, traffic.
- Sparkline row: sessions/day, cost/day, p95 latency/day, requests/day, eval pass rate/day, contributions/day.
- Recent sessions list (top 10 by recency) with drill-through to the Sessions tab.

### 2. Sessions

The primary "what has been / is being spawned" view. Shows **every agent-spawn session** the kernel knows about — past and live — regardless of whether we started it (internal) or an external tool pushed OTel in (external).

This tab also absorbs **Agent Activity** as a view-mode toggle (rather than its own tab) so the same data renders three ways without duplicate queries:

- **List** (default) — table of sessions filtered by the global filters, with a **status column**: `live` (no `ended_at`, recent span activity), `idle` (no `ended_at`, no recent spans), `ended`, `errored`.
- **Timeline** — horizontal lanes per agent, bars for each session, colored by status. Reveals idle periods and concurrency.
- **Heatmap** — agent × hour-of-day grid, cell intensity = session count or cost. Reveals activity patterns.

Shared controls: top toggle defaults to **"Live + recent"**; operators can switch to "All past" for historical inspection.

- Row → detail pane: agent, model, cost, duration, spawn_source, linked issue (if any), span count, error count, **live indicator** when streaming spans are still arriving.
- Detail pane embeds a **trace tree** (renders `GET /api/sessions/{id}/tree`) with span expansion, latency bars, and error highlighting. For live sessions the tree appends new spans as they arrive (SSE, see M1 below).
- Detail pane also surfaces: **prompts used** (links to Prompts tab), **evals attached** (links to Evals tab), **outbound requests** (from Usage/Network), **contributions produced** (from Contributions).
- Loops view surfaces `GET /api/sessions/{id}/loops` when the kernel detected repeated failures.

### 3. Prompts

Answers "what are agents being asked, and which prompts actually work?". Operates over both prompt templates (reusable, scheduled) and prompt instances (the actual user/system turns captured as spans).

- Searchable table of prompt instances across all sessions, with columns: prompt preview, agent, model, session, tokens, cost, eval score (if any), timestamp.
- Grouping by **prompt template** (when tagged) or by **prompt fingerprint** (hash of normalized text) to reveal which prompts are used repeatedly.
- Per-template panel: usage count over time, avg cost, avg eval score, top failure modes.
- Drill-through: prompt instance → session detail → full trace tree.
- Reuse: `GET /api/sessions/{id}/prompts` (new, light) + existing span query for instance rollup.

### 4. Evals

Answers "is quality drifting? which rules are firing?". Distinct from Prompts because the entity is different (eval rule vs. prompt) and the operator task is regression monitoring, not authoring.

- Score pass/fail trends per rule (reuses `GET /api/analytics/scores`).
- Alert rule status (reuses `GET /api/analytics/alerts`) — firing / silenced / clear.
- Per-rule panel: pass rate over time, recent failures with session links, which prompts trip it most.
- Breakdown by agent/model to spot provider-specific regressions.

### 5. Usage

Answers "what is this costing, and which providers / tools / domains are burning it?". Merges provider spend, tool usage, proxied network traffic, and OTel performance metrics into one resource-behavior surface. Operators compare "where is cost going?" against "where is traffic going?" in the same tab rather than flipping between three.

- **Providers** — cost + tokens per LLM provider (Anthropic, OpenAI, local). Reuses `GET /api/analytics/cost`.
- **Tools / utils** — usage per agent kind (Claude Code, Codex, ad-hoc scripts). Rows: invocation count, avg duration, cost, distinct sessions, split by `spawn_source`.
- **Proxied network traffic** — every HTTP request that flowed through the kernel proxy, both app-originated and external agents routed via `HTTP_PROXY`. Only meaningful once kernel proxy Phase 2 ships; before then, this sub-panel shows a placeholder explaining the dependency.
  - Top domains by requests and by bytes.
  - Request volume sparkline, stacked by `spawn_source` when attribution is available.
  - Status code distribution (2xx/3xx/4xx/5xx stacked).
  - Recent requests table with per-request drill-through (method, host, path, status, bytes, latency, session link).
  - Reverse join on the Sessions detail pane ("this session made 42 outbound requests to 3 domains").
- **Performance** — latency percentiles per model (reuses `GET /api/analytics/latency`), span type distribution (reuses `GET /api/analytics/spans`). Secondary panel; aggregate view of what the trace tree shows per-session.

### 6. Contributions

Answers "what did agents actually ship?". The entity is git/GitHub artifacts, not telemetry — this is the skeptic-facing tab that shows output, not activity.

- Table of commits, PRs, and issues closed, filterable by agent, time range, repo.
- Columns: title, author (agent or human), linked session, PR status (open/merged/closed), lines +/-, review signal.
- Sparkline: contributions/day split by `spawn_source`.
- Drill-through: contribution → PR on GitHub (via `driver-github`) and contribution → originating session.
- Reuse: joins `driver-github` PR data with `session.contribution_links` (new lightweight table populated when an agent creates a PR during a session).

## UI & Stack

Mirrors `gctrl-board` to avoid divergence:

- Cloudflare Worker facade + React 19 SPA.
- `@effect/platform` HTTP client for kernel calls (same pattern as board).
- `recharts` or `visx` for charts — pick one consistent with the board's eventual choice; no need to invent a chart stack twice.
- Tailwind + shadcn-style components. Dense tables by default — this is an operator tool, not a marketing site.
- Routes: `/overview`, `/sessions`, `/sessions/:id`, `/prompts`, `/evals`, `/usage`, `/contributions`.

The Worker itself is a **thin facade**: it proxies to the kernel HTTP API and serves the SPA bundle. No D1, no business logic in the Worker. This follows the [Kernel is source of truth; Worker is facade](../../../CLAUDE.md) invariant.

## Internal vs. External Agent Attribution

This is the distinctive thing this app does that no other surface does today.

| Signal | Internal | External |
|--------|----------|----------|
| Session creation | Scheduler / app POST with spawn token | Implicit on first OTel ingest |
| `agent_kind` | Usually known (we set it) | Inferred from OTel resource attrs (`service.name`, `telemetry.sdk.name`) or unknown |
| Linked to an Issue | Commonly (scheduler links via task) | Rarely (requires developer to put an Issue key in a span) |
| Network attribution | High (proxy env injection possible) | Low (depends on whether developer routes through `HTTP_PROXY`) |

The Overview and Sessions tabs show an **Internal / External** toggle. Evals, Usage, and Contributions tabs show a stacked split in every chart so the operator can always see the shape of both populations.

## Dogfooding

- This app is itself instrumented with OTel. It will appear in its own dashboards.
- We use it to track `claude-code` usage (external), kernel Scheduler tasks (internal), and spot cost regressions during development.
- During early development, the Usage tab's network sub-panel will show `/api/*` calls against `localhost:4318` — sanity check that the app isn't chatty.

## Milestones

1. **M0 — Skeleton + Overview + Sessions (past)**: Worker + SPA + kernel proxy, Overview tab, Sessions list + detail with trace tree over historical data. Poll-refresh for "live-ish" updates (5–10s). Uses existing kernel routes only. Fits on a laptop in an afternoon.
2. **M1 — Live sessions**: SSE endpoint `GET /api/sessions/stream` + per-session `GET /api/sessions/{id}/stream`. Sessions table and detail pane update in-place as spans land. This is a core feature, not optional — operators need to see agents while they are running.
3. **M2 — Usage + Evals**: Usage tab (providers, tools, performance — no network sub-panel yet), Evals tab (scores, alerts). Still zero new kernel work.
4. **M3 — Prompts + Activity views**: Prompts tab (needs `GET /api/prompts` + `GET /api/sessions/{id}/prompts`), plus Timeline and Heatmap view modes on the Sessions tab.
5. **M4 — Attribution**: kernel adds `session.spawn_source`. App adds global filter + split charts.
6. **M5 — Network sub-panel**: depends on kernel `proxy` Phase 2 + `/api/net/*` routes. Ships inside the Usage tab, not as its own tab.
7. **M6 — Contributions**: `session.contribution_links` + `GET /api/contributions`. Depends on `driver-github` callbacks on PR create / commit push.

## Deferred / Future

### Claude Code JSONL import

Claude Code writes a JSONL transcript per session (tool calls, messages, reasoning, file diffs) that is strictly richer than what we capture from its OTel output today. Importing it would let the Sessions detail pane show full agent reasoning and tool traces for external Claude Code runs — the same fidelity we get for internal sessions.

Out of scope for the initial build. Noted here so the Sessions model is not painted into a corner:

- Kernel would grow a driver (e.g. `driver-claude-code`) that watches `~/.claude/projects/**/*.jsonl` and upserts spans/messages against a matching external session (join key: working directory + start time).
- No schema change in the session model is required — the driver maps JSONL entries onto existing `Span` / message tables.
- Until this exists, external Claude Code sessions rely on OTel alone; the Sessions pane renders whatever the OTel receiver captured and labels gaps clearly.

## Non-Goals / Explicit Boundaries

- Not an OTel backend. The kernel's DuckDB-backed OTel receiver is the store. This app does not ingest, store, or forward telemetry.
- Not a replacement for Langfuse/Grafana for teams — single-operator local tool.
- Not a write surface. All mutations (scoring, tagging, alerting) remain on the CLI to keep the UI simple and avoid an approval surface inside the browser.

## Open Questions

1. Should `spawn_source` be three-valued (`internal | external | unknown`) to handle pre-migration data, or should we backfill old rows to `external` on first deploy? Leaning `unknown` + CLI backfill command.
2. How do we attribute external `claude-code` traffic when it doesn't go through our proxy? Likely we can't — and that's fine; the OTel side still gives us per-session cost.
3. Chart library: `recharts` (friendly, battery-included) vs. `visx` (more control, more code). Defer until we know what charts M2 actually needs.
4. Is Agent Activity as a view-mode on Sessions sufficient, or do operators expect it as a top-level tab? Easy to promote later if the toggle proves too buried.
5. Should Prompts and Evals be merged into one "Quality" tab? Kept separate because the entities (prompt template vs. eval rule) and the operator tasks (authoring vs. regression monitoring) differ — revisit after M3.
6. `session.contribution_links` vs. inferring contributions from commit message / PR body mentions of session IDs. Explicit link rows are cleaner but require `driver-github` to emit callbacks; inference is retroactive but lossy.
