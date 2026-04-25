# ADR: Session is the spine; Activity is a view-mode

**Status**: accepted
**Scope**: gctrl-analytics, gctrl-board, future observability surfaces
**Drives**: `specs/architecture/apps/gctrl-analytics.md`

## Context

`gctrl-analytics` exposes six tabs (Overview, Sessions, Prompts, Evals, Usage, Contributions) plus three view-modes on Sessions (List, Timeline, Heatmap). An earlier draft considered Activity (timeline / heatmap) as a top-level tab beside Sessions. Operators consistently asked "what ran?" and "what happened in this session?" — the same question at different zoom levels.

There is also a longer-term temptation: as new observability needs land (LLM-as-judge runs, eval harnesses, scheduler dispatches), each could grow a new top-level entity with its own tab and its own drill-through paths. That direction multiplies surfaces and breaks the operator's mental model.

## Decision

Across `gctrl-analytics` and any future observability application:

1. **Session is the canonical spine.** Every observable unit of work — agent runs, scheduler dispatches, eval runs, ad-hoc OTLP-ingested processes — is a `Session`. New entities don't get a new top-level tab; they extend the Session shape (new `created_by` value, new span types, new linked artifacts).
2. **Activity is a view-mode on Sessions, not a parallel tab.** List / Timeline / Heatmap are three renderings of the same query against the same store. They share filters, share pagination, share streaming.
3. **Drill paths are one-directional toward Session.** Contribution → PR → Session → Prompt → Span → Eval. Nothing drills into a parallel entity that bypasses Session.

## Consequences

**Good**

- One mental model. Operators learn Session once and read every other surface as a slice of it.
- One streaming contract. The SSE channel is `session.*`; no parallel "activity stream" or "eval stream" to maintain.
- Cheap new tabs. Adding a tab is "what question does this answer about Sessions?" not "what new pipeline do I need to build?"

**Cost**

- Forbids parallel top-level entities even when they look natural in isolation. Eval rule and prompt template are conceptual entities (not Sessions), and they get tabs (Evals, Prompts) — but every row drills back to a Session, never sideways into another rule/template detail page that lives outside Session context.
- `Session` schema must stay general enough to host heterogenous workloads. We accept this by keeping `Session` thin (id, agent_name, started_at/ended_at, status, totals) and pushing kind-specific data onto spans, scores, tags, contribution links.

## Non-decisions

- This ADR does **not** decide whether to add `Session.created_by` (handled in `gctrl-analytics.md` Kernel Dependencies §1).
- Does **not** decide the chart library (deferred to M1 implementation).
- Does **not** prescribe SSE wire format (handled in `gctrl-analytics.md` Kernel Dependencies §5).

## Trigger to revisit

- Operators ask "what's the entity?" and consistently answer something other than Session.
- A tab cannot honestly drill back to Session (e.g. Activity that doesn't belong to any session — would force a parallel spine).
- Three or more drill-throughs land on a non-Session pane.

If two of the three trigger, revisit the spine assumption explicitly rather than letting parallel entities accrete.
