---
name: triage
description: Triage a batch of new or unlabeled gctrl board / GitHub issues — suggest priority, labels, assignee persona, and blockers. Use when new issues accumulate or at the start of a planning cycle.
allowed-tools: Bash(gctrl board:*) Bash(gctrl gh:*) Bash(gctrl context:*) Read Grep
metadata:
  owner: gctrl-core
  stability: alpha
  scope: project
---

# /triage

Produce a triage report for untriaged issues. For each issue, propose priority, labels, persona assignment, and any prerequisite work that should block dispatch. Never mutates issues — outputs a plan the human or a follow-up skill can apply.

## When to use

- New issues have accumulated on the board or in GitHub.
- Start of a planning cycle (sprint, release).
- After a bulk import from Linear / Notion (once drivers land).

## Inputs

Optional arguments (as natural-language prompt context):

- `scope` — `board` (default), `gh`, or `both`
- `project` — board project slug or GitHub repo; defaults to current repo
- `since` — ISO date or relative (`7d`, `24h`); defaults to `7d`
- `limit` — max issues to triage; defaults to `20`

## Procedure

### 1. Collect untriaged issues

```sh
# Board — unlabeled or in "inbox" status
gctrl board issues list --project <project> --status inbox --limit <limit> --format json

# GitHub — no labels, no assignee
gctrl gh issues list --repo <repo> --no-label --state open --limit <limit> --format json
```

Dedupe by title similarity; surface potential duplicates for the human to resolve separately (out of scope for this skill).

### 2. Load persona catalog

```sh
gctrl context show specs/team/personas.md --format json
```

Extract each persona's `review_focus` tags and `tools` allowlist. These become the matching surface.

### 3. For each issue, derive:

- **Priority** — high / medium / low, based on:
  - explicit `priority:*` labels
  - keywords in title/body (`regression`, `outage`, `blocker`, `security`)
  - linked PR/commit references (hot-path files)
- **Labels** — area (`app:board`, `kernel:storage`, `docs:specs`, ...), kind (`bug`, `feature`, `chore`, `spike`), and any compliance tags (`security`, `a11y`)
- **Persona** — intersection of issue labels × persona `review_focus`. If no clean match, mark `persona: needs-human-pick`.
- **Blockers** — scan issue body and linked issues for phrases like `blocked by`, `depends on`, `after X merges`. List as `blocked_by: [<ids>]`.

### 4. Emit the report

Write a structured plan to stdout:

```json
{
  "generated_at": "<ISO-8601>",
  "scope": "<board|gh|both>",
  "items": [
    {
      "id": "BOARD-42",
      "title": "...",
      "suggested": {
        "priority": "high",
        "labels": ["kernel:storage", "bug"],
        "persona": "engineer",
        "blocked_by": ["BOARD-40"],
        "rationale": "Mentions 'D1 sync failure' (see kernel:sync); depends on BOARD-40 schema fix."
      },
      "confidence": 0.82
    }
  ]
}
```

### 5. Hand off

Do NOT apply changes. The caller (human or a follow-up `/apply-triage` skill) decides which suggestions to accept and runs the corresponding `gctrl board issues edit` / `gctrl gh issue edit` commands. This is intentional — triage is advisory.

## Output contract

- Exit cleanly with a single JSON document on stdout.
- Put reasoning, rejected candidates, and warnings on stderr.
- Each `rationale` string ≤ 200 chars; if a suggestion can't be supported, set `confidence` ≤ 0.5 and explain.

## Failure modes

| Case | Behaviour |
|---|---|
| No untriaged issues found | Exit 0 with `"items": []`. |
| Persona catalog missing | Warn on stderr, emit suggestions without `persona`. |
| `gctrl gh` unavailable (driver off / no auth) | Skip `gh` scope, note on stderr, continue with board. |

## Future

Once the entity graph lands, extend with:

- Cross-reference existing `entity_observations` about the issue's target area for precedent/context.
- Score persona match against historical session success rate per `(persona, label_set)`.
