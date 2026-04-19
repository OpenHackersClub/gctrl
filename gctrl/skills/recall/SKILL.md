---
name: recall
description: Gather durable context about an entity (project, issue, module, person) and render it as a compact brief suitable for injecting into a dispatched agent's prompt. Use before dispatch, or at the start of a new session on a familiar topic.
allowed-tools: Bash(gctrl context:*) Bash(gctrl board:*) Bash(gctrl gh:*) Bash(gctrl sessions:*) Read
metadata:
  owner: gctrl-core
  stability: alpha
  scope: project
---

# /recall

The read-side counterpart to `/memorize`. Given an entity reference, pull together observations, related issues / PRs, recent sessions, and relevant docs — then emit a compact brief (≤2000 tokens by default) that an agent can consume as `<available_context>`.

## When to use

- Just before dispatching an agent to work on an issue or module.
- Starting a new session on a familiar area after a context gap.
- As a Tier-2 expansion during `/dispatch` when the default prompt context isn't enough.

Do NOT use to dump everything known about an entity — that defeats progressive disclosure. Default token budget is deliberately tight.

## Inputs

- `entity` (required) — e.g. `project:gctrl`, `issue:board:42`, `module:kernel-sync`, `user:vic`.
- `purpose` (optional) — free-text hint about why you're recalling (e.g. "debugging sync failure", "writing tests"). Steers ranking.
- `budget_tokens` (optional) — soft cap on brief size. Default `2000`.
- `since` (optional) — only include observations/sessions newer than this (ISO or relative).

## Procedure

### 1. Resolve the entity

Accept flexible references:

- Exact entity id → use as-is.
- Board/GitHub issue number → resolve via `gctrl board issues view` / `gctrl gh issue view`, use the inferred entity id.
- Fuzzy module/path name → match against `context_entries.path` prefixes.

If the reference is ambiguous, list candidates on stderr and exit 3.

### 2. Gather sources (in parallel where possible)

| Source | Command | Ranking signal |
|---|---|---|
| Observations | `gctrl context list --tags "entity:<id>,kind:observation" --format json` | Recency × confidence |
| Decisions / specs | `gctrl context list --tags "entity:<id>,aspect:decision" --format json` | Recency |
| Board issues | `gctrl board issues list --related <id> --limit 10 --format json` | Open first, then by recency |
| GitHub PRs | `gctrl gh pr list --linked <id> --state all --limit 10 --format json` | Merged-recent > open > closed-stale |
| Recent sessions | `gctrl sessions list --entity <id> --limit 5 --format json` | Cost-weighted recency |

Fall back gracefully — if a source is unavailable (driver off, entity has no linked PRs), skip it and note on stderr.

### 3. Rank and select under budget

Rough order:

1. Top 3 observations by `confidence × recency`.
2. Any open issues directly tagged with this entity.
3. Most recent merged PR touching the entity (title + 1-line summary).
4. Decisions marked `aspect:decision` from the last 90 days.
5. Top-of-mind: the most expensive recent session's conclusion, if `/memorize`d.

Fit under `budget_tokens`. When over budget, drop lowest-ranked items and note the truncation in the output.

### 4. Render the brief

Output as Markdown ready to paste into `<available_context>`:

```markdown
# Recall: <entity_id>

_Generated <ISO-8601>. Budget: <N> tokens (<used>/<N>)._

## Stable facts
- [observation 1, with source ref]
- [observation 2]

## Recent decisions
- YYYY-MM-DD — <one-line decision> ([path/to/context.md])

## Active work
- #<issue> (<state>) — <title>
- PR #<n> (<state>) — <title>

## Recent sessions
- <session_id> (<cost>, <status>) — <conclusion>

## Gaps / cautions
- [anything the caller should know is uncertain or missing]
```

### 5. Emit side-channel metadata

On stderr (or a `--json` sibling stream), emit:

```json
{
  "entity": "<id>",
  "budget_tokens": 2000,
  "tokens_used": 1842,
  "dropped": 3,
  "sources_hit": ["observations", "board", "gh", "sessions"],
  "sources_missed": ["linear"]
}
```

Callers that want to drive further expansion use this to decide which source to request more from.

## Output contract

- Stdout: a single Markdown brief, nothing else.
- Stderr: ranking notes, dropped items, source availability.
- Never fabricate claims. If a section has no content, omit it — do not write "N/A" placeholders.

## Failure modes

| Case | Behaviour |
|---|---|
| Entity not found | Exit 3, list fuzzy candidates on stderr. |
| All sources empty | Exit 0 with a one-line brief stating the entity has no durable context yet; suggest running `/memorize` on a recent relevant session. |
| Budget below minimum (e.g. <300 tokens) | Warn and emit only "Stable facts" section. |

## Future — entity graph migration

When the entity graph lands:

- Replace `gctrl context list --tags "entity:<id>,..."` with `GET /api/memory/entity/<id>` (returns representations + observations in one call).
- Ranking moves server-side: kernel-owned derivers maintain `entity_representations` with pre-computed relevance.
- Add hybrid retrieval (`?near=<id>&q=<purpose>`) once vectors are indexed.

Brief format and caller contract stay identical.
