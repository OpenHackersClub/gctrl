---
name: memorize
description: Extract stable facts from a completed session and persist them as durable context so future sessions can recall them. Use after a session concludes meaningful work (bug root-caused, architectural decision made, new convention established).
allowed-tools: Bash(gctrl sessions:*) Bash(gctrl context:*) Bash(gctrl analytics:*) Read
metadata:
  owner: gctrl-core
  stability: alpha
  scope: project
---

# /memorize

Distill a session's span tree into durable, agent-readable facts. Writes them into `gctrl context` today; will migrate to the entity graph (`entity_observations`) once that subsystem lands — the caller-facing contract is unchanged.

## When to use

- A session has just ended and produced non-obvious conclusions (root cause of a bug, why an approach was rejected, a new invariant).
- An onboarding / spec-review session surfaces context worth re-reading later.
- Do NOT use for ephemeral task state — that belongs in the board issue or PR description.

## Inputs

- `session_id` (required) — the session to memorize. Defaults to the most recently ended session for the current user.
- `entity` (optional) — an entity reference to anchor the facts (e.g. `project:gctrl`, `issue:board:42`, `module:kernel-sync`). If omitted, infer from the session's associated board/GitHub issues.
- `aspect` (optional) — a short label grouping these facts (`architecture`, `incident`, `convention`, `decision`). Defaults to `notes`.

## Procedure

### 1. Resolve the session

```sh
gctrl sessions show <session_id> --format json
gctrl sessions spans <session_id> --format json
gctrl sessions tree  <session_id>
```

Read: task link, cost, span summary, errors, guardrail events, linked issues / PRs.

### 2. Identify the target entity

Order of precedence:

1. Explicit `entity` argument.
2. Board issue linked to the session (`sessions.issue_id` → `board_issues.id`).
3. GitHub PR/issue referenced in spans.
4. If none resolve, ask the caller (do NOT invent an entity).

### 3. Extract candidate facts

Criteria for a "memorizable" fact:

- **Stable** — still true in a week, probably still true in a quarter.
- **Non-obvious** — not inferable from the current code or existing specs.
- **Actionable or explanatory** — tells a future agent *what to do* or *why a thing is the way it is*.

Reject: task-level progress, TODOs, ephemeral errors that got fixed in the same session, restatements of code.

Prefer:

- Invariants and constraints the code doesn't make explicit.
- Root causes (and what symptoms *looked like* before the root cause was known).
- Rejected approaches with reason.
- Conventions agreed verbally but not yet specced.

### 4. Write durable context

For each accepted fact, append a context entry:

```sh
gctrl context add \
  --kind snapshot \
  --path "memory/<entity_id>/<aspect>/<YYYY-MM-DD>-<slug>.md" \
  --title "<fact summary ≤80 chars>" \
  --tags "entity:<entity_id>,aspect:<aspect>,session:<session_id>,kind:observation" \
  --source-type session \
  --source-ref <session_id>
```

Content body (markdown + YAML frontmatter):

```markdown
---
claim: "<one-sentence fact>"
entity: "<entity_id>"
aspect: "<aspect>"
observed_at: "<ISO-8601>"
source_session: "<session_id>"
confidence: 0.9
supersedes: null  # or id of older observation this replaces
---

<paragraph of context — the story behind the claim, with span references
and any code/spec links that back it up>
```

### 5. Index the batch

```sh
gctrl context list --tags "session:<session_id>,kind:observation" --format json
```

Emit the full list on stdout so the caller can confirm what was written.

## Output contract

```json
{
  "session_id": "<id>",
  "entity": "<entity_id>",
  "aspect": "<aspect>",
  "written": [
    { "path": "...", "title": "...", "claim": "...", "confidence": 0.9 }
  ],
  "rejected": [
    { "candidate": "...", "reason": "ephemeral" }
  ]
}
```

## Failure modes

| Case | Behaviour |
|---|---|
| Session not found | Exit 2 with error on stderr. |
| No target entity resolvable | Exit 3 with prompt asking the caller to supply `entity`. |
| Zero memorizable facts | Exit 0 with empty `written`, populated `rejected` — this is a normal outcome. |
| Duplicate of existing observation | Skip and note as `rejected.reason = "duplicate"` with link to the existing entry. |

## Future — entity graph migration

When `entity_observations` ships:

- Replace the `gctrl context add` calls with `POST /api/memory/observations`.
- `supersedes` becomes a real foreign-key revision pointer, not a frontmatter string.
- Pair with a `consolidate` deriver that rolls recent observations into `entity_representations`.

The SKILL.md contract (inputs, output JSON shape, rejection rationale) stays the same — only the persistence call changes.
