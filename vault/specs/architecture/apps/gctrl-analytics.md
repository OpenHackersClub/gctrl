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
| Contributions tab | `driver-github` PR/commit data + commit trailer inference | `GET /api/contributions?since=...` (inference-first; promote to link table only if inference proves lossy) |
| Internal vs. external attribution | — (`agent_kind` lives on `Task`, not `Session`) | Add `session.created_by: scheduler \| otel_ingest \| api \| unknown`; derive `internal` / `external` as a view |
| Live sessions | SSE endpoints `GET /api/sessions/stream` and `GET /api/sessions/{id}/stream` (shipped M0-final) | — |
| "Live sessions now" KPI | `GET /api/sessions?status=active` count, client-side | — (kernel `/api/analytics` rollup intentionally omits `active_sessions`; do not add) |
| Claude Code JSONL fidelity for external sessions | — | Deferred: `driver-claude-code` watcher (see [Deferred / Future](#deferred--future)) |

**Principle**: no new analytics logic in the app. The app is a **presentation layer**. Any new aggregation or attribution belongs in the kernel so the CLI benefits too.

## Kernel Dependencies

Kernel changes this app needs. Each is useful beyond the app and should land as independent kernel work.

### 1. `session.created_by` field

Today `Session` records `agent_name` (string) and a `status` enum; it has **no** `agent_kind` field — `agent_kind` lives on `Task` (`kernel/crates/gctrl-core/src/types.rs:82`). It also does not record **how** the session was started — whether the kernel Scheduler spawned it, an app called the API with a spawn token, or an external process pushed OTel in.

Proposal: add a narrow provenance enum on `Session`:

```
created_by: CreatedBy = Scheduler | OtelIngest | Api | Unknown
```

- `Scheduler` — session was created by the kernel Scheduler dispatching a `Task`.
- `Api` — session was created by an app/tool calling `POST /api/sessions` with a spawn token.
- `OtelIngest` — session was created implicitly on first OTLP span ingestion, no kernel spawn record.
- `Unknown` — pre-migration rows; never emitted for new sessions.

`internal` vs. `external` is **a view**, not a stored field. Queries and the UI toggle derive it:

```
internal = created_by IN (Scheduler, Api)
external = created_by = OtelIngest
```

This keeps the stored value faithful to the actual signal (who wrote the row) while letting the UI vocabulary evolve. Emit `created_by` as a filter on `/api/sessions?created_by=scheduler` and `/api/analytics?created_by=...`; accept the derived shorthand `?kind=internal` / `?kind=external` too.

For per-session **agent kind** (Claude Code, Codex, ad-hoc) — which the Sessions tab needs — derive from `Task.agent_kind` when a `task_id` is present, otherwise from OTel `resource.service.name` / `telemetry.sdk.name`. No new `Session.agent_kind` column unless derivation proves too slow at list-query scale.

### 2. `/api/net/*` routes

Once `gctrl-proxy` Phase 2 lands (hudsucker MITM + traffic logging), expose:

- `GET /api/net/overview` — total requests, bytes up/down, distinct domains, window.
- `GET /api/net/domains?since=...&top=N` — top domains by requests / bytes.
- `GET /api/net/traffic?since=...&host=...&limit=...` — recent requests, with `session_id` + `created_by` when derivable from the proxy's per-process attribution.
- `GET /api/net/daily?days=N` — daily request and byte trends.

Per-session attribution requires the proxy to tag traffic with the originating session (via env-injected header or PID→session mapping). Until that exists, network traffic shows as "unattributed" with host/process-level grouping only — still useful.

### 3. `GET /api/prompts` + `GET /api/sessions/{id}/prompts` (+ storage for prompt turns)

Light-weight routes backing the Prompts tab:

- `GET /api/sessions/{id}/prompts` — ordered list of prompt turns for a session.
- `GET /api/prompts?group_by=fingerprint&since=...` — prompt instances grouped by normalized-text hash, with counts, avg cost, and linked sessions.

**Storage is not free today.** `SpanType` in `kernel/crates/gctrl-core/src/types.rs:135` is `Generation | Span | Event` — there is no `prompt` / `user_turn` variant, so a prompts tab cannot be "a query over existing spans." M3 must choose one of:

1. **Extend `SpanType`** with `UserTurn` and `AssistantTurn` (or a single `Turn` + role attr), and emit them from the OTLP ingest path. Cheapest option, keeps everything in the span table; cost is a migration + every ingest path learning the new variants.
2. **Add a dedicated `prompts` table** keyed by `(session_id, turn_ordinal)` with `role`, `text`, `fingerprint`, `tokens_in`, `tokens_out`, `cost_usd`, `span_id` (link). Cleanest schema for the Prompts tab, but a new table to sync.

Leaning toward (1) unless eval tooling needs random-access joins on prompt text that the span table can't give cheaply. Decide in the M3 ADR; do **not** ship the Prompts tab before this lands.

Route shapes stay the same under either option — the Prompts UI binds to the route, not the table.

### 4. `GET /api/contributions` (inference-first)

Backing the Contributions tab. **Default approach is trailer inference, not a new link table.**

- Agents append a `Session-Id: <uuid>` trailer to commits they author (already a cheap convention to enforce in orch / wrapper scripts).
- `driver-github` already pulls commits and PRs through the kernel. The Contributions route scans commit trailers and PR body mentions (`Session-Id:` or a recognizable session URL) and joins back to `Session` at query time.
- `GET /api/contributions?since=...&agent=...` — list of commits / PRs / closed issues with inferred `session_id`, drill-through to PR and Session.

This is retroactive (works for commits we never "observed"), loss-tolerant (missing trailer = unattributed row, still shown), and adds no write path to sync. Promote to a dedicated `session.contribution_links` table **only when** inference proves lossy in practice — e.g. agents routinely strip trailers, or the join is too expensive at scale. If that happens, the table is an index, not a new source of truth.

Explicitly **not** adding `driver-github` callbacks on `pr create` / `git push` for this — that coupling is what we want to avoid until a concrete gap justifies it.

### 5. SSE live-stream contract (M0)

Live session updates go over Server-Sent Events, not polling. Two endpoints:

- `GET /api/sessions/stream` — stream of session-level events (`session.started`, `session.span`, `session.ended`, `session.status_changed`).
- `GET /api/sessions/{id}/stream` — stream narrowed to one session (span appends, status changes).

**Producer**: a single `tokio::sync::broadcast::channel` per kind inside `gctrl-otel`'s ingest path. On each OTLP batch, ingest fans out a lightweight `SessionEvent` on the broadcast. Each HTTP handler holds a `broadcast::Receiver` and streams events as SSE. No per-connection polling of DuckDB — the ingest path is the only reader that touches the DB for live updates.

**Wire format**: standard SSE framing with one JSON event per message.

```
id: <monotonic u64 per broadcast>
event: session.span
data: {"session_id":"…","span_id":"…","ts":"…","type":"generation","status":"ok"}
```

`id` is the broadcast-wide monotonic counter, **not** a span or span-start timestamp, so `Last-Event-ID` reconnect is well-defined.

**Reconnect semantics**: on reconnect, the client sends `Last-Event-ID: <n>`. The server replays any buffered events with `id > n` from an in-memory ring (size configurable, default 1024 events per stream, ~few seconds at expected throughput). If the requested id is older than the ring, the server sends `event: replay_gap` and the client is expected to re-fetch state from the non-streaming routes (`/api/sessions`, `/api/sessions/{id}/tree`) and resume tailing.

**Heartbeat**: server emits `: heartbeat\n\n` every 15s so clients behind proxies detect dead connections. No application-level ping payload.

**Backpressure**: broadcast channel uses `Lagged` errors on slow consumers; handler drops the lagged receiver, closes the connection, and the client reconnects with `Last-Event-ID` — same replay-or-gap path as any other disconnect.

Spec-visible: this is the **only** live-update mechanism. The M0-preview polling shim was deleted when M0-final landed; `grep setInterval apps/gctrl-board/web/src/pages/AnalyticsPage.tsx` returns zero matches.

## Dashboards

The SPA has **six top-level tabs**. Each tab accepts the same global filters: `time range`, `created_by` (all / scheduler / api / otel_ingest) with a derived `kind` shortcut (internal / external), `agent_kind` (derived — see §1), `workspace`.

Organizing principle: **Session is the spine** — every other surface is either a slice of session data (prompts, evals, activity, usage) or a downstream artifact (contributions). This framing is load-bearing for the tab structure, the drill path, and the SSE contract; see [ADR: Session is the spine; Activity is a view-mode](./adr-session-is-the-spine.md) for the rationale, consequences, and trigger to revisit. Tabs are organized by the question the operator is asking, not by the underlying table:

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

- Row → detail pane: agent, model, cost, duration, `created_by`, linked issue (if any), span count, error count, **live indicator** when streaming spans are still arriving.
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
- **Tools / utils** — usage per agent kind (Claude Code, Codex, ad-hoc scripts). Rows: invocation count, avg duration, cost, distinct sessions, split by `created_by`.
- **Proxied network traffic** — every HTTP request that flowed through the kernel proxy, both app-originated and external agents routed via `HTTP_PROXY`. Only meaningful once kernel proxy Phase 2 ships; before then, this sub-panel shows a placeholder explaining the dependency.
  - Top domains by requests and by bytes.
  - Request volume sparkline, stacked by `created_by` when attribution is available.
  - Status code distribution (2xx/3xx/4xx/5xx stacked).
  - Recent requests table with per-request drill-through (method, host, path, status, bytes, latency, session link).
  - Reverse join on the Sessions detail pane ("this session made 42 outbound requests to 3 domains").
- **Performance** — latency percentiles per model (reuses `GET /api/analytics/latency`), span type distribution (reuses `GET /api/analytics/spans`). Secondary panel; aggregate view of what the trace tree shows per-session.

### 6. Contributions

Answers "what did agents actually ship?". The entity is git/GitHub artifacts, not telemetry — this is the skeptic-facing tab that shows output, not activity.

- Table of commits, PRs, and issues closed, filterable by agent, time range, repo.
- Columns: title, author (agent or human), linked session, PR status (open/merged/closed), lines +/-, review signal.
- Sparkline: contributions/day split by `created_by`.
- Drill-through: contribution → PR on GitHub (via `driver-github`) and contribution → originating session (via commit trailer inference — see Kernel Dependencies §4).
- Reuse: `driver-github` PR/commit data + trailer inference at query time; no new link table in the initial build.

## UI & Stack

Mirrors `gctrl-board` to avoid divergence:

- Cloudflare Worker facade + React 19 SPA.
- `@effect/platform` HTTP client for kernel calls (same pattern as board).
- `recharts` or `visx` for charts — pick one consistent with the board's eventual choice; no need to invent a chart stack twice.
- Tailwind v4 + **shadcn/ui** primitives (vendored under `apps/gctrl-board/web/src/components/ui/`). Tokens are declared once in `index.css` `@theme` and inherited by every primitive (`bg-card`, `text-muted-foreground`, `text-primary`, etc.) so the operator-tool aesthetic stays consistent across analytics, kanban, and gantt without re-themeing each component. Primitives in active use today: `Tabs`, `Card`, `Table`, `Badge`, `ToggleGroup`, `Tooltip`, `Button`. Dense tables by default — this is an operator tool, not a marketing site.
- Routes: `/overview`, `/sessions`, `/sessions/:id`, `/prompts`, `/evals`, `/usage`, `/contributions`.

The Worker itself is a **thin facade**: it proxies to the kernel HTTP API and serves the SPA bundle. No D1, no business logic in the Worker. This follows the [Kernel is source of truth; Worker is facade](../../../CLAUDE.md) invariant.

## Internal vs. External Agent Attribution

This is the distinctive thing this app does that no other surface does today. The stored field is `created_by` (see Kernel Dependencies §1); `internal` / `external` is a derived view — `internal = {Scheduler, Api}`, `external = {OtelIngest}`.

| Signal | Internal (`Scheduler` / `Api`) | External (`OtelIngest`) |
|--------|--------------------------------|-------------------------|
| Session creation | Scheduler dispatch or app `POST /api/sessions` with spawn token | Implicit on first OTLP ingest |
| Agent kind | Known — `Task.agent_kind` for Scheduler, supplied by caller for Api | Inferred from OTel `resource.service.name` / `telemetry.sdk.name` or unknown |
| Linked to an Issue | Commonly (scheduler links via task) | Rarely (requires developer to put an Issue key in a span) |
| Network attribution | High (proxy env injection possible) | Low (depends on whether developer routes through `HTTP_PROXY`) |

The Overview and Sessions tabs show an **Internal / External** toggle (`?kind=internal|external`) with an optional drill to the raw `created_by` values. Evals, Usage, and Contributions tabs show a stacked split in every chart so the operator can always see the shape of both populations.

## Dogfooding

- This app is itself instrumented with OTel. It will appear in its own dashboards.
- We use it to track `claude-code` usage (external), kernel Scheduler tasks (internal), and spot cost regressions during development.
- During early development, the Usage tab's network sub-panel will show `/api/*` calls against `localhost:4318` — sanity check that the app isn't chatty.

## Milestones

The PRD's primary problem is **live visibility of what's running now**. Shipping past-only first fails that problem, so live Sessions visibility is in M0, not later.

Live updates were originally staged in two checkpoints; both have shipped:

- **M0-preview** *(shipped & retired)* — first cut used a 5-second poll shim against the non-stream routes. Unblocked Usage/Evals while the kernel SSE work was specced.
- **M0-final** *(shipped)* — kernel emits `tokio::sync::broadcast` on every ingest + lifecycle, axum SSE handlers stream events with `Last-Event-ID` replay + `replay_gap` + 15s heartbeat. The client uses `EventSource` (one connection per page for the global stream + one per detail pane for `session_id` filtering). The polling shim and `LIVE_REFRESH_MS` constant are deleted from `AnalyticsPage.tsx`. No polling fallback in the shipped UI.

Each milestone lists one falsifiable acceptance criterion per shipped tab; it's the check the operator should be able to run in under a minute to say "this milestone landed."

1. **M0 — Skeleton + Overview + Sessions (past + live)** *(closed)*: Worker + SPA + kernel HTTP proxy. Overview tab. Sessions tab (list mode only) with trace tree in the detail pane. ADR "Session is the spine / Activity is a view-mode" merged. SSE landed in the M0-final follow-up — see Kernel Dependencies §5 for the producer/consumer contract and `kernel/crates/gctrl-otel/tests/sse_stream.rs` for the integration test that exercises ingest → broadcast → SSE frame.
   - *Accept Overview*: with one live agent running, the KPI "live sessions now" increments within 2s of the `session.started` span and decrements within 2s of `session.ended`, without a page refresh.
   - *Accept Sessions*: opening the detail pane on a live session refetches the trace tree within 2s of each `session.span` event for that session; closing and reopening restores tree state from the non-stream route plus any buffered replay.
   - *Accept M0-final*: `grep -R "setInterval" apps/gctrl-board/web/src/pages/AnalyticsPage.tsx` returns zero matches; the only live-update mechanism is `EventSource` against `/api/sessions/stream` and `/api/sessions/{id}/stream`. **Verified.**
2. **M1 — Usage + Evals**: Usage tab (providers, tools, performance — no network sub-panel yet), Evals tab (scores, alerts). Zero new kernel work.
   - *Accept Usage*: provider spend on the Usage tab over any window matches `gctrl analytics cost --since <window>` to the cent.
   - *Accept Evals*: every alert rule that's `firing` in `gctrl analytics alerts` appears as `firing` on the Evals tab within one refresh.
3. **M2 — Prompts + Activity views**: split for delivery — Activity views (M2a) ship as pure-UI without kernel work; Prompts (M2b) remain blocked on the kernel ADR (extended `SpanType` variants **or** a `prompts` table — decide in the M2 ADR).
   - **M2a — Sessions Activity views** *(shipped)*: Timeline and Heatmap view modes on the Sessions tab. View-mode is local component state in `SessionsTab`; the underlying `sessions` query is shared across List/Timeline/Heatmap.
     - Timeline: lanes per `agent_name`, bars per session, colored by status; live sessions pulse; tooltip shows time range and cost; click drills into the detail pane.
     - Heatmap: agent × hour-of-day grid with a `count`/`cost` toggle; quantized 5-bucket emerald scale so adjacent intensities are eye-readable; click drills into the first session in the cell.
   - **M2b — Prompts tab** *(blocked on M2 ADR)*: not yet shipped.
   - *Accept M2a (Sessions views)*: switching list → timeline → heatmap does not re-fetch — same query, three renderings — verified by watching the Network tab. **Verified.**
   - *Accept M2b (Prompts)*: grouping by fingerprint over a known test corpus produces the same group counts as the kernel query used to back the route (diff the JSON, expect zero rows).
4. **M3 — Attribution** *(shipped — kernel + UI filter; stacked-chart splits deferred to a follow-up)*:
   - **Kernel**: `Session.created_by: Scheduler | OtelIngest | Api | Unknown` landed in `gctrl-core/src/types.rs`. DuckDB schema gained a `created_by` column (constraint-less `ALTER` for legacy DBs; legacy NULL maps to `Unknown` in `row_to_session`). `list_sessions_filtered` accepts a `Vec<CreatedBy>` filter; `GET /api/sessions` accepts both `?created_by=scheduler,api` and the derived `?kind=internal|external` shorthand. Auto-create on OTLP ingest tags `OtelIngest`.
   - **UI**: global `kind: all | internal | external` toggle in the analytics tab bar; threads through Overview's live count and the Sessions list query. Session detail pane shows a `Provenance` badge mapping the raw `created_by` to the derived view label.
   - **Deferred** (separate PR): stacked splits on Evals / Usage / Contributions charts. Today the `/api/analytics` rollup is population-wide; the Overview KPIs annotate with `· all kinds` when a filter is active so operators aren't misled.
   - *Accept*: filtering `kind=external` on a workspace with only scheduler-spawned sessions returns zero rows; `kind=internal` returns every row. Totals of the two equal the unfiltered total. **Verified** by `kernel/crates/gctrl-otel/tests/created_by_filter.rs::internal_plus_external_equals_total`.
5. **M4 — Network sub-panel**: depends on kernel `proxy` Phase 2 + `/api/net/*` routes. Ships inside the Usage tab, not as its own tab.
   - *Accept*: a request made through the proxy during a known session appears in that session's detail pane under "outbound requests" within one refresh, with host/path/status matching the proxy log.
6. **M5 — Contributions**: `GET /api/contributions` (trailer-inference flavour per Kernel Dependencies §4). No `session.contribution_links` table unless inference proves lossy on a real workspace.
   - *Accept*: a commit authored during a live session with a `Session-Id:` trailer shows up on the Contributions tab with the correct session drill-through; a commit without the trailer shows up as unattributed, not dropped.

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

1. Backfill of `session.created_by` for pre-migration rows: leave as `Unknown` and let a CLI `gctrl sessions backfill-created-by` command reclassify from existing signals (presence of `task_id` ⇒ `Scheduler`, OTel-only origin ⇒ `OtelIngest`)? That's the current lean. No tri-valued `internal|external|unknown` stored field — derivation stays on the read path.
2. How do we attribute external `claude-code` traffic when it doesn't go through our proxy? Likely we can't — and that's fine; the OTel side still gives us per-session cost.
3. Chart library: `recharts` (friendly, battery-included) vs. `visx` (more control, more code). Defer until we know what charts M1 actually needs.
4. Is Agent Activity as a view-mode on Sessions sufficient, or do operators expect it as a top-level tab? Easy to promote later if the toggle proves too buried. (Codify the decision in the "Session is the spine" ADR landing with M0.)
5. Should Prompts and Evals be merged into one "Quality" tab? Kept separate because the entities (prompt template vs. eval rule) and the operator tasks (authoring vs. regression monitoring) differ — revisit after M2.
6. M2 Prompts storage: extend `SpanType` with `UserTurn` / `AssistantTurn` (option A) vs. dedicated `prompts` table (option B). Decide in the M2 ADR — the trigger for (B) is random-access joins on prompt text that the span table can't serve cheaply.
