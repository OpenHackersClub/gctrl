# Application: gctrl-analytics (Usage, OTel & Network Dashboard)

gctrl-analytics is the **observability web application** for gctrl — a unified dashboard for usage, OTel traces, cost/latency analytics, and network traffic routed through the kernel. It visualizes activity from both **internal agents** (scheduled/spawned by us through the kernel) and **external agents** (Claude Code, Codex, ad-hoc scripts, humans) that push telemetry through the OTel receiver or route traffic through the kernel proxy.

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

1. **Usage** — sessions, agent runs, tokens, cost, trends over time, by agent / model / workspace.
2. **OTel analytics** — trace trees, span type distributions, latency percentiles, error loops, scores, alerts.
3. **Network traffic** — domains contacted, bytes up/down, request counts, status-code distribution, per-agent attribution (requires kernel `proxy` Phase 2 + new `/api/net/*` routes; see [Kernel Dependencies](#kernel-dependencies)).
4. **Agent attribution** — distinguish **internal** (scheduled via kernel Scheduler / spawned by our apps) vs **external** (pushed OTel from outside, e.g. a developer running `claude` locally against the OTel receiver) across all three surfaces above.

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
| Network traffic (domains, bytes, status) | — | Kernel `proxy` Phase 2 + `GET /api/net/*` routes |
| Internal vs. external attribution | `session.agent_kind` (partial) | Add `session.spawn_source: internal \| external` field + filter params |
| Live updates | — | Optional SSE endpoint `GET /api/sessions/stream` (deferrable) |

**Principle**: no new analytics logic in the app. The app is a **presentation layer**. Any new aggregation or attribution belongs in the kernel so the CLI benefits too.

## Kernel Dependencies

Two kernel changes this app needs. Both are useful beyond the app and should land as independent kernel work.

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

## Dashboards

The SPA has four top-level tabs. Each tab accepts the same global filters: `time range`, `spawn_source` (all / internal / external), `agent_kind`, `workspace`.

### 1. Overview

Single-page rollup answering "what happened in the last N hours/days":

- KPI row: sessions, spans, tokens, cost, distinct agents, distinct domains contacted.
- Split bar: internal vs. external — sessions, cost, traffic.
- Sparkline row: sessions/day, cost/day, p95 latency/day, requests/day.
- Recent sessions list (top 10 by recency) with drill-through to the Sessions tab.

### 2. Sessions

- Table of sessions filtered by the global filters.
- Row → detail pane: agent, model, cost, duration, spawn_source, linked issue (if any), span count, error count.
- Detail pane embeds a **trace tree** (renders `GET /api/sessions/{id}/tree`) with span expansion, latency bars, and error highlighting.
- Loops view surfaces `GET /api/sessions/{id}/loops` when the kernel detected repeated failures.

### 3. OTel

- Latency percentiles per model (reuses `GET /api/analytics/latency`).
- Span type distribution (reuses `GET /api/analytics/spans`).
- Score pass/fail trends (reuses `GET /api/analytics/scores`).
- Alert rule status (reuses `GET /api/analytics/alerts`).
- Cost breakdown by model and by agent (reuses `GET /api/analytics/cost`).

### 4. Network

Only meaningful once kernel proxy Phase 2 ships. Before then, this tab shows a placeholder explaining the dependency.

- Top domains by requests and by bytes.
- Request volume sparkline.
- Status code distribution (2xx/3xx/4xx/5xx stacked).
- Recent requests table with per-request drill-through.
- When attribution is available: "network cost" joined to a session (e.g. "session `sess_abc` contacted `api.openai.com` 42 times, 312 KB").

## UI & Stack

Mirrors `gctrl-board` to avoid divergence:

- Cloudflare Worker facade + React 19 SPA.
- `@effect/platform` HTTP client for kernel calls (same pattern as board).
- `recharts` or `visx` for charts — pick one consistent with the board's eventual choice; no need to invent a chart stack twice.
- Tailwind + shadcn-style components. Dense tables by default — this is an operator tool, not a marketing site.
- Routes: `/overview`, `/sessions`, `/sessions/:id`, `/otel`, `/net`.

The Worker itself is a **thin facade**: it proxies to the kernel HTTP API and serves the SPA bundle. No D1, no business logic in the Worker. This follows the [Kernel is source of truth; Worker is facade](../../../CLAUDE.md) invariant.

## Internal vs. External Agent Attribution

This is the distinctive thing this app does that no other surface does today.

| Signal | Internal | External |
|--------|----------|----------|
| Session creation | Scheduler / app POST with spawn token | Implicit on first OTel ingest |
| `agent_kind` | Usually known (we set it) | Inferred from OTel resource attrs (`service.name`, `telemetry.sdk.name`) or unknown |
| Linked to an Issue | Commonly (scheduler links via task) | Rarely (requires developer to put an Issue key in a span) |
| Network attribution | High (proxy env injection possible) | Low (depends on whether developer routes through `HTTP_PROXY`) |

The Overview and Sessions tabs show an **Internal / External** toggle. OTel and Network tabs show a stacked split in every chart so the operator can always see the shape of both populations.

## Dogfooding

- This app is itself instrumented with OTel. It will appear in its own dashboards.
- We use it to track `claude-code` usage (external), kernel Scheduler tasks (internal), and spot cost regressions during development.
- During early development, the Network tab will show `/api/*` calls against `localhost:4318` — sanity check that the app isn't chatty.

## Milestones

1. **M0 — Skeleton + Overview + Sessions**: Worker + SPA + kernel proxy, Overview tab, Sessions list + detail with trace tree. No network tab. Uses existing kernel routes only. Fits on a laptop in an afternoon.
2. **M1 — OTel tab**: latency, spans, scores, alerts, cost breakdown. Still zero new kernel work.
3. **M2 — Attribution**: kernel adds `session.spawn_source`. App adds global filter + split charts.
4. **M3 — Network tab**: depends on kernel `proxy` Phase 2 + `/api/net/*` routes. Ship placeholder until then.
5. **M4 — Live updates (optional)**: SSE for session list on the Sessions tab.

## Non-Goals / Explicit Boundaries

- Not an OTel backend. The kernel's DuckDB-backed OTel receiver is the store. This app does not ingest, store, or forward telemetry.
- Not a replacement for Langfuse/Grafana for teams — single-operator local tool.
- Not a write surface. All mutations (scoring, tagging, alerting) remain on the CLI to keep the UI simple and avoid an approval surface inside the browser.

## Open Questions

1. Should `spawn_source` be three-valued (`internal | external | unknown`) to handle pre-migration data, or should we backfill old rows to `external` on first deploy? Leaning `unknown` + CLI backfill command.
2. How do we attribute external `claude-code` traffic when it doesn't go through our proxy? Likely we can't — and that's fine; the OTel side still gives us per-session cost.
3. Chart library: `recharts` (friendly, battery-included) vs. `visx` (more control, more code). Defer until we know what charts M1 actually needs.
